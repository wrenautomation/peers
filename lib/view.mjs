// `peers view`: a live page of every session's uncommitted edits, each line in its author's color.
// Serves 127.0.0.1 only. Started detached by `peers view`; exits after 15 min with no page open.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { createServer, get } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { key, statusPaths } from './lines.mjs'

const PORT = +(process.env.PEERS_VIEW_PORT || 6421)
const URL = `http://127.0.0.1:${PORT}/`
const LEDGERS = join(homedir(), '.claude', 'peers')
const LIVE_MS = 12 * 3600 * 1000
const MAX_TEXT = 1 << 20

const git = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 })
  } catch {
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
      .filter(l => l && !l.ended && now - l.updated < LIVE_MS)
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

const fileBody = (root, rel) => {
  const repo = live().find(r => r.root === root)
  if (!repo || rel.includes('..')) return null
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
  return { old: git(root, ['show', `HEAD:${rel}`]), new: read(), authors }
}

const serve = () => {
  const page = readFileSync(new globalThis.URL('./view.html', import.meta.url), 'utf8')
  const clients = new Set()
  let last = ''
  let idle = Date.now()
  const push = () => {
    if (!clients.size) return
    const s = JSON.stringify(state())
    const sig = s.replace(/"at":\d+,/, '')
    if (sig === last) return
    last = sig
    for (const c of clients) c.write(`data: ${s}\n\n`)
  }
  let timer = null
  const soon = () => {
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
      } catch {}
    }
  }
  watchAll()
  setInterval(() => {
    watchAll()
    soon()
    if (!clients.size && Date.now() - idle > 15 * 60 * 1000) process.exit(0)
  }, 10000)

  createServer((req, res) => {
    // A page from elsewhere that rebinds its name to 127.0.0.1 sends its own Host: refuse it.
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host ?? '')) return res.writeHead(403).end()
    const u = new globalThis.URL(req.url, URL)
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(page)
    }
    if (u.pathname === '/api/ping') return res.end('peers')
    if (u.pathname === '/api/file') {
      const body = fileBody(u.searchParams.get('root') ?? '', u.searchParams.get('rel') ?? '')
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(body))
    }
    if (u.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(state())}\n\n`)
      clients.add(res)
      req.on('close', () => {
        clients.delete(res)
        idle = Date.now()
      })
      return
    }
    res.writeHead(404).end()
  }).listen(PORT, '127.0.0.1')
}

const up = () =>
  new Promise(ok => {
    const r = get(`${URL}api/ping`, res => ok(res.statusCode === 200))
    r.on('error', () => ok(false))
    r.setTimeout(1000, () => (r.destroy(), ok(false)))
  })

export const view = async () => {
  if (!(await up())) {
    spawn(process.execPath, [new globalThis.URL(import.meta.url).pathname, '--serve'], { detached: true, stdio: 'ignore', env: process.env }).unref()
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 100))
  }
  console.log(URL)
  if (!process.argv.includes('--no-open')) spawn('open', [URL], { stdio: 'ignore' }).unref()
}

if (process.argv[2] === '--serve') serve()
