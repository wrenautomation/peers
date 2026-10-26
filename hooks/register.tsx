import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Peer } from '../types'
import { HINT, scan } from '../lib/guard.mjs'
import { delta, merge } from '../lib/lines.mjs'

// One checkout, many sessions. Every session keeps its own ledger file:
//   ~/.claude/peers/<encodeURIComponent(repo root)>/<session id>.json
// The mod writes it from tool calls. `mine` (bin/mine.mjs) reads it for
// status, diff, commit, check, claim and close. Nothing here spends a model
// token unless a peer touched the exact file the model is about to use.

// added/removed: the distinctive lines this session's edits put in or took out (lib/lines.mjs).
type Entry = { first: number; last: number; added?: string[]; removed?: string[] }
type Delta = { added: string[]; removed: string[] }
type Commit = { sha: string; at: number; files: string[] }
type Ledger = {
  v: 1
  session: string
  root: string
  ticket?: string
  started: number
  updated: number
  ended?: number
  files: Record<string, Entry>
  commits: Commit[]
}

const LIVE_MS = 12 * 60 * 60 * 1000
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
const SNAPSHOT_MAX = 512 * 1024
const ABS_PATH = /(?:^|[\s='"])(\/[^\s'"`;|&>]+)/g

const peersAtom = atom({ plugin: 'peers', key: 'peers' } as const, [] as Peer[])

const nameOf = (l: { session: string; ticket?: string }) => l.ticket ?? `s-${l.session.slice(0, 4)}`

const ago = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

let home = ''
let session = ''
let cwdRoot: string | null = null
const rootByDir = new Map<string, string | null>()
const roots = new Set<string>()
const seen = new Map<string, number>() // abs path -> when this session last read it
const told = new Map<string, number>() // abs path -> peer `last` we already reported
const text = new Map<string, { mtime: number; body: string }>() // abs path -> content at mtime, for Bash deltas

const ledgerDir = (root: string) => `${home}/.claude/peers/${encodeURIComponent(root)}`
const ownPath = (root: string) => `${ledgerDir(root)}/${session}.json`

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

const rootOf = async ($: any, dir: string): Promise<string | null> => {
  const hit = rootByDir.get(dir)
  if (hit !== undefined) return hit
  let root: string | null = null
  try {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
    root = r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    root = null
  }
  rootByDir.set(dir, root)
  if (root) roots.add(root)
  return root
}

const absolute = async ($: any, p: string) => (p.startsWith('/') ? p : `${await $.session.cwd()}/${p}`)

const readJson = async ($: any, path: string): Promise<Ledger | null> => {
  try {
    return JSON.parse(await $.fs.read(path)) as Ledger
  } catch {
    return null
  }
}

const loadMine = async ($: any, root: string): Promise<Ledger> => {
  const now = await $.clock.now()
  return (
    (await readJson($, ownPath(root))) ?? {
      v: 1,
      session,
      root,
      started: now,
      updated: now,
      files: {},
      commits: [],
    }
  )
}

const saveMine = async ($: any, l: Ledger) => {
  l.updated = await $.clock.now()
  await $.fs.write(ownPath(l.root), JSON.stringify(l))
}

const record = async ($: any, root: string, rels: string[], deltas = new Map<string, Delta>()) => {
  if (rels.length === 0) return
  const l = await loadMine($, root)
  const now = await $.clock.now()
  for (const rel of rels) {
    const e = (l.files[rel] ??= { first: now, last: now })
    e.last = now
    const d = deltas.get(rel)
    if (d) {
      e.added = merge(e.added, d.added)
      e.removed = merge(e.removed, d.removed)
    }
  }
  await saveMine($, l)
}

// A peer's edits to rel that no commit of theirs has taken yet.
const uncommitted = (p: Ledger, rel: string) => {
  const e = p.files[rel]
  return !!e && !p.commits.some(c => c.at >= e.last && c.files.includes(rel))
}

const readText = async ($: any, abs: string): Promise<string | null> => {
  try {
    return await $.fs.read(abs)
  } catch {
    return null
  }
}

const headText = async ($: any, root: string, rel: string) => {
  try {
    const r = await $.process.run(['git', '-C', root, 'show', `HEAD:${rel}`], { timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}

// Peer lines (uncommitted) among the lines an edit takes out of rel.
const peerLinesLost = (peers: Ledger[], rel: string, removed: string[]) => {
  const gone = new Set(removed)
  const out: { peer: Ledger; lines: string[] }[] = []
  for (const p of peers) {
    if (!uncommitted(p, rel)) continue
    const lines = (p.files[rel]?.added ?? []).filter(k => gone.has(k))
    if (lines.length) out.push({ peer: p, lines })
  }
  return out
}

const quote = (lines: string[]) =>
  lines
    .slice(0, 3)
    .map(x => `\`${x.trim().slice(0, 80)}\``)
    .join(', ') + (lines.length > 3 ? ` and ${lines.length - 3} more` : '')

const peersOf = async ($: any, root: string): Promise<Ledger[]> => {
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(ledgerDir(root))
  } catch {
    return []
  }
  const now = await $.clock.now()
  const out: Ledger[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || e.name === `${session}.json`) continue
    const l = await readJson($, `${ledgerDir(root)}/${e.name}`)
    if (!l || l.ended || now - l.updated > LIVE_MS) continue
    out.push(l)
  }
  return out
}

// One line, only when a peer touched this file after we last read it.
const peerLine = async ($: any, abs: string, forEdit: boolean): Promise<string | null> => {
  const root = await rootOf($, dirOf(abs))
  if (!root || !abs.startsWith(root + '/')) return null
  const rel = abs.slice(root.length + 1)
  const since = Math.max(seen.get(abs) ?? 0, told.get(abs) ?? 0)
  const lines: string[] = []
  let newest = 0
  const now = await $.clock.now()
  for (const p of await peersOf($, root)) {
    const e = p.files[rel]
    if (!e || e.last <= since) continue
    newest = Math.max(newest, e.last)
    const commit = p.commits.find(c => c.at >= e.last && c.files.includes(rel))
    const state = commit ? `committed ${commit.sha.slice(0, 7)}` : 'uncommitted'
    lines.push(`${nameOf(p)} edited it ${ago(now - e.last)} ago (${state})`)
  }
  if (lines.length === 0) return null
  const tail = forEdit ? ' Re-read before you edit. Keep their lines.' : ' Their lines are not yours: leave them.'
  return `peers: ${lines.join('; ')}.${tail}`
}

// Attach the line to the result, errors included (an Edit refused for a stale
// read is the usual case), and only then remember that it was told.
const withContext = (abs: string, r: any, line: string | null) => {
  if (!line || !r || r.deny !== undefined) return r
  if (abs) told.set(abs, Date.now())
  return { ...r, context: [...(r.context ?? []), line] }
}

const refreshPeers = async ($: any) => {
  const all = new Set<string>(roots)
  if (cwdRoot) all.add(cwdRoot)
  const list: Peer[] = []
  for (const root of all) {
    const mine = await loadMine($, root)
    const tag = all.size > 1 ? `${root.slice(root.lastIndexOf('/') + 1)}:` : ''
    for (const p of await peersOf($, root)) {
      const files = Object.keys(p.files)
      const shared = files.filter(f => mine.files[f]).length
      const last = files.reduce((m, f) => Math.max(m, p.files[f]?.last ?? 0), p.updated)
      list.push({ session: p.session, name: tag + nameOf(p), ticket: p.ticket, files: files.length, shared, last })
    }
  }
  list.sort((a, b) => b.last - a.last)
  const cur = await read($, peersAtom)
  if (JSON.stringify(cur) !== JSON.stringify(list)) await update($, peersAtom, () => list)
}

// Dirty files in a repo with their mtimes: the Bash snapshot. Their content is
// cached by mtime, so a Bash edit can be split into lines added and removed.
const dirty = async ($: any, root: string): Promise<Map<string, number>> => {
  const m = new Map<string, number>()
  try {
    const r = await $.process.run(['git', '-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'], {
      timeoutMs: 10000,
    })
    if (r.exitCode !== 0) return m
    for (const row of r.stdout.split('\0')) {
      if (row.length < 4) continue
      const rel = row.slice(3)
      const abs = `${root}/${rel}`
      let mtime = 0
      try {
        const st = await $.fs.stat(abs)
        mtime = st.mtimeMs
        if (st.kind === 'file' && st.size <= SNAPSHOT_MAX && text.get(abs)?.mtime !== mtime) {
          const body = await readText($, abs)
          if (body !== null) text.set(abs, { mtime, body })
        }
      } catch {}
      m.set(rel, mtime)
    }
  } catch {}
  return m
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    session = await $.session.id()
    cwdRoot = await rootOf($, e.cwd)
    if (cwdRoot) {
      const l = await loadMine($, cwdRoot)
      await saveMine($, l)
    }
    // `mine` on PATH: the one install step beyond /plugin install.
    try {
      await $.process.run(['mkdir', '-p', `${home}/.local/bin`], { timeoutMs: 5000 })
      await $.process.run(['ln', '-sfn', `${$.plugin.root}/bin/mine.mjs`, `${home}/.local/bin/mine`], { timeoutMs: 5000 })
    } catch {}
    $.clock.every(3000, () => refreshPeers($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    for (const root of roots) {
      const l = await readJson($, ownPath(root))
      if (l) {
        l.ended = await $.clock.now()
        await saveMine($, l)
      }
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return {
      sections: [
        ...r.sections,
        {
          id: 'peers:rules',
          scope: 'session' as const,
          text:
            'Peers: other Claude sessions edit this same checkout. Changes in files you did not touch are theirs: never mention, revert, stage or commit them. ' +
            'Your files: `mine status`, `mine diff`, `mine commit -m "..."`, `mine check`. Next task: `mine ready`. Bind one with `mine claim <id>`; `mine close -r "..."` closes it. Do not edit task status by hand.',
        },
      ],
    }
  })

  for (const tool of EDIT_TOOLS) {
    on('tool.call', { tool: tool as 'Edit' }, async ($, e: any, next) => {
      const abs = await absolute($, e.file_path ?? e.notebook_path ?? '')
      const root = abs ? await rootOf($, dirOf(abs)) : null
      const rel = root && abs.startsWith(root + '/') ? abs.slice(root.length + 1) : null
      let d: Delta | null = null
      if (tool === 'Edit') d = delta(e.old_string ?? '', e.new_string ?? '')
      if (tool === 'Write') d = delta((await readText($, abs)) ?? '', e.content ?? '')

      // A Write replaces the whole file: it must not drop a peer's uncommitted lines.
      let lost: { peer: Ledger; lines: string[] }[] = []
      if (root && rel && d) {
        const peers = await peersOf($, root)
        lost = peerLinesLost(peers, rel, d.removed)
        if (tool === 'Write') {
          const blind = peers.filter(p => uncommitted(p, rel) && !p.files[rel]?.added)
          if (lost.length || blind.length) {
            const who = [...lost.map(x => `${nameOf(x.peer)} (${quote(x.lines)})`), ...blind.map(nameOf)]
            return {
              deny: `peers: this Write drops uncommitted lines of ${who.join(', ')} in ${rel}. Re-read the file and change only your part with Edit.`,
            }
          }
        }
      }

      const line = abs ? await peerLine($, abs, true) : null
      const r: any = await next(e)
      if (rel && root && r && r.deny === undefined && !r.isError) {
        await record($, root, [rel], d ? new Map([[rel, d]]) : undefined)
        seen.set(abs, await $.clock.now())
      }
      const warn = lost.length
        ? `peers: this edit removed uncommitted lines of ${lost.map(x => `${nameOf(x.peer)} (${quote(x.lines)})`).join(', ')}. Put them back unless you agreed this with them.`
        : null
      return withContext(abs, withContext('', r, warn), line)
    }).catch(($, e, next) => next(e))
  }

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const abs = await absolute($, e.file_path)
    const line = await peerLine($, abs, false)
    const r: any = await next(e)
    if (r && r.deny === undefined && !r.isError) seen.set(abs, await $.clock.now())
    return withContext(abs, r, line)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    // Roots this command may touch: the session's, every edited file's, any absolute path in it.
    const cmdRoots = new Set<string>(roots)
    if (cwdRoot) cmdRoots.add(cwdRoot)
    let n = 0
    for (const m of cmd.matchAll(ABS_PATH)) {
      if (n++ >= 3) break
      const p = (m[1] ?? '').replace(/\/$/, '')
      const r = (await rootOf($, p)) ?? (await rootOf($, dirOf(p)))
      if (r) cmdRoots.add(r)
    }

    const before = new Map<string, Map<string, number>>()
    for (const root of cmdRoots) before.set(root, await dirty($, root))
    const peerDirty = new Map<string, { rel: string; peer: Ledger }[]>()
    for (const [root, was] of before) {
      const list: { rel: string; peer: Ledger }[] = []
      for (const p of await peersOf($, root)) for (const rel of Object.keys(p.files)) if (was.has(rel) && uncommitted(p, rel)) list.push({ rel, peer: p })
      peerDirty.set(root, list)
    }

    // Guard: staging, discards, branch switches and formatters that reach a peer's uncommitted files.
    const cwd = await $.session.cwd()
    for (const hit of scan(cmd)) {
      const resolve = (p: string, from: string) => (p.startsWith('/') ? p : `${from}/${p}`).replace(/\/(\.\/?)?$/, '').replace(/\/\.\//g, '/')
      const base = resolve(hit.dir ?? '.', hit.cwd ? resolve(hit.cwd, cwd) : cwd)
      let targets: string[] | null = hit.targets
      // `git checkout X` with no `--`: a branch unless X is a path.
      if (hit.branchy) {
        try {
          await $.fs.stat(resolve(hit.branchy, base))
        } catch {
          targets = null
        }
      }
      // A `$VAR` in the directory hides which repo it is: count every repo, whole.
      const blind = /[$`]|__q__/.test(`${hit.dir ?? ''}${hit.cwd ?? ''}`)
      if (blind) targets = null
      for (const [root, list] of peerDirty) {
        if (hit.dir && !blind && !(base === root || base.startsWith(root + '/'))) continue
        const rels = targets?.map(t => resolve(t, base)).map(a => (a === root ? '' : a.startsWith(root + '/') ? a.slice(root.length + 1) : null))
        const hits = list.filter(({ rel }) => !rels || rels.some(t => t !== null && (t === '' || rel === t || rel.startsWith(t + '/'))))
        if (hits.length) {
          const files = [...new Set(hits.map(x => `${x.rel} (${nameOf(x.peer)})`))]
          return { deny: `peers: this command reaches uncommitted peer files in ${root}: ${files.join(', ')}. ${HINT[hit.rule as keyof typeof HINT]}` }
        }
      }
    }

    const r: any = await next(e)
    if (!r || r.deny !== undefined || r.isReadOnly) return r

    const hitPeers: string[] = []
    for (const [root, was] of before) {
      const now = await dirty($, root)
      const touched: string[] = []
      for (const [rel, mtime] of now) {
        const old = was.get(rel)
        if (old === undefined || old !== mtime) touched.push(rel)
      }
      for (const rel of was.keys()) if (!now.has(rel)) touched.push(rel) // deleted, or reverted to HEAD
      if (!touched.length) continue
      const deltas = new Map<string, Delta>()
      for (const rel of touched) {
        const abs = `${root}/${rel}`
        const cached = text.get(abs)
        const old = was.has(rel) ? (cached && cached.mtime === was.get(rel) ? cached.body : null) : await headText($, root, rel)
        const cur = now.has(rel) ? ((await readText($, abs)) ?? '') : await headText($, root, rel)
        if (old !== null) deltas.set(rel, delta(old, cur))
      }
      await record($, root, touched, deltas)
      const theirs = new Set(touched)
      for (const { rel, peer } of peerDirty.get(root) ?? []) if (theirs.has(rel)) hitPeers.push(`${rel} (${nameOf(peer)})`)
    }
    // `mine claim` and `mine close` change the ticket in the ledger; refresh the band.
    if (/\bmine (claim|close)\b/.test(cmd)) await refreshPeers($)
    const warn = hitPeers.length
      ? `peers: this command changed uncommitted peer files: ${[...new Set(hitPeers)].join(', ')}. Check them with git diff and put back any of their lines it broke.`
      : null
    return withContext('', r, warn)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const peers = await read($, peersAtom)
    if (e.props.hasSurvey || peers.length === 0) return next(e)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const parts = peers.map(
      p => `${p.name} ${p.files} file${p.files === 1 ? '' : 's'}${p.shared ? ` (${p.shared} shared)` : ''} ${ago(now - p.last)}`,
    )
    const shared = peers.some(p => p.shared > 0)
    return (
      <Box>
        <Text dimColor>peers · </Text>
        <Text dimColor={!shared} color={shared ? 'yellow' : undefined}>
          {parts.join(' · ')}
        </Text>
      </Box>
    )
  })
}
