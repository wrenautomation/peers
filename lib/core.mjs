// The ledger and the edit capture, shared by every agent: the Claude Code mod (hooks/register.tsx)
// and `peers hook <agent>` (lib/hook.mjs) for Codex, Cursor and the rest.
// It does no I/O of its own. `io` gives it the files, git and the clock:
//   read(path) → text (throws), write(path, text) (makes the folder), list(dir) → [{ name, kind }],
//   stat(path) → { mtimeMs, kind, size } (throws), run(argv, { timeoutMs }) → { exitCode, stdout },
//   now() → ms.
// Ledger: <home>/.claude/peers/<encodeURIComponent(repo root)>/<session>.json.
import { HINT, scan } from './guard.mjs'
import { delta, merge, statusPaths, unclaimed, yields } from './lines.mjs'
import { isAbs, slash, winOf } from './path.mjs'

export const LIVE_MS = 12 * 60 * 60 * 1000
// A ledger counts as a peer once it holds work: a file, a commit or a task. An empty one is a run that
// started and stopped (a headless `claude -p`, a subagent host) and names no work: it shows nowhere.
export const holds = l => Object.keys(l?.files ?? {}).length > 0 || (l?.commits ?? []).length > 0 || !!l?.ticket
// Claude Code's list of running sessions: ~/.claude/sessions/<pid>.json, each with its sessionId. A session
// can write its ledger after its end (a late hook), so `ended` alone lets a closed session come back.
// null when the list is missing or names no session (an engine without it): then the end mark decides.
export const SESSIONS = home => `${home}/.claude/sessions`
// A terminal that moved its work to a background job (parkedJobId) counts as gone: the job runs on under its own id.
export const runningOf = texts => {
  const ids = new Set()
  let any = false
  for (const t of texts)
    try {
      const d = JSON.parse(t)
      if (typeof d?.sessionId !== 'string') continue
      any = true
      if (!d.parkedJobId) ids.add(d.sessionId)
    } catch {}
  return any ? ids : null
}
// The names the person gave running sessions (/rename): the running list has them, no transcript read.
export const namesOf = texts => {
  const names = new Map()
  for (const t of texts)
    try {
      const d = JSON.parse(t)
      if (typeof d?.sessionId === 'string' && d.nameSource === 'user' && d.name) names.set(d.sessionId, d.name)
    } catch {}
  return names
}
// The list holds Claude sessions only: a Codex or Cursor ledger (agent set, id prefixed) keeps the end mark.
const listed = l => !l.agent || l.agent === 'claude'
export const isLive = (l, now, running) =>
  holds(l) && now - l.updated < LIVE_MS && (running && listed(l) ? running.has(l.session) : !(l.ended && l.updated - l.ended < 5000))
