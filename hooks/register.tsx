import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Peer } from '../types'

// One checkout, many sessions. Every session keeps its own ledger file:
//   ~/.claude/peers/<encodeURIComponent(repo root)>/<session id>.json
// The mod writes it from tool calls. `mine` (bin/mine.mjs) reads it for
// status, diff, commit, check, claim and close. Nothing here spends a model
// token unless a peer touched the exact file the model is about to use.

type Entry = { first: number; last: number }
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
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'] as const
// Only at a command position: git in prose (a heredoc, a commit message) does not count.
const BULK_GIT = /(?:^|[;&|(]\s*|&&\s*|\|\|\s*)git\s+(?:-C\s+\S+\s+)?[^|;&]*?\b(add\s+(-A|--all|\.|:\/)|commit\s+(-a\b|--all\b|-am\b))/m
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

const record = async ($: any, root: string, rels: string[]) => {
  if (rels.length === 0) return
  const l = await loadMine($, root)
  const now = await $.clock.now()
  for (const rel of rels) {
    const e = l.files[rel]
    if (e) e.last = now
    else l.files[rel] = { first: now, last: now }
  }
  await saveMine($, l)
}

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
  told.set(abs, Date.now())
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
      const last = files.reduce((m, f) => Math.max(m, p.files[f].last), p.updated)
      list.push({ session: p.session, name: tag + nameOf(p), ticket: p.ticket, files: files.length, shared, last })
    }
  }
  list.sort((a, b) => b.last - a.last)
  const cur = await read($, peersAtom)
  if (JSON.stringify(cur) !== JSON.stringify(list)) await update($, peersAtom, () => list)
}

// Dirty files in a repo with their mtimes: the Bash snapshot.
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
      let mtime = 0
      try {
        mtime = (await $.fs.stat(`${root}/${rel}`)).mtimeMs
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
    on('tool.call', { tool }, async ($, e: any, next) => {
      const abs = await absolute($, e.file_path ?? e.notebook_path ?? '')
      const line = abs ? await peerLine($, abs, true) : null
      const r: any = await next(e)
      if (abs && r && r.deny === undefined && !r.isError) {
        const root = await rootOf($, dirOf(abs))
        if (root && abs.startsWith(root + '/')) await record($, root, [abs.slice(root.length + 1)])
        seen.set(abs, await $.clock.now())
      }
      return withContext(abs, r, line)
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
      const p = m[1].replace(/\/$/, '')
      const r = (await rootOf($, p)) ?? (await rootOf($, dirOf(p)))
      if (r) cmdRoots.add(r)
    }

    const before = new Map<string, Map<string, number>>()
    for (const root of cmdRoots) before.set(root, await dirty($, root))

    // Guard: whole-tree staging would commit a peer's half-typed files.
    if (BULK_GIT.test(cmd)) {
      for (const [root, was] of before) {
        const theirs: string[] = []
        for (const p of await peersOf($, root)) for (const f of Object.keys(p.files)) if (was.has(f)) theirs.push(`${f} (${nameOf(p)})`)
        if (theirs.length) {
          return {
            deny: `peers: uncommitted peer files in ${root}: ${theirs.join(', ')}. Use \`mine commit -m "..."\` (your files only) or \`git add -- <your files>\`.`,
          }
        }
      }
    }

    const r: any = await next(e)
    if (!r || r.deny !== undefined || r.isReadOnly) return r

    for (const [root, was] of before) {
      const now = await dirty($, root)
      const touched: string[] = []
      for (const [rel, mtime] of now) {
        const old = was.get(rel)
        if (old === undefined || old !== mtime) touched.push(rel)
      }
      if (touched.length) await record($, root, touched)
    }
    // `mine claim` and `mine close` change the ticket in the ledger; refresh the band.
    if (/\bmine (claim|close)\b/.test(cmd)) await refreshPeers($)
    return r
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
