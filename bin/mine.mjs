#!/usr/bin/env node
// mine: git scoped to the files this Claude Code session touched.
// Ledger: ~/.claude/peers/<encodeURIComponent(repo root)>/<session>.json, written by the peers mod.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const argv = process.argv.slice(2)
const cmd = argv[0]
const usage = `mine status | diff | commit -m "msg" | check | ls | claim <ticket> | close [-r reason] | files
Scope: the files this session edited (ledger kept by the peers mod). Env: PEERS_SESSION overrides the session id.`

const session = process.env.PEERS_SESSION || process.env.CLAUDE_CODE_SESSION_ID
if (!cmd || cmd === '-h' || cmd === '--help') die(usage, 0)
if (!session) die('mine: no session id. Run it from a Claude Code session, or set PEERS_SESSION.')

const root = git(['rev-parse', '--show-toplevel']).trim()
const dir = join(homedir(), '.claude', 'peers', encodeURIComponent(root))
const own = join(dir, `${session}.json`)

function die(msg, code = 1) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}
function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}
function load() {
  try {
    return JSON.parse(readFileSync(own, 'utf8'))
  } catch {
    const now = Date.now()
    return { v: 1, session, root, started: now, updated: now, files: {}, commits: [] }
  }
}
function save(l) {
  l.updated = Date.now()
  mkdirSync(dir, { recursive: true })
  writeFileSync(own, JSON.stringify(l))
}
function peers() {
  if (!existsSync(dir)) return []
  const now = Date.now()
  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== `${session}.json`)
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(l => l && !l.ended && now - l.updated < 12 * 3600 * 1000)
}
function nameOf(l) {
  return l.ticket ?? `s-${l.session.slice(0, 4)}`
}
function dirtySet() {
  const out = git(['status', '--porcelain', '-z', '--untracked-files=all'])
  return new Set(out.split('\0').filter(r => r.length > 3).map(r => r.slice(3)))
}
function mineDirty(l) {
  const d = dirtySet()
  return Object.keys(l.files).filter(f => d.has(f))
}
function hasBd() {
  return spawnSync('bd', ['--version'], { stdio: 'ignore' }).status === 0
}
function bd(args) {
  const r = spawnSync('bd', args, { encoding: 'utf8' })
  if (r.status !== 0) process.stderr.write(`bd ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}\n`)
  return r.status === 0
}
function withIndexRetry(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (e) {
      const msg = String(e.stderr || e.message || '')
      if (i < 8 && /index\.lock/.test(msg)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
        continue
      }
      throw e
    }
  }
}

const l = load()

switch (cmd) {
  case 'files': {
    for (const f of Object.keys(l.files)) console.log(f)
    break
  }
  case 'status': {
    const files = Object.keys(l.files)
    const all = dirtySet()
    const peerFiles = new Set(peers().flatMap(p => Object.keys(p.files)))
    const mine = files.filter(f => all.has(f))
    const shared = mine.filter(f => peerFiles.has(f))
    const others = [...all].filter(f => !l.files[f])
    const orphans = others.filter(f => !peerFiles.has(f))
    if (mine.length) process.stdout.write(git(['status', '--short', '--', ...mine]))
    else console.log('nothing of yours is uncommitted')
    const note = []
    if (others.length - orphans.length) note.push(`${others.length - orphans.length} peer file(s) hidden`)
    if (orphans.length) note.push(`${orphans.length} file(s) nobody claims`)
    if (shared.length) note.push(`shared with a peer: ${shared.join(', ')}`)
    if (note.length) console.log(`(${note.join('; ')})`)
    break
  }
  case 'diff': {
    const mine = mineDirty(l)
    if (!mine.length) break
    const r = spawnSync('git', ['diff', 'HEAD', '--', ...mine], { stdio: 'inherit' })
    process.exit(r.status ?? 0)
  }
  case 'commit': {
    const i = argv.indexOf('-m')
    const msg = i > 0 ? argv[i + 1] : null
    if (!msg) die('mine commit -m "message"')
    const mine = mineDirty(l)
    if (!mine.length) die('nothing of yours to commit (edited in this same command? the ledger lands after it ends: run mine commit on its own)')
    const peerFiles = new Set(peers().flatMap(p => Object.keys(p.files)))
    const shared = mine.filter(f => peerFiles.has(f))
    const body = [msg, '', ...(l.ticket ? [`Ticket: ${l.ticket}`] : []), 'Co-Authored-By: Claude <noreply@anthropic.com>'].join('\n')
    withIndexRetry(() => git(['add', '--', ...mine]))
    withIndexRetry(() => git(['commit', '--only', '-q', '-m', body, '--', ...mine]))
    const sha = git(['rev-parse', 'HEAD']).trim()
    l.commits.push({ sha, at: Date.now(), files: mine })
    save(l)
    console.log(`${sha.slice(0, 7)} ${msg} (${mine.length} file${mine.length === 1 ? '' : 's'})`)
    if (shared.length) console.log(`note: also carries a peer's uncommitted lines in: ${shared.join(', ')}`)
    if (l.ticket && hasBd()) bd(['update', l.ticket, '--append-notes', `${sha.slice(0, 7)} ${msg}`])
    break
  }
  case 'check': {
    const last = l.commits.at(-1)
    if (!last) die('no commit of yours yet: mine commit first')
    const wt = join(homedir(), 'worktrees', `${basename(root)}-check`)
    if (!existsSync(wt)) {
      mkdirSync(join(homedir(), 'worktrees'), { recursive: true })
      git(['worktree', 'add', '--detach', wt, last.sha], { stdio: 'inherit' })
    } else {
      git(['-C', wt, 'checkout', '-q', '--detach', last.sha])
    }
    if (existsSync(join(wt, 'pnpm-lock.yaml')) && !existsSync(join(wt, 'node_modules'))) {
      spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: wt, stdio: 'inherit' })
    }
    const gate = join(wt, 'scripts', 'gates.sh')
    const r = existsSync(gate)
      ? spawnSync(gate, ['changed'], { cwd: wt, stdio: 'inherit' })
      : spawnSync('git', ['-C', wt, 'show', '--stat', '--oneline', 'HEAD'], { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  }
  case 'ls': {
    const rows = [{ ...l, me: true }, ...peers()]
    const now = Date.now()
    for (const p of rows) {
      const files = Object.keys(p.files)
      const last = files.reduce((m, f) => Math.max(m, p.files[f].last), p.updated)
      console.log(
        `${p.me ? '*' : ' '} ${nameOf(p).padEnd(12)} ${String(files.length).padStart(3)} files  ${Math.round((now - last) / 60000)}m ago  ${p.commits.length} commits`,
      )
    }
    break
  }
  case 'claim': {
    const id = argv[1]
    if (!id) die('mine claim <ticket>')
    l.ticket = id
    save(l)
    if (hasBd()) bd(['update', id, '--claim'])
    console.log(`claimed ${id}`)
    break
  }
  case 'close': {
    if (!l.ticket) die('no ticket bound: mine claim <ticket> first')
    const i = argv.indexOf('-r')
    const last = l.commits.at(-1)
    const reason = (i > 0 ? argv[i + 1] : 'done') + (last ? ` (${last.sha.slice(0, 7)})` : '')
    if (hasBd()) bd(['close', l.ticket, '-r', reason])
    console.log(`closed ${l.ticket}: ${reason}`)
    delete l.ticket
    save(l)
    break
  }
  default:
    die(usage)
}
