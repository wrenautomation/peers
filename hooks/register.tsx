import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren, RenderElement } from 'claude-code'
import type { Peer, Row, Span, ViewBody, ViewFocus, ViewFold, ViewIndex } from '../types'
import { core, dirOf, nameOf, peerLinesLost, quote, uncommitted } from '../lib/core.mjs'
import { delta } from '../lib/lines.mjs'
import { ADD, DEL, ago, cast, fit, colorRule, docRow, fileHead, hunkHead, listRows, onlyQuery, terms } from '../lib/rows.mjs'

// One checkout, many sessions. Every session keeps its own ledger file:
//   ~/.claude/peers/<encodeURIComponent(repo root)>/<session id>.json
// The mod writes it from tool calls, through lib/core.mjs (the same code `peers hook` runs for other agents). `peers` (bin/peers.mjs) reads it for
// status, diff, commit, check, claim and close. Nothing here spends a model
// token unless a peer touched the exact file the model is about to use.

// added/removed: the distinctive lines this session's edits put in or took out (lib/lines.mjs).
// edits: each titled edit, newest last; k holds a few of its line keys, so a hunk finds its title.
type Edit = { at: number; t: string; k: string[] }
// from/last: when the latest action that recorded it began and ended (lib/lines.mjs yields).
type Entry = { first: number; from?: number; last: number; added?: string[]; removed?: string[]; edits?: Edit[] }
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

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const
const peersAtom = atom({ plugin: 'peers', key: 'peers' } as const, [] as Peer[])
// The band: one compact line, or with [+] a row per peer.
const wideAtom = atom({ plugin: 'peers', key: 'wide' } as const, false)
// The element each site's focus ring is on, by requestId.
const onlyAtom = atom({ plugin: 'peers', key: 'only' } as const, [] as string[])
const ringAtom = atom({ plugin: 'peers', key: 'ring' } as const, {} as Record<string, string>)

// The engine's focus inverts a Button; mixed and dim colors invert to a gray bar.
// One theme blue under the ring inverts to a blue bar, as Claude Code's own.
const lit = (n: RenderChildren): RenderChildren => {
  if (Array.isArray(n)) return n.map(lit)
  if (!n || typeof n !== 'object' || (n as RenderElement).type !== 'Text') return n
  const el = n as any
  const { backgroundColor: _, dimColor: __, ...props } = el.props ?? {}
  return { ...el, props: { ...props, color: 'suggestion' }, children: lit(el.children) }
}
const ringed = (Text: any, on: boolean, children: RenderChildren) => (on ? <Text color="suggestion">{lit(children)}</Text> : children)

let home = ''
let session = ''
let cwdRoot: string | null = null
const seen = new Map<string, number>() // abs path -> when this session last read it
const told = new Map<string, number>() // abs path -> peer `last` we already reported
const text = new Map<string, { mtime: number; body: string }>() // abs path -> content at mtime, for Bash deltas
const said = new Map<string, string>() // tool_use_id -> the line the model wrote before that call

// The ledger and capture (lib/core.mjs), bound per call: `$` lasts one dispatch.
let c: any = null
const k = ($: any) =>
  c({
    read: (p: string) => $.fs.read(p),
    write: (p: string, t: string) => $.fs.write(p, t),
    list: (d: string) => $.fs.list(d),
    stat: (p: string) => $.fs.stat(p),
    run: (argv: string[], o: { timeoutMs: number }) => $.process.run(argv, o),
    now: () => $.clock.now(),
  })

