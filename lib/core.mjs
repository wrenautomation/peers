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


// A peer's edits to rel that no commit of theirs has taken yet.
export const uncommitted = (p, rel) => {
  const e = p.files[rel]
  return !!e && !p.commits.some(c => c.at >= e.last && c.files.includes(rel))
}

// Peer lines (uncommitted) among the lines an edit takes out of rel.
export const peerLinesLost = (peers, rel, removed) => {
  const gone = new Set(removed)
  const out = []
  for (const p of peers) {
    if (!uncommitted(p, rel)) continue
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
export const core = me => {
  const win = winOf(me.home)
  me = { ...me, win, home: slash(me.home, win), backlog: slash(me.backlog, win) }
  const rootByDir = new Map()
  const roots = new Set() // every repo this session touched
  const text = new Map() // abs path -> content at mtime, so a command's edit splits into lines
  const said = { tasks: { at: 0, map: new Map() }, found: new Map(), titles: new Map() }
  return io => api(io, me, { rootByDir, roots, text, said })
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

const api = (io, me, { rootByDir, roots, text, said }) => {

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
      return await io.run(['git', '-C', root, ...args], { timeoutMs })
    } catch {
      return { exitCode: 1, stdout: '' }
    }
  }

  const rootOf = async dir => {
    dir = slash(dir, me.win)
    const hit = rootByDir.get(dir)
    if (hit !== undefined) return hit
    const r = await git(dir, ['rev-parse', '--show-toplevel'])
    const root = r.exitCode === 0 ? slash(r.stdout.trim(), me.win) : null
    rootByDir.set(dir, root)
    if (root) roots.add(root)
    return root
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
  const record = async (root, rels, deltas = new Map(), title = '', from) => {
    if (rels.length === 0) return
    const l = await loadMine(root)
    const now = await io.now()
    for (const rel of rels) {
      const e = (l.files[rel] ??= { first: now, last: now })
      e.from = from ?? now
      e.last = now
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

  const runningNow = async () => {
    try {
      const names = (await io.list(SESSIONS(me.home))).filter(e => e.kind === 'file' && e.name.endsWith('.json'))
      return runningOf(await Promise.all(names.map(e => io.read(`${SESSIONS(me.home)}/${e.name}`).catch(() => ''))))
    } catch {
      return null
    }
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
      const l = await readJson(`${ledgerDir(root)}/${e.name}`)
      if (!isLive(l, now, running)) continue
      out.push(l)
    }
    return out
  }

  const headText = async (root, rel) => {
    const r = await git(root, ['show', `HEAD:${rel}`])
    return r.exitCode === 0 ? r.stdout : ''
  }

  // Dirty paths in a repo, no stat: what the band and the pane count as open.
  const openFiles = async root => {
    const r = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all'], 10000)
    return new Set(r.exitCode === 0 ? statusPaths(r.stdout) : [])
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
      for (const p of await peersOf(root)) for (const rel of Object.keys(p.files)) if (was[rel] && uncommitted(p, rel)) list.push([rel, nameOf(p)])
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
          return `peers: this command reaches uncommitted peer files in ${root}: ${files.join(', ')}. ${HINT[hit.rule]} See whose hunks are whose: peers diff --who <file>.`
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
        // A peer's tighter action spans the change: theirs, even inside our window.
        if (mtime > 0 && yields(rel, mtime, { from: t0, to: t1 }, peersNow)) continue
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
      const during = peersNow.filter(p => p.updated >= t0)
      touched = touched.filter(rel => {
        if (!during.length) return true
        const kept = unclaimed(deltas.get(rel), during, rel, t0)
        if (kept && deltas.has(rel)) deltas.set(rel, kept)
        return kept !== null
      })
      if (!touched.length) continue
      await record(root, touched, deltas, title, t0)
      const theirs = new Set(touched)
      for (const [rel, name] of snap.peer[root] ?? []) if (theirs.has(rel)) hitPeers.push(`${rel} (${name})`)
    }
    return [...new Set(hitPeers)]
  }

  // A whole-file write must not drop a peer's uncommitted lines: the deny text, or null.
  const writeDeny = async (root, rel, d, peers) => {
    peers ??= await peersOf(root)
    const lost = peerLinesLost(peers, rel, d.removed)
    const blind = peers.filter(p => uncommitted(p, rel) && !p.files[rel]?.added)
    if (!lost.length && !blind.length) return null
    const who = [...lost.map(x => `${nameOf(x.peer)} (${quote(x.lines)})`), ...blind.map(nameOf)]
    return `peers: this Write drops uncommitted lines of ${who.join(', ')} in ${rel}. Re-read the file and change only your part with Edit.`
  }

  // What a session is on: its task's title, else its Claude Code transcript's title; null when neither is known.
  // Task names come from Backlog.md file names (open and archived), "<id> - <title>.md". Each lookup reruns at most every 20 s.
  const sessionTitle = async l => {
    const now = await io.now()
    if (l.ticket) {
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
    return t.custom || t.ai
  }
  // The title under the name: the task's title, else Claude Code's own title of the session.
  const sessionAbout = async l => (l.ticket ? sessionTitle(l) : (await scanned(l)).ai)
  // The name the person gave the session (/rename), or null: short, so the views show it as the session's name.
  const sessionLabel = async l => (await scanned(l)).custom

  // perl when there is one (Windows has none on PATH): else the last of each kind found from the end in JS.
  const titleLines = async path => {
    if (!said.noPerl)
      try {
        const r = await io.run(['perl', '-ne', TITLE_PL, path], { timeoutMs: 5000 })
        if (r.exitCode === 0) return r.stdout
      } catch {}
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
    const got = path ? titlesOfScan(await titleLines(path)) : { custom: null, ai: null }
    said.titles.set(l.session, { at: now, got })
    return got
  }

  return { sessionTitle, sessionLabel, sessionAbout, roots, ledgerDir, ownPath, readJson, readText, rootOf, locate, loadMine, saveMine, record, end, peersOf, openFiles, headText, commandRoots, before, guard, after, writeDeny }
}
