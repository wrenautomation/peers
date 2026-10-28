// `peers view`: a live page of every session's uncommitted edits, each line in its author's color.
// The /peers pane reads the same server. Listens on 127.0.0.1 only.
// Started detached by `peers view` (exits after 15 min with no page open), or by launchd with --keep.
// PEERS_VIEW_HOST names the public host a tunnel sends (peers.wrenautomation.com): requests that carry
// it see only repos public on GitHub. Private repos (tasks, sops, artifacts, boards) never leave the Mac.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { createServer, get, request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESSIONS, core, idOf, isLive } from './core.mjs'
import { configSync, nodeIo, runningSync, statusSync } from './io.mjs'
import { docLines } from './doc.mjs'
import { homeOf, slash } from './path.mjs'
import { platform } from './platform.mjs'
import { onlyQuery, pick, terms } from './rows.mjs'
import { key, statusPaths } from './lines.mjs'

const PORT = +(process.env.PEERS_VIEW_PORT || 6421)
const URL = `http://127.0.0.1:${PORT}/`
const PUBLIC = process.env.PEERS_VIEW_HOST || ''
// PEERS_VIEW_VERSION: tests only, to play an older server.
export const VERSION = process.env.PEERS_VIEW_VERSION || JSON.parse(readFileSync(new globalThis.URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version
// a < b, as dotted numbers.
export const older = (a, b) => {
  const x = String(a).split('.').map(Number)
  const y = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0)
  return false
}
const LEDGERS = join(homedir(), '.claude', 'peers')
const MAX_TEXT = 1 << 20
const MAX_HEADS = 256 * 1024
const isMd = rel => /\.(md|mdx|markdown)$/i.test(rel)

// A failure goes to stderr (the launchd log): a blocked read must not look like "no changes".
const git = (root, args, quiet = false) => {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, windowsHide: true })
  } catch (e) {
    if (!quiet) console.error(`git ${args[0]} in ${root}: ${String(e.stderr || e.message).trim()}`)
    return ''
  }
}
const readJson = p => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// What each session is on (lib/core.mjs sessionTitle), kept by a pass in the background: state() reads it, never waits.
const said = new Map()
const labels = new Map() // session -> the name the person gave it
let sayer = null
const sayAll = async () => {
  sayer ??= core({ home: homedir(), session: '', backlog: process.env.BACKLOG_CWD })
  const k = sayer(nodeIo)
  let changed = false
  // Per repo: a session's task holds only in the repo where it claimed it.
  for (const { root, ledgers } of live())
    for (const l of ledgers) {
      const t = await k.sessionAbout(l).catch(() => null)
      const label = await k.sessionLabel(l).catch(() => null)
      if (said.get(`${root}\0${l.session}`) !== t || labels.get(l.session) !== label) changed = true
      said.set(`${root}\0${l.session}`, t)
      labels.set(l.session, label)
    }
  return changed
}

// Public = the origin is a GitHub repo that answers without a login. No remote, a private repo
// or a failed lookup: private. Looked up in the background, again every 6 hours.
const shown = new Map() // root -> { ok, at }
const isPublic = root => {
  const v = shown.get(root)
  if (!v || Date.now() - v.at > 6 * 3600 * 1000) {
    shown.set(root, { ok: v?.ok ?? false, at: Date.now() })
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(git(root, ['remote', 'get-url', 'origin'], true).trim())
    if (m)
      fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { 'user-agent': 'peers-view' } })
        .then(r => (r.ok ? r.json() : { private: true }))
        .then(j => shown.set(root, { ok: j.private === false, at: Date.now() }))
        .catch(() => {})
  }
  return shown.get(root).ok
}