// An edit's title: the first sentence of what the model said before it, as plain text.
const titleOf = (raw: string) => {
  const line = raw.split('\n').map(x => x.trim()).filter(Boolean).pop() ?? ''
  const plain = line.replace(/[*_`#>]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
  const first = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain
  return first.replace(/[:.]\s*$/, '').slice(0, 120).trim()
}

const absolute = async ($: any, p: string) => (p.startsWith('/') ? p : `${await $.session.cwd()}/${p}`)

// One line, only when a peer touched this file after we last read it.
const peerLine = async ($: any, abs: string, forEdit: boolean): Promise<string | null> => {
  const root = await k($).rootOf(dirOf(abs))
  if (!root || !abs.startsWith(root + '/')) return null
  const rel = abs.slice(root.length + 1)
  const since = Math.max(seen.get(abs) ?? 0, told.get(abs) ?? 0)
  const lines: string[] = []
  let newest = 0
  const now = await $.clock.now()
  for (const p of (await k($).peersOf(root)) as Ledger[]) {
    const e = p.files[rel]
    if (!e || e.last <= since) continue
    newest = Math.max(newest, e.last)
    const commit = p.commits.find(c => c.at >= e.last && c.files.includes(rel))
    const state = commit ? `committed ${commit.sha.slice(0, 7)}` : 'uncommitted'
    // What they said the edits do: the titles peers records with each edit.
    const said = [...new Set((e.edits ?? []).filter(x => x.at > since && x.t).map(x => x.t))].slice(-3)
    lines.push(`${nameOf(p)} edited it ${ago(now - e.last)} ago (${state})${said.length ? `: ${said.map(t => `"${t}"`).join(', ')}` : ''}`)
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

let mineStarted: { id: string; started: number }[] = []

const refreshPeers = async ($: any) => {
  const all = new Set<string>(k($).roots)
  if (cwdRoot) all.add(cwdRoot)
  const list: Peer[] = []
  const me: typeof mineStarted = []
  for (const root of all) {
    const mine: Ledger = await k($).loadMine(root)
    if (Object.keys(mine.files).length) me.push({ id: session, started: mine.started })
    const open = await k($).openFiles(root)
    const tag = all.size > 1 ? `${root.slice(root.lastIndexOf('/') + 1)}:` : ''
    for (const p of (await k($).peersOf(root)) as Ledger[]) {
      // Open files only, as the pane lists them: dirty in git and not taken by their own commit since.
      const files = Object.keys(p.files).filter(f => open.has(f) && uncommitted(p, f))
      const sharedFiles = files.filter(f => mine.files[f])
      const shared = sharedFiles.length
      const doing = files.flatMap(f => p.files[f]?.edits ?? []).reduce<{ at: number; t: string } | null>((m, x) => (!m || x.at > m.at ? x : m), null)?.t
      const last = files.reduce((m, f) => Math.max(m, p.files[f]?.last ?? 0), p.updated)
      // The distinct lines their edits put in and took out: near the diff's counts, no git read.
      const adds = files.reduce((n, f) => n + (p.files[f]?.added?.length ?? 0), 0)
      const dels = files.reduce((n, f) => n + (p.files[f]?.removed?.length ?? 0), 0)
      const title = await k($).sessionTitle(p)
      list.push({ session: p.session, name: tag + nameOf(p), ticket: p.ticket, title, files: files.length, shared, last, started: p.started, adds, dels, doing, sharedFiles })
    }
  }
  list.sort((a, b) => b.last - a.last)
  mineStarted = me
  const cur = await read($, peersAtom)
  if (JSON.stringify(cur) !== JSON.stringify(list)) await update($, peersAtom, () => list)
}

// The /peers pane: the `peers view` server's file list and documents, in the terminal.
// The server builds one state for every reader (the page, each session's pane); the pane polls it.
const PANE = 'peers'
const VIEW = 'http://127.0.0.1:6421'
const SHARED = '#a594f9'
const MAX_LINES = 600

const indexAtom = atom({ plugin: 'peers', key: 'index' } as const, { sig: '', repos: [] } as ViewIndex, { shape: 'index-2' })
const foldAtom = atom({ plugin: 'peers', key: 'fold' } as const, { zoom: 2, flip: [] } as ViewFold, { shape: 'fold-1' })
const focusAtom = atom({ plugin: 'peers', key: 'focus' } as const, null as ViewFocus, { shape: 'focus-1' })
const bodyAtom = atom({ plugin: 'peers', key: 'body' } as const, null as ViewBody, { shape: 'body-1' })
let tick: { cancel: () => void } | null = null
let spawned = false

// undefined: unchanged (204); null: not found.
const getJson = async ($: any, path: string) => {
  const r = await $.http.fetch(`${VIEW}${path}`)
  return r.status === 204 ? undefined : r.ok ? JSON.parse(r.text) : null
}

const loadBody = async ($: any) => {
  const f = await read($, focusAtom)
  if (!f) return
  const ix = await read($, indexAtom)
  const file = ix.repos.find(r => r.root === f.root)?.files.find(x => x.rel === f.rel)
  const mtime = file?.mtime ?? 0
  const b = await read($, bodyAtom)
  if (b && b.root === f.root && b.rel === f.rel && b.mode === f.mode && b.mtime === mtime) return
  if (!file) return void (await update($, bodyAtom, () => ({ ...f, mtime })))
  const q = `?root=${encodeURIComponent(f.root)}&rel=${encodeURIComponent(f.rel)}`
  if (f.mode === 'doc') {
    const d = await getJson($, `/api/doc${q}`)
    await update($, bodyAtom, () => ({ ...f, mtime, lines: d?.lines ?? [] }))
  } else {
    const h = await getJson($, `/api/hunks${q}`)
    await update($, bodyAtom, () => ({ ...f, mtime, hunks: h ?? [] }))
  }
}

const poll = async ($: any) => {
  const cur = await read($, indexAtom)
  try {
    const ix = await getJson($, `/api/index?sig=${cur.sig}${onlyQuery(await read($, onlyAtom))}`)
    if (ix) await update($, indexAtom, () => ix)
    else if (cur.error) await update($, indexAtom, v => ({ ...v, error: undefined }))
    await loadBody($)
  } catch {
    // No server: launchd keeps one up; else start it once, as `peers view` would.
    if (!spawned) {
      spawned = true
      try {
        await $.process.run(['node', `${$.plugin.root}/bin/peers.mjs`, 'view', '--no-open'], { timeoutMs: 10000 })
      } catch {}
    }
    if (!cur.error) await update($, indexAtom, v => ({ ...v, error: `No peers view server on ${VIEW}.` }))
  }
}

// One peer from the band: the pane on the file list, that session's group open, the ring on it.
const openPeer = async ($: any, id: string) => {
  await openPane($)
  await update($, focusAtom, () => null)
  const ids = (await read($, indexAtom)).repos.filter(r => r.sessions.some(s => s.id === id)).map(r => `s:${r.root}:${id}`)
  if (!ids.length) return
  await update($, foldAtom, v => ({ ...v, flip: v.zoom >= 2 ? v.flip.filter(x => !ids.includes(x)) : [...new Set([...v.flip, ...ids])] }))
  await $.ui.focus({ requestId: PANE, key: ids[0] }).catch(() => {})
}

const openPane = async ($: any) => {
  // A view the person calls up and dismisses, as the agents view: it takes the keys, Escape closes it.
  // Open before any await: a press counts as the person's ask only while its handler runs.
  const opened = await $.ui.open({ id: PANE, title: 'Peers', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) $.ui.toast(`Peers: ${opened.reason}`)
  if (!tick) tick = $.clock.every(2000, () => void poll($).catch(() => {}))
  await poll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) ?? ''
    session = await $.session.id()
    c = core({ home, session, backlog: (await $.env.get('BACKLOG_CWD')) ?? '' })
    cwdRoot = await k($).rootOf(e.cwd)
    if (cwdRoot) await k($).saveMine(await k($).loadMine(cwdRoot))
    // A reload runs session.end, then session.start: this session's ledgers are live again.
    try {
      for (const d of await $.fs.list(`${home}/.claude/peers`)) {
        const path = `${home}/.claude/peers/${d.name}/${session}.json`
        const l = await k($).readJson(path)
        if (l?.ended) await k($).saveMine(l)
      }
    } catch {}
    // `peers` on PATH: the one install step beyond /plugin install.
    try {
      await $.process.run(['mkdir', '-p', `${home}/.local/bin`], { timeoutMs: 5000 })
      await $.process.run(['ln', '-sfn', `${$.plugin.root}/bin/peers.mjs`, `${home}/.local/bin/peers`], { timeoutMs: 5000 })
    } catch {}
    // Fill the band now: a resumed session shows its peers before the first tick or turn.
    void refreshPeers($).catch(() => {})
    $.clock.every(3000, () => refreshPeers($))
    // immediate: it opens mid-turn, never queued behind the running turn.
    await $.command.register({ name: 'peers-view', description: "Open or close the live view of every session's edits", immediate: true })
    return next(e)
  })

  // A toggle with no transcript line: run again, it closes. `/peers-view wren ./lander` opens it on those repos only,
  // or sets that filter on the open pane; a bare open clears the filter.
  on('command.run', { command: 'peers-view' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const shown = (await $.ui.panes()).some(p => p.id === PANE)
    if (shown && !words.length) await $.ui.close({ id: PANE })
    else {
      const only = words.length ? terms(words, await $.session.cwd(), home) : []
      await update($, onlyAtom, () => only)
      // A new filter: the next poll must answer whole, not 204.
      await update($, indexAtom, v => ({ ...v, sig: '' }))
      if (shown) await poll($)
      else await openPane($)
    }
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      tick?.cancel()
      tick = null
    }
    return next(e)
  })

  // Keep where each of our sites' focus ring is, so the drawing can light that row.
  on('ui.focus', async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && (e.component === 'AbovePrompt' || e.requestId === PANE))
      await update($, ringAtom, m => ({ ...m, [e.requestId]: e.element ?? '' }))
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const ix = await read($, indexAtom)
    const focus = await read($, focusAtom)
    const now = await $.clock.now()
    const fold = await read($, foldAtom)
    const ring = e.props.isFocused ? (await read($, ringAtom))[PANE] : undefined
    // One color and name per session, the same rule as the page and `peers tui` (lib/rows.mjs).
    const { col, nameOf } = cast(ix)
    const spans = (sp: Span[]) =>
      sp.map(x => (
        <Text color={x.color} backgroundColor={x.bg} bold={x.bold} dimColor={x.dim} strikethrough={x.strike} underline={x.under}>
          {x.s}
        </Text>
      ))
    const show = (f: ViewFocus) => async () => {
      await update($, focusAtom, () => f)
      await loadBody($)
    }

    if (!focus) {
      const flip = (id: string) => async () =>
        void (await update($, foldAtom, v => ({ ...v, flip: v.flip.includes(id) ? v.flip.filter(x => x !== id) : [...v.flip.slice(-200), id] })))
      const zoom = (z: 1 | 2 | 3) => async () => void (await update($, foldAtom, () => ({ zoom: z, flip: [] })))
      return (
        <Box flexDirection="column">
          <Box gap={2}>
            {([1, 2, 3] as const).map(z => (
              <Button key={`zoom${z}`} plain hotkey={String(z)} dimColor={fold.zoom !== z} onPress={zoom(z)}>
                {['sessions', 'files', 'changes'][z - 1]!}
              </Button>
            ))}
            <Text dimColor>↑↓ move · enter opens · ctrl+x ← wider · esc closes</Text>
          </Box>
          <Text> </Text>
          {(listRows(ix, fold, now, e.props.bodyColumns - 1) as Row[]).map(r =>
            r.press ? (
              <Button key={r.key} plain onPress={'fold' in r.press ? flip(r.press.fold) : show(r.press.open)}>
                {ringed(Text, ring === r.key, spans(r.spans))}
              </Button>
            ) : (
              <Text key={r.key}>{r.spans.length ? spans(r.spans) : ' '}</Text>
            ),
          )}
        </Box>
      )
    }

    const head = fileHead(ix, focus)
    const body = await read($, bodyAtom)
    const ready = body && body.root === focus.root && body.rel === focus.rel && body.mode === focus.mode
    const rows: RenderChildren[] = []
    if (!head.file) rows.push(<Text>Committed or reverted: nothing uncommitted in this file now.</Text>)
    else if (!ready) rows.push(<Text dimColor>Loading…</Text>)
    else if (focus.mode === 'doc') for (const x of body.lines ?? []) rows.push(<Text>{spans(docRow(x, col))}</Text>)
    else {
      // Claude Code's own diff: its gutters, highlighter and add/remove colors. The owner's title heads each hunk.
      let room = 90000
      for (const hunk of body.hunks ?? []) {
        const olds = hunk.lines.filter(x => x.t !== '+').length
        const news = hunk.lines.filter(x => x.t !== '-').length
        const source = `@@ -${hunk.old},${olds} +${hunk.new},${news} @@\n${hunk.lines.map(x => x.t + x.s).join('\n')}`
        if (source.length > room) break
        room -= source.length
        rows.push(<Text>{spans(hunkHead(hunk, col, nameOf))}</Text>, <Code format="diff" path={focus.rel} source={source} />)
      }
      if (!rows.length) rows.push(<Text>No text diff (binary, empty or mode only).</Text>)
    }
    const more = rows.length - MAX_LINES
    return (
      <Box flexDirection="column">
        <Box gap={2}>
          <Button plain hotkey="b" onPress={show(null)}>back</Button>
          <Button plain hotkey="d" dimColor={focus.mode !== 'doc'} onPress={show({ ...focus, mode: 'doc' })}>document</Button>
          <Button plain hotkey="f" dimColor={focus.mode !== 'diff'} onPress={show({ ...focus, mode: 'diff' })}>diff</Button>
        </Box>
        <Text>{spans(head.spans)}</Text>
        <Text> </Text>
        {rows.slice(0, MAX_LINES)}
        {more > 0 && <Text>{`${more} more lines: open \`peers view\` for the whole file.`}</Text>}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    await k($).end()
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
            'Your files: `peers status`, `peers diff`, `peers commit -m "..."`, `peers check`. Next task: `peers ready`. Bind one with `peers claim <id>`; `peers close -r "..."` closes it. Do not edit task status by hand. ' +
            'Before a group of edits, say in one line what they do, like a commit subject: peers shows it as their title.',
        },
      ],
    }
  })

  for (const tool of EDIT_TOOLS) {
    on('tool.call', { tool: tool as 'Edit' }, async ($, e: any, next) => {
      const abs = await absolute($, e.file_path ?? e.notebook_path ?? '')
      const at = await k($).locate(abs)
      const root: string | null = at?.root ?? null
      const rel: string | null = at?.rel ?? null
      let d: Delta | null = null
      if (tool === 'Edit') d = delta(e.old_string ?? '', e.new_string ?? '')
      if (tool === 'Write') d = delta((await k($).readText(abs)) ?? '', e.content ?? '')

      // A Write replaces the whole file: it must not drop a peer's uncommitted lines.
      let lost: { peer: Ledger; lines: string[] }[] = []
      if (root && rel && d) {
        const peers = await k($).peersOf(root)
        if (tool === 'Write') {
          const deny = await k($).writeDeny(root, rel, d, peers)
          if (deny) return { deny }
        }
        lost = peerLinesLost(peers, rel, d.removed)
      }

      const line = abs ? await peerLine($, abs, true) : null
      const r: any = await next(e)
      if (rel && root && r && r.deny === undefined && !r.isError) {
        const t = titleOf(said.get(e.tool_use_id ?? '') ?? '')
        said.delete(e.tool_use_id ?? '')
        await k($).record(root, [rel], d ? new Map([[rel, d]]) : undefined, t)
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
    const cwd = await $.session.cwd()
    const list: string[] = await k($).commandRoots(cmd, cwd)
    if (cwdRoot && !list.includes(cwdRoot)) list.push(cwdRoot)
    const snap = await k($).before(list)
    const deny = await k($).guard(cmd, cwd, snap)
    if (deny) return { deny }

    snap.at = await $.clock.now()
    const r: any = await next(e)
    if (!r || r.deny !== undefined || r.isReadOnly) return r
    const hitPeers: string[] = await k($).after(snap, titleOf(e.description ?? '') || titleOf(said.get(e.tool_use_id ?? '') ?? ''))
    // `peers claim` and `peers close` change the ticket in the ledger; refresh the band.
    said.delete(e.tool_use_id ?? '')
    if (/\b(mine|peers) (claim|close)\b/.test(cmd)) await refreshPeers($)
    const warn = hitPeers.length
      ? `peers: this command changed uncommitted peer files: ${hitPeers.join(', ')}. Check them with git diff and put back any of their lines it broke.`
      : null
    return withContext('', r, warn)
  }).catch(($, e, next) => next(e))

  // The text the model writes before a tool call titles that call's edits. Every chunk passes on unchanged.
  on('turn.step', async function* ($, e, next) {
    const it = next(e)
    let text = ''
    for (;;) {
      const r = await it.next()
      if (r.done) return r.value
      const c: any = r.value
      if (c.kind === 'text') text += c.text
      else if (c.kind === 'tool' && text.trim()) {
        said.set(c.id, text)
        if (said.size > 200) said.delete(said.keys().next().value as string)
      }
      yield c
    }
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const peers = await read($, peersAtom)
    if (e.props.hasSurvey || peers.length === 0) return next(e)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    // Each peer's name in its pane color; the page's sessions decide it once the pane has read them.
    const ix = await read($, indexAtom)
    const col = colorRule(ix.repos.length ? ix.repos.flatMap(r => r.sessions) : [...mineStarted, ...peers.map(p => ({ id: p.session, started: p.started }))])
    const wide = await read($, wideAtom)
    const ring = (await read($, ringAtom))[e.requestId]
    const flip = () => void update($, wideAtom, w => !w)
    // nums as plain text, to measure the row; a peer's row (name, nums, title, what it last did) takes at most 2 rows.
    const numsText = (p: Peer) => ` ${p.files}|${p.shared}${p.adds ? ` +${p.adds}` : ''}${p.dels ? ` −${p.dels}` : ''} ${ago(now - p.last)}`
    const nums = (p: Peer) => (
      <Text>
        <Text>{` ${p.files}`}</Text>
        <Text dimColor>|</Text>
        <Text color={p.shared ? SHARED : undefined} dimColor={!p.shared}>{`${p.shared}`}</Text>
        {p.adds ? <Text color={ADD}>{` +${p.adds}`}</Text> : null}
        {p.dels ? <Text color={DEL}>{` −${p.dels}`}</Text> : null}
        <Text dimColor>{` ${ago(now - p.last)}`}</Text>
      </Text>
    )
    // Only the name is a Button: the pointer lights the name alone, not the counts or the title.
    const name = (p: Peer) => (
      <Button key={`peer:${p.session}`} plain onPress={() => openPeer($, p.session)}>
        {ringed(Text, ring === `peer:${p.session}`, <Text color={col(p.session)} bold>{p.name}</Text>)}
      </Button>
    )
    // Compact: name files|shared +N −N time per peer; name in the peer's color, +green −red, shared purple.
    // Peers wrap by whole peer in the room left of [+]; [+] sits flush right, beside the engine's [-].
    if (!wide)
      return (
        <Box flexDirection="row" width="100%" columnGap={2} paddingLeft={1}>
          <Box flexDirection="row" flexWrap="wrap" flexGrow={1} flexShrink={1} columnGap={3}>
            <Button key="peers-band" plain onPress={() => void openPane($)}>
              {ringed(Text, ring === 'peers-band', <Text dimColor>peers</Text>)}
            </Button>
            {peers.map(p => (
              <Box key={`c:${p.session}`} flexDirection="row">
                {name(p)}
                {nums(p)}
              </Box>
            ))}
          </Box>
          <Button key="peers-wide" plain dimColor onPress={flip}>[+]</Button>
        </Box>
      )
    // Verbose: a row per peer with what it last said it did, then the files we both changed.
    return (
      <Box flexDirection="column" width="100%" paddingLeft={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Button key="peers-band" plain onPress={() => void openPane($)}>
            {ringed(Text, ring === 'peers-band', <Text dimColor>{`peers · ${peers.length} sessions · files|shared`}</Text>)}
          </Button>
          <Button key="peers-wide" plain dimColor onPress={flip}>[−]</Button>
        </Box>
        {peers.map(p => (
          <Box key={`w:${p.session}`} flexDirection="column">
            <Box flexDirection="row">
              {name(p)}
              <Text>
                {nums(p)}
                {fit(
                  [
                    { s: numsText(p) },
                    p.title ? { s: `  ${p.title}`, cut: true } : null,
                    p.doing ? { s: `  ${p.doing}`, dim: true, cut: true } : null,
                  ].filter(Boolean) as Span[],
                  e.props.bodyColumns - 1 - p.name.length,
                )
                  .slice(1)
                  .map((x: Span) => (
                    <Text dimColor={x.dim}>{x.s}</Text>
                  ))}
              </Text>
            </Box>
            {p.sharedFiles?.length ? <Text color={SHARED}>{`  shared: ${p.sharedFiles.join(', ')}`}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}
