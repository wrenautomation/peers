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
import { docLines } from './doc.mjs'
import { key, statusPaths } from './lines.mjs'

const PORT = +(process.env.PEERS_VIEW_PORT || 6421)
const URL = `http://127.0.0.1:${PORT}/`
const PUBLIC = process.env.PEERS_VIEW_HOST || ''
const LEDGERS = join(homedir(), '.claude', 'peers')
const LIVE_MS = 12 * 3600 * 1000
const MAX_TEXT = 1 << 20

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

const state = () => {
  const names = titles()
  const repos = []
  for (const { root, ledgers } of live()) {
    const dirty = statusPaths(git(root, ['status', '--porcelain', '-z', '--untracked-files=all']))
    if (!dirty.length) continue
    const untracked = new Set(
      git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean),
    )
    const diffs = hunksOf(git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U3']))
    const files = []
    for (const rel of new Set(dirty)) {
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
      // Sessions that name the file but hold no line in it (edits too plain, an old mod).
      const touch = ledgers.filter(l => l.files[rel] && !(l.commits ?? []).some(c => c.at >= l.files[rel].last && c.files.includes(rel)))
      const mtime = (() => {
        try {
          return statSync(join(root, rel)).mtimeMs
        } catch {
          return 0
        }
      })()
      files.push({ rel, hunks, authors: [...new Set([...by, ...touch.map(l => l.session)])], isNew: untracked.has(rel), mtime })
    }
    files.sort((a, b) => b.mtime - a.mtime)
    repos.push({
      root,
      name: root.split('/').pop(),
      sessions: ledgers
        .sort((a, b) => a.started - b.started)
        .map(l => ({
          id: l.session,
          name: l.ticket ?? `s-${l.session.slice(0, 4)}`,
          title: l.ticket ? (names.get(l.ticket.toLowerCase()) ?? null) : null,
          updated: l.updated,
          commits: (l.commits ?? []).slice(-5).reverse().map(c => ({ sha: c.sha, at: c.at, files: c.files.length })),
        })),
      files,
    })
  }
  return { at: Date.now(), repos }
}

// Only a file in the current list: never an ignored one (an env file) or one outside the repo.
const fileDoc = (st, root, rel) => {
  if (!st.repos.find(r => r.root === root)?.files.some(f => f.rel === rel)) return null
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
    files: r.files.map(({ hunks, ...f }) => ({
      ...f,
      adds: hunks.reduce((n, h) => n + h.lines.filter(x => x.t === '+').length, 0),
      dels: hunks.reduce((n, h) => n + h.lines.filter(x => x.t === '-').length, 0),
    })),
  }))
  return { sig: createHash('sha1').update(JSON.stringify(st.repos)).digest('hex').slice(0, 16), at: st.at, repos }
}

const serve = keep => {
  // Read once: a plugin update may delete this version's folder under a running server.
  const page = readFileSync(new globalThis.URL('./view.html', import.meta.url), 'utf8')
  const marked = readFileSync(new globalThis.URL('./vendor/marked.mjs', import.meta.url), 'utf8')
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
  createServer((req, res) => {
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
    if (u.pathname === '/vendor/marked.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' })
      return res.end(marked)
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
    .on('error', e => {
      console.error(`listen ${PORT}: ${e.message}`)
      process.exit(1)
    })
    .listen(PORT, '127.0.0.1')
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
const install = host => {
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
  launchctl('bootout', `${domain}/${AGENT}`)
  // A detached server from `peers view` holds the port: stop it first.
  try {
    for (const pid of execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean))
      process.kill(+pid)
  } catch {}
  launchctl('bootstrap', domain, plistPath)
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