// Live: a running session's ledger with work in it (core.mjs isLive).
const live = () => {
  const now = Date.now()
  const running = runningSync(homedir())
  const repos = []
  if (!existsSync(LEDGERS)) return repos
  for (const enc of readdirSync(LEDGERS)) {
    const root = decodeURIComponent(enc)
    if (!existsSync(join(root, '.git'))) continue
    const ledgers = readdirSync(join(LEDGERS, enc))
      .filter(f => f.endsWith('.json'))
      .map(f => readJson(join(LEDGERS, enc, f)))
      .filter(l => isLive(l, now, running))
    if (ledgers.length) repos.push({ root, ledgers })
  }
  return repos
}

// Who wrote a line: the session whose ledger holds it, the latest edit first.
const authorOf = (ledgers, rel, k, side) => {
  if (!k) return null
  let best = null
  for (const l of ledgers) {
    const e = l.files[rel]
    if (e?.[side]?.includes(k) && (!best || e.last > best.last)) best = { id: l.session, last: e.last }
  }
  return best?.id ?? null
}

// Markdown headings outside code fences: { line (1-based), d (depth), h (text) }.
const headingsOf = text => {
  const out = []
  let fence = false
  text.split('\n').forEach((x, i) => {
    if (/^\s*(```|~~~)/.test(x)) fence = !fence
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(x)
    if (m) out.push({ line: i + 1, d: m[1].length, h: m[2] })
  })
  return out
}
const heads = new Map() // abs path -> { mtime, list }
const headingsAt = abs => {
  try {
    const st = statSync(abs)
    if (st.size > MAX_HEADS) return []
    const v = heads.get(abs)
    if (v?.mtime === st.mtimeMs) return v.list
    const list = headingsOf(readFileSync(abs, 'utf8'))
    heads.set(abs, { mtime: st.mtimeMs, list })
    return list
  } catch {
    return []
  }
}

// Every file git shows in a repo (tracked and untracked, never an ignored one), kept 5 s.
const listed = new Map() // root -> { at, paths }
const filesIn = root => {
  const v = listed.get(root)
  if (v && Date.now() - v.at < 5000) return v.paths
  const paths = git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  listed.set(root, { at: Date.now(), paths })
  return paths
}

// A hunk's title: the line its author wrote before the edit (the ledger's `edits`), else where it is:
// the heading above it in Markdown, git's function line in code.
const titleOf = (ledgers, rel, h, list) => {
  const keys = new Set(h.lines.filter(x => x.t !== ' ').map(x => key(x.s)).filter(Boolean))
  let best = null
  for (const l of ledgers) for (const e of l.files[rel]?.edits ?? []) if ((!best || e.at > best.at) && e.k.some(k => keys.has(k))) best = e
  if (best) return { t: best.t, said: true, when: best.at }
  if (list) {
    let line = h.new
    for (const x of h.lines) {
      if (x.t !== ' ') break
      line++
    }
    const above = list.filter(x => x.line <= line).pop()
    if (above) return { t: above.h, said: false }
  }
  return { t: h.at, said: false }
}

// The author owning most of a hunk's changed lines.
const ownerOf = h => {
  const n = new Map()
  for (const x of h.lines) if (x.t !== ' ' && x.a) n.set(x.a, (n.get(x.a) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

// Titled edits and commits, newest first; one session's run of edits under one title is one row.
// The commits a session sends: the list shows 5 and opens to all of these; `peers log` has the rest.
const COMMITS_SENT = 100
// Commit subjects by sha: a sha never changes its subject, so one git call per new sha.
const subjects = new Map()
const subjectsOf = (root, shas) => {
  const want = shas.filter(x => !subjects.has(x))
  if (want.length) {
    for (const line of git(root, ['log', '--no-walk', '--ignore-missing', '--format=%H %s', ...want], true).split('\n')) {
      const i = line.indexOf(' ')
      if (i > 0) for (const x of want) if (line.startsWith(x)) subjects.set(x, line.slice(i + 1))
    }
    for (const x of want) if (!subjects.has(x)) subjects.set(x, '')
  }
  if (subjects.size > 2000) subjects.clear()
}

// Newest first, the last `keep` entries of each session (its box's scrollback). Untitled edits keep t = ''; the page names them by their files.
const feedOf = (root, ledgers, keep) => {
  const rows = []
  subjectsOf(root, ledgers.flatMap(l => (l.commits ?? []).map(c => c.sha)))
  for (const l of ledgers) {
    for (const [rel, e] of Object.entries(l.files)) for (const x of e.edits ?? []) rows.push({ kind: 'edit', at: x.at, a: l.session, t: x.t, rels: [rel] })
    for (const c of l.commits ?? []) rows.push({ kind: 'commit', at: c.at, a: l.session, t: subjects.get(c.sha) ?? '', sha: c.sha.slice(0, 8), rels: c.files })
  }
  rows.sort((a, b) => b.at - a.at)
  const out = []
  const count = new Map()
  for (const r of rows) {
    const p = out[out.length - 1]
    if (p && p.kind === 'edit' && r.kind === 'edit' && p.a === r.a && p.t === r.t) {
      if (!p.rels.includes(r.rels[0])) p.rels.push(r.rels[0])
      continue
    }
    const n = (count.get(r.a) ?? 0) + 1
    if (n > keep) continue
    count.set(r.a, n)
    out.push(r)
  }
  return out
}

const hunksOf = text => {
  const files = new Map()
  let f = null
  let h = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = null
      continue
    }
    if (line.startsWith('+++ ')) {
      const rel = line.slice(4).replace(/^b\//, '')
      if (rel !== '/dev/null') files.set(rel, (f = []))
      continue
    }
    if (line.startsWith('--- ') && !f) {
      const rel = line.slice(4).replace(/^a\//, '')
      if (rel !== '/dev/null') files.set(rel, (f = []))
      continue
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line)
    if (m && f) {
      f.push((h = { old: +m[1], new: +m[2], at: m[3].trim(), lines: [] }))
      continue
    }
    if (!h || !f) continue
    const t = line[0]
    if (t === '+' || t === '-' || t === ' ') h.lines.push({ t, s: line.slice(1) })
  }
  return files
}

const BULK = 40
const state = () => {
  const repos = []
  const states = statusSync(homedir())
  const { boxScrollback } = configSync(homedir())
  for (const { root, ledgers } of live()) {
    const dirty = statusPaths(git(root, ['status', '--porcelain', '-z', '--untracked-files=all']))
    const untracked = new Set(
      git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean),
    )
    // Added to the index counts as new, as an untracked file does.
    const staged = new Set(git(root, ['diff', 'HEAD', '--name-only', '--diff-filter=A', '-z']).split('\0').filter(Boolean))
    const diffs = hunksOf(git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U3']))
    const files = []
    // A new folder of many files (a vendored library, a build) is one row: its files would swamp both views.
    const bulk = git(root, ['ls-files', '--others', '--exclude-standard', '--directory', '-z']).split('\0').filter(d => d.endsWith('/'))
    const big = new Map(bulk.map(d => [d, [...untracked].filter(u => u.startsWith(d))]).filter(([, us]) => us.length > BULK))
    const inBig = rel => [...big.keys()].some(d => rel.startsWith(d))
    for (const [d, us] of big) {
      const mtime = Math.max(0, ...us.slice(0, 200).map(u => { try { return statSync(join(root, u)).mtimeMs } catch { return 0 } }))
      const touch = ledgers.filter(l => Object.keys(l.files).some(f => f.startsWith(d)))
      files.push({ rel: d, hunks: [], authors: touch.map(l => l.session), isNew: true, kind: 'add', count: us.length, mtime, titles: [] })
    }
    for (const rel of new Set(dirty)) {
      if (inBig(rel)) continue
      let hunks = diffs.get(rel) ?? []
      if (untracked.has(rel)) {
        let body = ''
        try {
          if (statSync(join(root, rel)).size <= MAX_TEXT) body = readFileSync(join(root, rel), 'utf8')
        } catch {}
        const lines = body.replace(/\n$/, '').split('\n')
        hunks = body ? [{ old: 0, new: 1, at: 'new file', lines: lines.map(s => ({ t: '+', s })) }] : []
      }
      // Each changed line gets its author; a line too plain to own (a brace, a blank) takes its neighbour's.
      const by = new Set()
      for (const h of hunks) {
        let prev = null
        for (const x of h.lines) {
          if (x.t === ' ') {
            prev = null
            continue
          }
          x.a = authorOf(ledgers, rel, key(x.s), x.t === '+' ? 'added' : 'removed') ?? (key(x.s) ? null : prev)
          prev = x.a
          if (x.a) by.add(x.a)
        }
      }
      const list = isMd(rel) ? headingsAt(join(root, rel)) : null
      for (const h of hunks) Object.assign(h, titleOf(ledgers, rel, h, list), { a: ownerOf(h) })
      // Sessions that name the file but hold no line in it (edits too plain, an old mod).
      const touch = ledgers.filter(l => l.files[rel] && !(l.commits ?? []).some(c => c.at >= l.files[rel].last && c.files.includes(rel)))
      const st = (() => {
        try {
          return statSync(join(root, rel))
        } catch {
          return null
        }
      })()
      const mtime = st?.mtimeMs ?? 0
      const said = [...new Set(hunks.filter(h => h.said).map(h => h.t))]
      const isNew = untracked.has(rel) || staged.has(rel)
      const kind = isNew ? 'add' : existsSync(join(root, rel)) ? 'edit' : 'delete'
      // A nested repo, a submodule or a linked folder is one row; it shows with a slash.
      // The file's length in lines, so the views can show the lines after the last hunk.
      let size = 0
      if (st?.isFile() && st.size <= MAX_TEXT)
        try {
          const t = readFileSync(join(root, rel), 'utf8')
          size = t ? t.replace(/\n$/, '').split('\n').length : 0
        } catch {}
      files.push({ rel, hunks, authors: [...new Set([...by, ...touch.map(l => l.session)])], isNew, kind, mtime, size, titles: said, ...(st?.isDirectory() ? { isDir: true } : {}) })
    }
    files.sort((a, b) => b.mtime - a.mtime)
    subjectsOf(root, ledgers.flatMap(l => (l.commits ?? []).map(c => c.sha)))
    repos.push({
      root,
      name: root.split('/').pop(),
      sessions: ledgers
        .sort((a, b) => a.started - b.started)
        .map(l => {
          const last = Object.values(l.files)
            .flatMap(e => (e.edits ?? []).filter(x => x.t))
            .sort((a, b) => b.at - a.at)[0]
          return {
            id: l.session,
            name: idOf(l),
            label: labels.get(l.session) ?? null,
            ...(states.get(l.session) ?? {}),
            ticket: l.ticket ?? null,
            title: said.get(`${root}\0${l.session}`) ?? null,
            doing: last?.t ?? null,
            started: l.started,
            updated: l.updated,
            commitCount: (l.commits ?? []).length,
            commits: (l.commits ?? []).slice(-COMMITS_SENT).reverse().map(c => ({ sha: c.sha, at: c.at, files: c.files.length, t: subjects.get(c.sha) ?? '' })),
          }
        }),
      files,
      feed: feedOf(root, ledgers, Math.max(1, Number(boxScrollback) || 50)),
    })
  }
  return { at: Date.now(), repos }
}

// Only a file git lists in a shown repo: never an ignored one (an env file) or one outside the repo.
const fileDoc = (st, root, rel) => {
  if (!st.repos.some(r => r.root === root) || !filesIn(root).includes(rel)) return null
  const repo = live().find(r => r.root === root)
  if (!repo) return null
  const read = () => {
    try {
      return statSync(join(root, rel)).size <= MAX_TEXT ? readFileSync(join(root, rel), 'utf8') : ''
    } catch {
      return ''
    }
  }
  const authors = { added: {}, removed: {} }
  for (const l of repo.ledgers) {
    const e = l.files[rel]
    if (!e) continue
    for (const side of ['added', 'removed']) for (const k of e[side] ?? []) authors[side][k] = l.session
  }
  const now = read()
  return { text: now, lines: docLines(git(root, ['show', `HEAD:${rel}`], true), now, authors) }
}

// Every session in start order, over all repos: the one color order for the page, the pane, the TUI and the
// band. A match (`only`) keeps it, so a session's color never changes with the filter.
const orderOf = repos => {
  const first = new Map()
  for (const s of repos.flatMap(r => r.sessions)) first.set(s.id, Math.min(first.get(s.id) ?? Infinity, s.started ?? 0))
  return [...first.keys()].sort((a, b) => first.get(a) - first.get(b))
}

// The file list without line data, for the pane's poll; sig changes when anything shown changes.
const indexOf = st => {
  const repos = st.repos.map(r => ({
    ...r,
    files: r.files.map(({ hunks, ...f }) => {
      const changes = hunks.map(h => ({
        line: h.new,
        t: h.t,
        said: h.said,
        ...(h.when ? { when: h.when } : {}),
        a: h.a,
        adds: h.lines.filter(x => x.t === '+').length,
        dels: h.lines.filter(x => x.t === '-').length,
      }))
      return { ...f, changes, adds: changes.reduce((n, c) => n + c.adds, 0), dels: changes.reduce((n, c) => n + c.dels, 0) }
    }),
  }))
  return { sig: createHash('sha1').update(JSON.stringify(st.repos)).digest('hex').slice(0, 16), at: st.at, repos, order: orderOf(repos) }
}

const serve = keep => {
  // Read once: a plugin update may delete this version's folder under a running server.
  const page = readFileSync(new globalThis.URL('./view.html', import.meta.url), 'utf8')
  const TYPES = { mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', json: 'application/json', svg: 'image/svg+xml' }
  const icons = readdirSync(new globalThis.URL('./vendor/material-icons/', import.meta.url)).map(f => `material-icons/${f}`)
  const vendor = new Map(
    ['marked.mjs', 'wunderbaum.mjs', 'wunderbaum.css', 'fuse.mjs', 'idiomorph.mjs', 'highlight.mjs', 'split-grid.mjs', 'hljs-light.css', 'hljs-dark.css', 'github-markdown.css', 'bootstrap-icons.css', 'fonts/bootstrap-icons.woff2', 'material-icons.json', ...icons].map(f => [
      `/vendor/${f}`,
      { type: TYPES[f.split('.').pop()], body: readFileSync(new globalThis.URL(`./vendor/${f}`, import.meta.url)) },
    ]),
  )
  // The shared row rules (gaps, names), served to the page as the pane and `peers tui` import them; no cache, as they change on upgrade.
  const libs = new Map(
    ['rows.mjs', 'path.mjs', 'doc.mjs', 'lines.mjs', 'vendor/diff.mjs'].map(f => [`/lib/${f}`, readFileSync(new globalThis.URL(`./${f}`, import.meta.url))]),
  )
  const clients = new Map() // SSE response -> { priv: sees private repos, only: its filter terms }
  // A filter keeps the repos it matches and says what it asked for (paths under home as ~) and what is live.
  const home = homeOf(homedir())
  const only = (st, terms) =>
    !terms.length
      ? st
      : { ...st, repos: pick(st.repos, terms, home), only: terms.map(t => (t.startsWith(`${home}/`) ? `~${t.slice(home.length)}` : t)), live: st.repos.map(r => r.name) }
  // One state for every reader: rebuilt on the next read after a change, never per request.
  let cache = null
  let dirty = true
  const current = () => {
    if (dirty || !cache) {
      const st = state()
      const pub = { ...st, repos: st.repos.filter(r => isPublic(r.root)) }
      cache = { all: st, pub, index: { all: indexOf(st), pub: indexOf(pub) } }
      dirty = false
    }
    return cache
  }
  let last = ''
  let idle = Date.now()
  const push = () => {
    if (!clients.size) return
    const c = current()
    if (c.index.all.sig === last) return
    last = c.index.all.sig
    let all, pub
    for (const [res, v] of clients)
      if (v.sig) res.write(`data: ${c.index[v.priv ? 'all' : 'pub'].sig}\n\n`)
      else res.write(`data: ${v.only.length ? JSON.stringify(only(v.priv ? c.all : c.pub, v.only)) : v.priv ? (all ??= JSON.stringify(c.all)) : (pub ??= JSON.stringify(c.pub))}\n\n`)
  }
  let timer = null
  const soon = () => {
    dirty = true
    clearTimeout(timer)
    timer = setTimeout(push, 400)
  }
  // FSEvents on the ledgers and each live repo; build output and git internals are noise.
  const watched = new Set()
  const NOISE = /(^|\/)(node_modules|\.git|\.turbo|dist|build|coverage|\.next|storybook-static)(\/|$)/
  const watchAll = () => {
    // Claude Code's session files too: a session that goes busy, idle or waits redraws the views.
    for (const dir of [LEDGERS, SESSIONS(homedir()), ...live().map(r => r.root)]) {
      if (watched.has(dir) || !existsSync(dir)) continue
      watched.add(dir)
      try {
        watch(dir, { recursive: true }, (_, f) => {
          if (!f || !NOISE.test(String(f).replace(/\\/g, '/'))) soon()
        })
      } catch (e) {
        console.error(`watch ${dir}: ${e.message}`)
      }
    }
  }
  watchAll()
  const say = () => void sayAll().then(c => c && soon(), () => {})
  say()
  setInterval(say, 10000)
  // The watchers miss a session going stale and a transcript's new title: a rebuild every 10 s when a ledger
  // or a session file moved, else every minute.
  let seen = ''
  let built = 0
  const sigNow = () => {
    const out = []
    for (const dir of [SESSIONS(homedir()), ...(existsSync(LEDGERS) ? readdirSync(LEDGERS).map(e => join(LEDGERS, e)) : [])])
      try {
        for (const f of readdirSync(dir)) if (f.endsWith('.json')) out.push(`${f}:${statSync(join(dir, f)).mtimeMs}`)
      } catch {}
    return out.join(',')
  }
  setInterval(() => {
    watchAll()
    const sig = sigNow()
    if (sig !== seen || Date.now() - built > 60_000) {
      seen = sig
      built = Date.now()
      soon()
    }
    if (!keep && !clients.size && Date.now() - idle > 15 * 60 * 1000) process.exit(0)
  }, 10000)
  // Cloudflare drops a quiet stream after about 100 s.
  setInterval(() => {
    for (const res of clients.keys()) res.write(': ping\n\n')
  }, 25000)

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    // A page from elsewhere that rebinds its name to 127.0.0.1 sends its own Host: refuse it.
    const host = req.headers.host ?? ''
    const priv = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)
    if (!priv && !(PUBLIC && host === PUBLIC)) return res.writeHead(403).end()
    idle = Date.now()
    const u = new globalThis.URL(req.url, URL)
    const scope = priv ? 'all' : 'pub'
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(page)
    }
    const lib = libs.get(u.pathname)
    if (lib) {
      res.writeHead(200, { 'content-type': TYPES.mjs, 'cache-control': 'no-cache' })
      return res.end(lib)
    }
    const v = vendor.get(u.pathname)
    if (v) {
      res.writeHead(200, { 'content-type': v.type, 'cache-control': 'max-age=86400' })
      return res.end(v.body)
    }
    if (u.pathname === '/api/ping') return json(res, 200, { app: 'peers', version: VERSION, pid: process.pid, keep })
    // A newer client stops an older server. This Mac only, and a header a page on another site cannot send without a preflight.
    if (u.pathname === '/api/stop') {
      if (!priv || req.method !== 'POST' || req.headers['x-peers'] !== 'stop') return res.writeHead(403).end()
      res.end('stopping')
      return setImmediate(() => process.exit(0))
    }
    // The band's colors: small, polled each tick.
    if (u.pathname === '/api/order') {
      const ix = current().index[scope]
      if (u.searchParams.get('sig') === ix.sig) return res.writeHead(204).end()
      return json(res, 200, { sig: ix.sig, order: ix.order })
    }
    if (u.pathname === '/api/index') {
      const ix = current().index[scope]
      if (u.searchParams.get('sig') === ix.sig) return res.writeHead(204).end()
      return json(res, 200, only(ix, u.searchParams.getAll('only')))
    }
    const root = u.searchParams.get('root') ?? ''
    const rel = u.searchParams.get('rel') ?? ''
    if (u.pathname === '/api/hunks') {
      const f = current()[scope].repos.find(r => r.root === root)?.files.find(x => x.rel === rel)
      return json(res, f ? 200 : 404, f?.hunks ?? null)
    }
    // The tree and the finder: every listed path, and the headings of each Markdown file.
    if (u.pathname === '/api/files') {
      if (!current()[scope].repos.some(r => r.root === root)) return json(res, 404, null)
      const paths = filesIn(root)
      const heads = paths.filter(isMd).flatMap(rel => headingsAt(join(root, rel)).map(x => ({ rel, ...x })))
      return json(res, 200, { paths, heads })
    }
    if (u.pathname === '/api/doc') {
      const body = fileDoc(current()[scope], root, rel)
      return json(res, body ? 200 : 404, body)
    }
    if (u.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const terms = u.searchParams.getAll('only')
      // ?sig=1: only the new sig on each change, for the band: it then reads what it needs.
      const sig = u.searchParams.has('sig')
      res.write(`data: ${sig ? current().index[scope].sig : JSON.stringify(only(current()[scope], terms))}\n\n`)
      clients.set(res, { priv, only: terms, sig })
      req.on('close', () => {
        clients.delete(res)
        idle = Date.now()
      })
      return
    }
    res.writeHead(404).end()
  })
  let tries = 0
  server
    .on('error', async e => {
      console.error(`listen ${PORT}: ${e.message}`)
      // The supervised server owns the port: it stops a detached one, or an older supervised one, and listens again.
      const p = e.code === 'EADDRINUSE' && keep && tries++ < 5 ? await ping() : null
      if (p && !p.old && (!p.keep || older(p.version, VERSION)) && (await stopServer())) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 500)
      process.exit(1)
    })
    .listen(PORT, '127.0.0.1')
}

// The server on the port: { app, version, pid, keep }, { old: true } for one before 0.16.7 (it answers plain text), or null.
export const ping = () =>
  new Promise(ok => {
    const r = get(`${URL}api/ping`, { agent: false }, res => {
      let body = ''
      res.on('data', d => (body += d))
      res.on('end', () => {
        if (res.statusCode !== 200) return ok(null)
        try {
          ok(JSON.parse(body))
        } catch {
          ok({ old: true })
        }
      })
    })
    r.on('error', () => ok(null))
    r.setTimeout(1000, () => (r.destroy(), ok(null)))
  })
const stopServer = () =>
  new Promise(ok => {
    const r = request(`${URL}api/stop`, { method: 'POST', headers: { 'x-peers': 'stop' }, agent: false }, res => (res.resume(), ok(res.statusCode === 200)))
    r.on('error', () => ok(false))
    r.setTimeout(1000, () => (r.destroy(), ok(false)))
    r.end()
  })
const waitFor = async (want, ms) => {
  for (let t = 0; t < ms; t += 100) {
    if (want(await ping())) return true
    await sleep(100)
  }
  return false
}

// One server, at least this version. Every client runs it: `peers view`, the TUI and the pane (through `peers view --no-open`).
// An older server stops; a supervised one comes back on the new code through ~/.local/bin/peers, else this
// starts one. At most about 9 s: the pane waits 10.
export const ensure = async () => {
  let p = await ping()
  if (p?.old) return console.error(`peers: a peers view server from before 0.16.7 holds port ${PORT} and cannot be stopped from here. Stop it once by hand (see README, Install).`)
  if (p && older(p.version, VERSION) && (await stopServer())) {
    await waitFor(x => !x || x.pid !== p.pid, 2000)
    p = p.keep && (await waitFor(x => x && x.pid !== p.pid, 3000)) ? await ping() : null
  }
  if (p) return
  spawn(process.execPath, [fileURLToPath(new globalThis.URL('../bin/peers.mjs', import.meta.url)), 'view', '--serve'], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true }).unref()
  await waitFor(Boolean, 4000)
}

const up = async () => !!(await ping())

// `peers view --install [--host <public host>]`: the OS supervisor (lib/platform.mjs: launchd, systemd, the Windows
// Startup folder) keeps the server up. It runs the stable shim, so a restart picks up the newest version.
const sleep = ms => new Promise(r => setTimeout(r, ms))
const os = platform(process.platform)
export const supervision = (host = '') => {
  const vars = {}
  if (host) vars.PEERS_VIEW_HOST = host
  if (process.env.BACKLOG_CWD) vars.BACKLOG_CWD = process.env.BACKLOG_CWD
  const home = homeOf(homedir())
  const appData = process.env.APPDATA ? slash(process.env.APPDATA, true) : undefined
  const base = { home, node: process.execPath, uid: process.getuid?.(), appData, vars }
  return { sv: os.supervisor, c: { ...base, log: os.supervisor.log(base) } }
}
const quiet = ([cmd, ...args]) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}
export const loaded = ({ sv, c } = supervision()) => quiet(sv.loaded(c))
const stopSupervisor = async ({ sv, c }) => {
  for (const a of sv.stop(c)) quiet(a)
  for (let i = 0; i < 50 && loaded({ sv, c }); i++) await sleep(100)
  // Windows: stopping wscript's loop leaves its server running.
  if ((await ping())?.keep) await stopServer()
}
const install = async host => {
  const s = supervision(host)
  const { sv, c } = s
  const path = sv.path(c)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(dirname(c.log), { recursive: true })
  writeFileSync(path, sv.text(c))
  await stopSupervisor(s)
  // A detached server from `peers view` may hold the port; the new server stops it over /api/stop.
  for (let i = 0; i < 5 && !loaded(s); i++) {
    for (const [cmd, ...args] of sv.start(c))
      if (sv.detach) spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      else quiet([cmd, ...args])
    for (let j = 0; j < 10 && !loaded(s); j++) await sleep(100)
  }
  for (let i = 0; i < 50 && !(await up()); i++) await sleep(300)
  if (!(await up())) {
    console.error(`peers view: ${sv.name} did not bring the server up; log ${c.log}`)
    process.exit(1)
  }
  console.log(`peers view: ${sv.name} keeps the server up${host ? `, public host ${host}` : ''}; log ${c.log}`)
}
const uninstall = async () => {
  const s = supervision()
  await stopSupervisor(s)
  rmSync(s.sv.path(s.c), { force: true })
  console.log(`peers view: removed from ${s.sv.name}`)
}

export const view = async () => {
  const argv = process.argv
  if (argv.includes('--serve')) return serve(argv.includes('--keep'))
  if (argv.includes('--install')) return install(argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : '')
  if (argv.includes('--uninstall')) return uninstall()
  await ensure()
  // `peers view wren ..`: the page shows only the repos those words match.
  const words = argv.slice(3).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--host')
  const q = onlyQuery(terms(words, process.cwd(), homedir())).replace('&', '?')
  console.log(URL + q)
  const [cmd, ...args] = os.opener(URL + q)
  if (!process.argv.includes('--no-open')) spawn(cmd, args, { stdio: 'ignore', windowsHide: true }).unref()
}