export const SNAPSHOT_MAX = 512 * 1024
// mtime and clock skew a command's window allows.
export const SLACK_MS = 2000
const EDITS_MAX = 20
const ABS_PATH = /(?:^|[\s='"])((?:[A-Za-z]:[\\/]|\/)[^\s'"`;|&>]+)/g

// The session's short id, `cc-2724` (`codex-…`, `cursor-…`): the one name that never changes.
export const idOf = l => `${l.agent && l.agent !== 'claude' ? l.agent : 'cc'}-${l.session.replace(/^[a-z]+_/, '').slice(0, 4)}`
export const nameOf = l => l.ticket ?? idOf(l)

export const dirOf = p => p.slice(0, p.lastIndexOf('/')) || '/'

// A command's text names rel: its repo path, or its file name as a whole word (`wren.c4`, not `c4`).
export const names = (cmd, rel) => {
  if (!cmd) return false
  if (cmd.includes(rel)) return true
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (base.length < 4) return false
  const at = cmd.split(/[\s'"`=;|&>()]+/).map(w => w.slice(w.lastIndexOf('/') + 1))
  return at.includes(base)
}


// A peer's edits to rel that no commit of theirs has taken yet.
export const uncommitted = (p, rel) => {
  const e = p.files[rel]
  return !!e && !p.commits.some(c => c.at >= e.last && c.files.includes(rel))
}

// A peer still holds rel: uncommitted, and its lines are in rel's diff from HEAD (live: delta(HEAD, now)).
// A commit by any route (git commit, push.sh) puts the lines in HEAD: then it holds nothing. No line data: holds while dirty.
export const holding = (p, rel, live) => {
  if (!uncommitted(p, rel)) return false
  if (!live) return true
  if (!live.added.length && !live.removed.length) return false
  const e = p.files[rel]
  if (!e.added?.length && !e.removed?.length) return true
  const a = new Set(live.added)
  const r = new Set(live.removed)
  return (e.added ?? []).some(k => a.has(k)) || (e.removed ?? []).some(k => r.has(k))
}

// Peer lines (uncommitted, not in HEAD) among the lines an edit takes out of rel.
export const peerLinesLost = (peers, rel, removed, live) => {
  const gone = new Set(removed)
  if (live) for (const k of [...gone]) if (!live.added.includes(k)) gone.delete(k)
  const out = []
  for (const p of peers) {
    if (!holding(p, rel, live)) continue
    const lines = (p.files[rel]?.added ?? []).filter(k => gone.has(k))
    if (lines.length) out.push({ peer: p, lines })
  }
  return out
}

export const quote = lines =>
  lines
    .slice(0, 3)
    .map(x => `\`${x.trim().slice(0, 80)}\``)
    .join(', ') + (lines.length > 3 ? ` and ${lines.length - 3} more` : '')

// me: { home, session, agent, backlog }; backlog is the Backlog.md folder (BACKLOG_CWD), for task titles. The caches last for the session; each call binds them to its own io
// (a mod's `$` lasts one dispatch): `const c = core(me)`, then `c(io).record(...)`.
// Two ledger entries for one file (rename): span of both, lines of both, the newer action's from and named.
export const joinEntry = (a, b) => {
  if (!a) return b
  const [old, cur] = a.last >= b.last ? [b, a] : [a, b]
  return {
    ...old,
    ...cur,
    first: Math.min(a.first, b.first),
    added: merge(old.added, cur.added),
    removed: merge(old.removed, cur.removed),
    edits: [...(old.edits ?? []), ...(cur.edits ?? [])].slice(-EDITS_MAX),
  }
}

export const core = me => {
  const win = winOf(me.home)
  me = { ...me, win, home: slash(me.home, win), backlog: slash(me.backlog, win) }
  const rootByDir = new Map()
  const roots = new Set() // every repo this session touched
  const text = new Map() // abs path -> content at mtime, so a command's edit splits into lines
  const said = { tasks: { at: 0, map: new Map() }, found: new Map(), titles: new Map() }
  const parsed = new Map() // ledger path -> { mtime, size, l }: a peer's ledger is parsed again only after it changes
  const status = new Map() // root -> { key, at, set }: git status again only after the index, HEAD or a ledger moved
  const lives = new Map() // root\0rel -> { key, v }: liveKeys again only after the file, the index or HEAD moved
  return io => api(io, me, { rootByDir, roots, text, said, parsed, status, lives })
}

// The transcript's own titles: the name the person gave the session, else the one Claude Code made.
// perl, not grep: macOS grep takes 0.8 s on a 60 MB transcript, perl 0.04 s. It prints the last of each kind.
const TITLE_PL = 'while (/"(custom|ai)Title":"(?:[^"\\\\]|\\\\.)*"/g) { $t{$1} = $& } END { print "$t{custom}\\n$t{ai}\\n" }'
export const titlesOfScan = out => {
  const got = { customTitle: null, aiTitle: null }
  for (const line of out.split('\n').filter(Boolean))
    try {
      Object.assign(got, JSON.parse(`{${line}}`))
    } catch {}
  return { custom: got.customTitle || null, ai: got.aiTitle || null }
}
export const titleOfScan = out => {
  const t = titlesOfScan(out)
  return t.custom || t.ai
}
const TITLE_MS = 20_000
const STATUS_MS = 30_000

const api = (io, me, { rootByDir, roots, text, said, parsed, status, lives }) => {

  const ledgerDir = root => `${me.home}/.claude/peers/${encodeURIComponent(root)}`
  const ownPath = root => `${ledgerDir(root)}/${me.session}.json`
  const readText = async p => {
    try {
      return await io.read(p)
    } catch {
      return null
    }
  }
  const readJson = async p => {
    const t = await readText(p)
    try {
      return t === null ? null : JSON.parse(t)
    } catch {
      return null
    }
  }
  const git = async (root, args, timeoutMs = 5000) => {
    try {
      // No optional locks: a read never takes index.lock from a peer's commit or a release script.
      return await io.run(['git', '--no-optional-locks', '-C', root, ...args], { timeoutMs })
    } catch {
      return { exitCode: 1, stdout: '' }
    }
  }

  const rootOf = async dir => {
    dir = slash(dir, me.win)
    const hit = rootByDir.get(dir)
    if (hit !== undefined) return hit
    const r = await git(dir, ['rev-parse', '--show-toplevel'])
    if (r.exitCode === 0) {
      const root = slash(r.stdout.trim(), me.win)
      rootByDir.set(dir, root)
      roots.add(root)
      return root
    }
    // A folder a Write is about to make does not exist yet: its parent says the repo. Never keep that miss,
    // or every later edit in the new folder goes unrecorded (WA-933).
    if (await io.stat(dir).then(() => false, () => true)) {
      const up = dirOf(dir)
      return up !== dir && up.includes('/') ? rootOf(up) : null
    }
    rootByDir.set(dir, null)
    return null
  }
  // The repo and repo-relative path of an absolute path, or null outside a repo.
  const locate = async abs => {
    abs = slash(abs, me.win)
    const root = abs ? await rootOf(dirOf(abs)) : null
    return root && abs.startsWith(root + '/') ? { root, rel: abs.slice(root.length + 1) } : null
  }

  const loadMine = async root => {
    const now = await io.now()
    return (await readJson(ownPath(root))) ?? { v: 1, session: me.session, agent: me.agent, root, started: now, updated: now, files: {}, commits: [] }
  }
  const saveMine = async l => {
    delete l.ended
    l.updated = await io.now()
    await io.write(ownPath(l.root), JSON.stringify(l))
  }

  // rels changed by one action that began at `from`; deltas: rel -> { added, removed }.
  // named: the rels the action named (a tool edit names its file; a command, the paths in its text).
  const record = async (root, rels, deltas = new Map(), title = '', from, named = new Set(rels)) => {
    if (rels.length === 0) return
    const l = await loadMine(root)
    const now = await io.now()
    for (const rel of rels) {
      const e = (l.files[rel] ??= { first: now, last: now })
      e.from = from ?? now
      e.last = now
      e.named = named.has(rel)
      const d = deltas.get(rel)
      if (d) {
        e.added = merge(e.added, d.added)
        e.removed = merge(e.removed, d.removed)
        const k = [...d.added, ...d.removed].slice(0, 4)
        if (title && k.length) e.edits = [...(e.edits ?? []), { at: now, t: title, k }].slice(-EDITS_MAX)
      }
    }
    await saveMine(l)
  }

  // The session ended: its ledgers stop counting as live.
  const end = async (list = roots) => {
    for (const root of list) {
      const l = await readJson(ownPath(root))
      if (!l) continue
      l.ended = l.updated = await io.now()
      await io.write(ownPath(root), JSON.stringify(l)) // not saveMine: it clears ended
    }
  }

  // New id, same process (/resume): old id's ledgers merge into the new id's; old ones left empty, ended.
  const rename = async id => {
    const old = me.session
    if (!id || id === old) return
    me.session = id
    const top = `${me.home}/.claude/peers`
    for (const d of await io.list(top).catch(() => [])) {
      const path = `${top}/${d.name}/${old}.json`
      const was = await readJson(path)
      if (!holds(was)) continue
      const l = await loadMine(was.root)
      for (const [rel, e] of Object.entries(was.files)) l.files[rel] = joinEntry(l.files[rel], e)
      l.commits = [...(was.commits ?? []), ...l.commits].sort((a, b) => a.at - b.at)
      for (const [k, v] of Object.entries(was)) if (!(k in l) && k !== 'ended') l[k] = v
      l.started = Math.min(l.started, was.started)
      await saveMine(l)
      const now = await io.now()
      await io.write(path, JSON.stringify({ ...was, files: {}, commits: [], ticket: undefined, into: id, ended: now, updated: now }))
    }
  }

  const runningNow = async () => {
    try {
      const files = (await io.list(SESSIONS(me.home))).filter(e => e.kind === 'file' && e.name.endsWith('.json'))
      const texts = await Promise.all(files.map(e => io.read(`${SESSIONS(me.home)}/${e.name}`).catch(() => '')))
      said.names = { at: await io.now(), map: namesOf(texts) }
      return runningOf(texts)
    } catch {
      return null
    }
  }

  // Read only: callers never change a peer's ledger, so the parsed object is shared.
  const readLedger = async p => {
    const st = await io.stat(p).catch(() => null)
    const hit = parsed.get(p)
    if (st && hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.l
    const l = await readJson(p)
    if (st && l) parsed.set(p, { mtime: st.mtimeMs, size: st.size, l })
    return l
  }

  const peersOf = async root => {
    let entries
    try {
      entries = await io.list(ledgerDir(root))
    } catch {
      return []
    }
    const now = await io.now()
    const running = await runningNow()
    const out = []
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.json') || e.name === `${me.session}.json`) continue
      const l = await readLedger(`${ledgerDir(root)}/${e.name}`)
      if (!isLive(l, now, running)) continue
      out.push(l)
    }
    return out
  }

  const headText = async (root, rel) => {
    const r = await git(root, ['show', `HEAD:${rel}`])
    return r.exitCode === 0 ? r.stdout : ''
  }
  // rel's lines that differ from HEAD now: what any session can still hold there.
  const liveKeys = async (root, rel) => delta(await headText(root, rel), (await readText(`${root}/${rel}`)) ?? '')
  // liveKeys for the band's 2 s tick: a git show only after the file, the index or HEAD moved.
  const liveNow = async (root, rel) => {
    const st = async p => (await io.stat(p).catch(() => null)) ?? {}
    const [f, i, h] = await Promise.all([st(`${root}/${rel}`), st(`${root}/.git/index`), st(`${root}/.git/HEAD`)])
    const key = `${f.mtimeMs}:${f.size}:${i.mtimeMs}:${h.mtimeMs}`
    const hit = lives.get(`${root}\0${rel}`)
    if (hit?.key === key) return hit.v
    const v = await liveKeys(root, rel)
    lives.set(`${root}\0${rel}`, { key, v })
    return v
  }
  // A peer's open files: dirty and still held (lines not in HEAD), as the guard counts them.
  const heldFiles = async (root, p, open) => {
    const out = []
    for (const f of Object.keys(p.files)) if (open.has(f) && uncommitted(p, f) && holding(p, f, await liveNow(root, f))) out.push(f)
    return out
  }

  // Dirty paths in a repo, no stat: what the band and the pane count as open.
  // `sig` names the ledgers' state: a session's edit lands in its ledger, a commit or a revert in the index or HEAD.
  // A change no ledger records (an editor's save) shows within STATUS_MS.
  const openFiles = async (root, sig) => {
    const now = await io.now()
    const at = async p => (await io.stat(`${root}/.git/${p}`).catch(() => null))?.mtimeMs ?? 0
    const keyNow = async () => `${await at('index')}:${await at('HEAD')}:${sig}`
    if (sig !== undefined) {
      const hit = status.get(root)
      if (hit && now - hit.at < STATUS_MS && hit.key === (await keyNow())) return hit.set
    }
    const r = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], 10000)
    const set = new Set(r.exitCode === 0 ? statusPaths(r.stdout) : [])
    // After the run: git status itself may rewrite the index.
    if (sig !== undefined && r.exitCode === 0) status.set(root, { key: await keyNow(), at: now, set })
    return set
  }

  // Dirty files in a repo with their mtimes. Their content is cached by mtime.
  const dirty = async root => {
    const m = new Map()
    const r = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], 10000)
    if (r.exitCode !== 0) return m
    for (const rel of statusPaths(r.stdout)) m.set(rel, await cache(`${root}/${rel}`))
    return m
  }
  const cache = async abs => {
    try {
      const st = await io.stat(abs)
      if (st.kind === 'file' && st.size <= SNAPSHOT_MAX && text.get(abs)?.mtime !== st.mtimeMs) {
        const body = await readText(abs)
        if (body !== null) text.set(abs, { mtime: st.mtimeMs, body })
      }
      return st.mtimeMs
    } catch {
      return 0
    }
  }

  // The repos a command may touch: the session's, the cwd's, and any absolute path in it.
  const commandRoots = async (cmd, cwd) => {
    const out = new Set(roots)
    const r = cwd ? await rootOf(cwd) : null
    if (r) out.add(r)
    let n = 0
    for (const m of (cmd ?? '').matchAll(ABS_PATH)) {
      if (n++ >= 3) break
      const p = slash(m[1] ?? '', me.win).replace(/\/$/, '')
      const pr = (await rootOf(p)) ?? (await rootOf(dirOf(p)))
      if (pr) out.add(pr)
    }
    return [...out]
  }

  // Before an action: each repo's dirty files (and `files`, named absolute paths) with mtime and body.
  // Plain JSON, so a hook process can keep it on disk until the action ends.
  const before = async (list, files = []) => {
    const snap = { at: await io.now(), roots: {} }
    for (const root of list) {
      const entry = {}
      for (const [rel, mtime] of await dirty(root)) entry[rel] = [mtime, text.get(`${root}/${rel}`)?.mtime === mtime ? text.get(`${root}/${rel}`).body : null]
      snap.roots[root] = entry
    }
    for (const abs of files) {
      const at = await locate(abs)
      if (!at) continue
      const entry = (snap.roots[at.root] ??= {})
      if (entry[at.rel]) continue
      const mtime = await cache(abs)
      entry[at.rel] = [mtime, mtime ? (text.get(abs)?.mtime === mtime ? text.get(abs).body : null) : '', 1]
    }
    // Peers' uncommitted files that were dirty before it: the guard's targets and the warning's names.
    snap.peer = {}
    for (const [root, was] of Object.entries(snap.roots)) {
      const list = []
      const live = new Map()
      for (const p of await peersOf(root))
        for (const rel of Object.keys(p.files)) {
          if (!was[rel] || !uncommitted(p, rel)) continue
          if (!live.has(rel)) live.set(rel, await liveKeys(root, rel))
          if (holding(p, rel, live.get(rel))) list.push([rel, nameOf(p)])
        }
      snap.peer[root] = list
    }
    return snap
  }

  // Staging, discards, branch switches and formatters that reach a peer's uncommitted files: the deny text, or null.
  const guard = async (cmd, cwd, snap) => {
    const hits0 = scan(cmd)
    if (!hits0.length) return null
    const resolve = (p, from) =>
      ((p = slash(p, me.win)), isAbs(p) ? p : p === '~' || p.startsWith('~/') ? me.home + p.slice(1) : `${from}/${p}`).replace(/\/(\.\/?)?$/, '').replace(/\/\.\//g, '/')
    for (const hit of hits0) {
      const base = resolve(hit.dir ?? '.', hit.cwd ? resolve(hit.cwd, slash(cwd, me.win)) : slash(cwd, me.win))
      let targets = hit.targets
      // `git checkout X` with no `--`: a branch unless X is a path.
      if (hit.branchy) {
        try {
          await io.stat(resolve(hit.branchy, base))
        } catch {
          targets = null
        }
      }
      // A `$VAR` in the directory hides which repo it is: count every repo, whole.
      const blind = /[$`]|__q__/.test(`${hit.dir ?? ''}${hit.cwd ?? ''}`)
      if (blind) targets = null
      for (const [root, list] of Object.entries(snap.peer)) {
        // Whole-tree ops reach the repo they run in (or every repo below it); named paths say where they land.
        if (!blind && targets === null && !(base === root || base.startsWith(root + '/') || root.startsWith(base + '/'))) continue
        const rels = targets?.map(t => resolve(t, base)).map(a => (a === root ? '' : a.startsWith(root + '/') ? a.slice(root.length + 1) : null))
        const hits = list.filter(([rel]) => !rels || rels.some(t => t !== null && (t === '' || rel === t || rel.startsWith(t + '/'))))
        if (hits.length) {
          const files = [...new Set(hits.map(([rel, name]) => `${rel} (${name})`))]
          return `peers: blocked, nothing in this command ran. It reaches uncommitted peer files in ${root}: ${files.join(', ')}. ${HINT[hit.rule]} See whose hunks are whose: peers diff --who <file>.`
        }
      }
    }
    return null
  }

  // After an action: record the files it changed, as lines added and removed.
  // Returns the peer files it changed, as "rel (name)", for a warning.
  const after = async (snap, title = '') => {
    const t0 = snap.at
    const hitPeers = []
    for (const [root, was] of Object.entries(snap.roots)) {
      const now = await dirty(root)
      // A named file still clean after the action: compare its mtime too.
      for (const [rel, w] of Object.entries(was)) if (w[2] && !now.has(rel)) now.set(rel, await cache(`${root}/${rel}`))
      const t1 = await io.now()
      const peersNow = await peersOf(root)
      let touched = []
      for (const [rel, mtime] of now) {
        const old = was[rel]?.[0]
        if (old !== undefined && old === mtime) continue
        // Newly dirty but not written while it ran: HEAD or the index moved (reset, amend, restore --staged).
        if (old === undefined && mtime > 0 && mtime < t0 - SLACK_MS) continue
        // A peer's action spans the change and named the file, or spans it tighter: theirs, even inside our window.
        if (mtime > 0 && yields(rel, mtime, { from: t0, to: t1, named: names(snap.cmd, rel) }, peersNow)) continue
        touched.push(rel)
      }
      // A file that left the dirty list was committed or reverted, not edited. A deleted
      // tracked file stays dirty (mtime 0), so the loop above has it.
      if (!touched.length) continue
      const deltas = new Map()
      for (const rel of touched) {
        const abs = `${root}/${rel}`
        const old = was[rel] ? was[rel][1] : await headText(root, rel)
        const cur = now.get(rel) ? ((await readText(abs)) ?? '') : was[rel]?.[2] ? '' : await headText(root, rel)
        if (old !== null) deltas.set(rel, delta(old, cur))
      }
      // A long command (tests, a push) runs while peers edit: a file a peer recorded since it
      // started keeps only the lines that are not the peer's, and is not ours if none are left.
      // A file the command names stays ours whole.
      const during = peersNow.filter(p => p.updated >= t0)
      touched = touched.filter(rel => {
        if (!during.length || names(snap.cmd, rel)) return true
        const kept = unclaimed(deltas.get(rel), during, rel, t0)
        if (kept && deltas.has(rel)) deltas.set(rel, kept)
        return kept !== null
      })
      if (!touched.length) continue
      await record(root, touched, deltas, title, t0, new Set(touched.filter(rel => names(snap.cmd, rel))))
      // Warn only of a peer file the command named, or one no peer wrote while it ran: a peer that wrote it
      // meanwhile most likely made the change itself (WA-932 item 6).
      const theirs = new Set(touched)
      const busy = rel => during.some(p => (p.files[rel]?.last ?? 0) >= t0)
      for (const [rel, name] of snap.peer[root] ?? []) if (theirs.has(rel) && (names(snap.cmd, rel) || !busy(rel))) hitPeers.push(`${rel} (${name})`)
    }
    return [...new Set(hitPeers)]
  }

  // A whole-file write must not drop a peer's uncommitted lines: the deny text, or null.
  const writeDeny = async (root, rel, d, peers) => {
    peers ??= await peersOf(root)
    const live = await liveKeys(root, rel)
    const lost = peerLinesLost(peers, rel, d.removed, live)
    const blind = peers.filter(p => holding(p, rel, live) && !p.files[rel]?.added)
    if (!lost.length && !blind.length) return null
    const who = [...lost.map(x => `${nameOf(x.peer)} (${quote(x.lines)})`), ...blind.map(nameOf)]
    return `peers: this Write drops uncommitted lines of ${who.join(', ')} in ${rel}. Re-read the file and change only your part with Edit.`
  }

  // What a session is on: its task's title, else its Claude Code transcript's title; null when neither is known.
  // Task names come from the ledger (`peers claim` keeps the board's title), else Backlog.md file names (open and archived), "<id> - <title>.md". Each lookup reruns at most every 20 s.
  const sessionTitle = async l => {
    const now = await io.now()
    if (l.ticket) {
      // The board's title, kept at claim (any board); else a Backlog.md file name.
      if (l.title) return l.title
      if (now - said.tasks.at > TITLE_MS && me.backlog) {
        said.tasks.at = now
        try {
          const names = []
          for (const d of ['tasks', 'archive/tasks']) names.push(...(await io.list(`${me.backlog}/backlog/${d}`).catch(() => [])).map(e => e.name))
          said.tasks.map = new Map(
            names
              .map(n => /^(\S+) - (.+)\.md$/.exec(n))
              .filter(Boolean)
              .map(m => [m[1].toLowerCase(), m[2].replace(/-/g, ' ')]),
          )
        } catch {}
      }
      return said.tasks.map.get(l.ticket.toLowerCase()) ?? null
    }
    const t = await scanned(l)
    return (await sessionLabel(l)) || t.ai
  }
  // The title under the name: the task's title, else Claude Code's own title of the session.
  const sessionAbout = async l => (l.ticket ? sessionTitle(l) : (await scanned(l)).ai)
  // The name the person gave the session (/rename), or null: short, so the views show it as the session's name.
  // The running list first: a transcript can be 200 MB, past what one read or one scan in time can take.
  const sessionLabel = async l => {
    if (!said.names || (await io.now()) - said.names.at > TITLE_MS) await runningNow()
    return said.names?.map.get(l.session) ?? (await scanned(l)).custom
  }

  // perl when there is one (Windows has none on PATH): else the last of each kind found from the end in JS.
  const titleLines = async path => {
    if (!said.noPerl)
      try {
        const r = await io.run(['perl', '-ne', TITLE_PL, path], { timeoutMs: 15000 })
        if (r.exitCode === 0) return r.stdout
        return null
      } catch (e) {
        // Only a missing perl turns it off: a slow scan of a cold 200 MB transcript is not that.
        if (!/ENOENT|not found|no such/i.test(String(e?.message ?? e))) return null
      }
    said.noPerl = true
    const t = await io.read(path).catch(() => '')
    return ['custom', 'ai'].map(k => /^"\w+":"(?:[^"\\]|\\.)*"/.exec(t.slice(t.lastIndexOf(`"${k}Title":"`)))?.[0] ?? '').join('\n')
  }
  const scanned = async l => {
    if (/^[a-z]+_/.test(l.session)) return { custom: null, ai: null } // codex_, cursor_: no Claude Code transcript
    const now = await io.now()
    const t = said.titles.get(l.session)
    if (t && now - t.at < TITLE_MS) return t.got
    let path = said.found.get(l.session)
    if (!path) {
      const dir = `${me.home}/.claude/projects`
      for (const d of await io.list(dir).catch(() => []))
        if (d.kind === 'dir' && (await io.stat(`${dir}/${d.name}/${l.session}.jsonl`).catch(() => null))) path = `${dir}/${d.name}/${l.session}.jsonl`
      if (path) said.found.set(l.session, path)
    }
    const out = path ? await titleLines(path) : ''
    // A failed scan keeps the last titles it found.
    const got = out === null ? (t?.got ?? { custom: null, ai: null }) : titlesOfScan(out)
    said.titles.set(l.session, { at: now, got })
    return got
  }

  return { sessionTitle, sessionLabel, sessionAbout, roots, ledgerDir, ownPath, readJson, readText, liveKeys, liveNow, heldFiles, rootOf, locate, loadMine, saveMine, record, end, rename, peersOf, openFiles, headText, commandRoots, before, guard, after, writeDeny }
}
