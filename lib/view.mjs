// `peers view`: a live page of every session's uncommitted edits, each line in its author's color.
// The /peers pane reads the same server. Listens on 127.0.0.1 only.
// Started detached by `peers view` (exits after 15 min with no page open), or by launchd with --keep.
// PEERS_VIEW_HOST names the public host a tunnel sends (peers.wrenautomation.com): requests that carry
// it see only repos public on GitHub. Private repos (tasks, sops, artifacts, boards) never leave the Mac.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nameOf } from './core.mjs'
import { docLines } from './doc.mjs'
import { key, statusPaths } from './lines.mjs'

const PORT = +(process.env.PEERS_VIEW_PORT || 6421)
const URL = `http://127.0.0.1:${PORT}/`
const PUBLIC = process.env.PEERS_VIEW_HOST || ''
const LEDGERS = join(homedir(), '.claude', 'peers')
const LIVE_MS = 12 * 3600 * 1000
const MAX_TEXT = 1 << 20
const MAX_HEADS = 256 * 1024
const FEED_MAX = 60
const isMd = rel => /\.(md|mdx|markdown)$/i.test(rel)

// A failure goes to stderr (the launchd log): a blocked read must not look like "no changes".
const git = (root, args, quiet = false) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
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

// Task titles come from Backlog.md file names: "<id> - <title>.md".
const titles = () => {
  const out = new Map()
  const dir = process.env.BACKLOG_CWD && join(process.env.BACKLOG_CWD, 'backlog', 'tasks')
  if (!dir || !existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    const m = /^(\S+) - (.+)\.md$/.exec(f)
    if (m) out.set(m[1].toLowerCase(), m[2].replace(/-/g, ' '))
  }
  return out
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

// A ledger written after its end is live: a mod reload runs session.end on a session that goes on.
const live = () => {
  const now = Date.now()
  const repos = []
  if (!existsSync(LEDGERS)) return repos
  for (const enc of readdirSync(LEDGERS)) {
    const root = decodeURIComponent(enc)
    if (!existsSync(join(root, '.git'))) continue
    const ledgers = readdirSync(join(LEDGERS, enc))
      .filter(f => f.endsWith('.json'))
      .map(f => readJson(join(LEDGERS, enc, f)))
      .filter(l => l && !(l.ended && l.updated - l.ended < 5000) && now - l.updated < LIVE_MS)
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
  if (best) return { t: best.t, said: true }
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

// Newest first. Untitled edits keep t = ''; the page names them by their files.
const feedOf = (root, ledgers) => {
  const rows = []
  subjectsOf(root, ledgers.flatMap(l => (l.commits ?? []).map(c => c.sha)))
  for (const l of ledgers) {
    for (const [rel, e] of Object.entries(l.files)) for (const x of e.edits ?? []) rows.push({ kind: 'edit', at: x.at, a: l.session, t: x.t, rels: [rel] })
    for (const c of l.commits ?? []) rows.push({ kind: 'commit', at: c.at, a: l.session, t: subjects.get(c.sha) ?? '', sha: c.sha.slice(0, 8), rels: c.files })
  }
  rows.sort((a, b) => b.at - a.at)
  const out = []
  for (const r of rows) {
    const p = out[out.length - 1]
    if (p && p.kind === 'edit' && r.kind === 'edit' && p.a === r.a && p.t === r.t) {
      if (!p.rels.includes(r.rels[0])) p.rels.push(r.rels[0])
      continue
    }
    if (out.length >= FEED_MAX) break
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
  const names = titles()
  const repos = []
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
      const mtime = (() => {
        try {
          return statSync(join(root, rel)).mtimeMs
        } catch {
          return 0
        }
      })()
      const said = [...new Set(hunks.filter(h => h.said).map(h => h.t))]
      const isNew = untracked.has(rel) || staged.has(rel)
      const kind = isNew ? 'add' : existsSync(join(root, rel)) ? 'edit' : 'delete'
      files.push({ rel, hunks, authors: [...new Set([...by, ...touch.map(l => l.session)])], isNew, kind, mtime, titles: said })
    }
    files.sort((a, b) => b.mtime - a.mtime)
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
            name: nameOf(l),
            title: l.ticket ? (names.get(l.ticket.toLowerCase()) ?? null) : null,
            doing: last?.t ?? null,
            started: l.started,
            updated: l.updated,
            commits: (l.commits ?? []).slice(-5).reverse().map(c => ({ sha: c.sha, at: c.at, files: c.files.length })),
          }
        }),
      files,
      feed: feedOf(root, ledgers),
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

// The file list without line data, for the pane's poll; sig changes when anything shown changes.
const indexOf = st => {
  const repos = st.repos.map(r => ({
    ...r,
    files: r.files.map(({ hunks, ...f }) => {
      const changes = hunks.map(h => ({
        line: h.new,
        t: h.t,
        said: h.said,
        a: h.a,
        adds: h.lines.filter(x => x.t === '+').length,
        dels: h.lines.filter(x => x.t === '-').length,
      }))
      return { ...f, changes, adds: changes.reduce((n, c) => n + c.adds, 0), dels: changes.reduce((n, c) => n + c.dels, 0) }
    }),
  }))
  return { sig: createHash('sha1').update(JSON.stringify(st.repos)).digest('hex').slice(0, 16), at: st.at, repos }
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
  const clients = new Map() // SSE response -> sees private repos
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
    const all = JSON.stringify(c.all)
    const pub = JSON.stringify(c.pub)
    for (const [res, priv] of clients) res.write(`data: ${priv ? all : pub}\n\n`)
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
    for (const dir of [LEDGERS, ...live().map(r => r.root)]) {
      if (watched.has(dir) || !existsSync(dir)) continue
      watched.add(dir)
      try {
        watch(dir, { recursive: true }, (_, f) => {
          if (!f || !NOISE.test(String(f))) soon()
        })
      } catch (e) {
        console.error(`watch ${dir}: ${e.message}`)
      }
    }
  }
  watchAll()
  setInterval(() => {
    watchAll()
    soon()
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
    const v = vendor.get(u.pathname)
    if (v) {
      res.writeHead(200, { 'content-type': v.type, 'cache-control': 'max-age=86400' })
      return res.end(v.body)
    }
    if (u.pathname === '/api/ping') return res.end('peers')
    if (u.pathname === '/api/index') {
      const ix = current().index[scope]
      if (u.searchParams.get('sig') === ix.sig) return res.writeHead(204).end()
      return json(res, 200, ix)
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
      res.write(`data: ${JSON.stringify(current()[scope])}\n\n`)
      clients.set(res, priv)
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
    .on('error', e => {
      console.error(`listen ${PORT}: ${e.message}`)
      // The launchd server owns the port: a detached one (a pane in a session on an older version
      // can start one while --install restarts the agent) gives it up.
      if (keep && e.code === 'EADDRINUSE' && tries++ < 5 && stopDetached()) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 500)
      process.exit(1)
    })
    .listen(PORT, '127.0.0.1')
}

const listeners = () => {
  try {
    return execFileSync('/usr/sbin/lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

// Stops each `peers view --serve` without --keep on the port; true when one was stopped.
const stopDetached = () => {
  let stopped = false
  for (const pid of listeners()) {
    const args = execFileSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
    if (!/peers\.mjs view --serve/.test(args) || args.includes('--keep')) continue
    process.kill(pid)
    stopped = true
  }
  return stopped
}

const up = () =>
  new Promise(ok => {
    const r = get(`${URL}api/ping`, res => ok(res.statusCode === 200))
    r.on('error', () => ok(false))
    r.setTimeout(1000, () => (r.destroy(), ok(false)))
  })

// `peers view --install [--host <public host>]`: a launchd agent keeps the server up. It runs the
// stable ~/.local/bin/peers link, so after a plugin update `--install` again restarts it on the new code.
const AGENT = 'com.wrenautomation.peers-view'
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${AGENT}.plist`)
const domain = `gui/${process.getuid()}`
const launchctl = (...args) => {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' })
  } catch {}
}
const loaded = () => {
  try {
    execFileSync('launchctl', ['print', `${domain}/${AGENT}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const install = async host => {
  const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const vars = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: homedir() }
  if (host) vars.PEERS_VIEW_HOST = host
  if (process.env.BACKLOG_CWD) vars.BACKLOG_CWD = process.env.BACKLOG_CWD
  const args = [process.execPath, join(homedir(), '.local', 'bin', 'peers'), 'view', '--serve', '--keep']
  const log = join(homedir(), 'Library', 'Logs', 'peers-view.log')
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(vars)
    .map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`)
    .join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`,
  )
  // bootout returns before the job is gone, and a bootstrap before then fails.
  launchctl('bootout', `${domain}/${AGENT}`)
  for (let i = 0; i < 50 && loaded(); i++) await sleep(100)
  // A detached server from `peers view` may hold the port; the new server stops it (stopDetached).
  for (let i = 0; i < 5 && !loaded(); i++) {
    launchctl('bootstrap', domain, plistPath)
    if (!loaded()) await sleep(500)
  }
  for (let i = 0; i < 50 && !(await up()); i++) await sleep(300)
  if (!(await up())) {
    console.error(`${AGENT} did not come up; log ${log}`)
    process.exit(1)
  }
  console.log(`${AGENT} up${host ? `, public host ${host}` : ''}; log ${log}`)
}

export const view = async () => {
  const argv = process.argv
  if (argv.includes('--serve')) return serve(argv.includes('--keep'))
  if (argv.includes('--install')) return install(argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : '')
  if (argv.includes('--uninstall')) {
    launchctl('bootout', `${domain}/${AGENT}`)
    rmSync(plistPath, { force: true })
    return console.log(`${AGENT} removed`)
  }
  if (!(await up())) {
    spawn(process.execPath, [new globalThis.URL('../bin/peers.mjs', import.meta.url).pathname, 'view', '--serve'], { detached: true, stdio: 'ignore', env: process.env }).unref()
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 100))
  }
  console.log(URL)
  if (!process.argv.includes('--no-open')) spawn('open', [URL], { stdio: 'ignore' }).unref()
}

