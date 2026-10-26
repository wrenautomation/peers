#!/usr/bin/env node
// mine: git scoped to the files this Claude Code session touched.
// Ledger: ~/.claude/peers/<encodeURIComponent(repo root)>/<session>.json, written by the peers mod.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { applyHunks, keys, owner, parseDiff } from '../lib/lines.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const usage = `mine status | diff | commit -m "msg" [--whole] | check | ls | ready | claim <task> | close [-r reason] | files
Scope: the files this session edited (ledger kept by the peers mod). In a file a peer also edits, only your hunks
(--whole takes the file as it is). Tasks: Backlog.md (\`backlog\` on PATH, board at BACKLOG_CWD).
Env: PEERS_SESSION overrides the session id.`

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
  return execFileSync('git', args, { encoding: 'utf8', stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts })
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
// Task board: Backlog.md. Its auto_commit records each edit in the board's git.
function hasBoard() {
  return spawnSync('backlog', ['--version'], { stdio: 'ignore' }).status === 0
}
function board(args, quiet = true) {
  const r = spawnSync('backlog', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })
  if (r.status !== 0 && quiet) process.stderr.write(`backlog ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}\n`)
  return r.status === 0
}
// Line sets of a file: mine, and every live peer's that has not committed it yet.
function lineSets(f, live) {
  const mine = { added: new Set(l.files[f]?.added ?? []), removed: new Set(l.files[f]?.removed ?? []) }
  const theirs = { added: new Set(), removed: new Set(), who: [] }
  for (const p of live) {
    const e = p.files[f]
    if (!e || p.commits.some(c => c.at >= e.last && c.files.includes(f))) continue
    theirs.who.push(nameOf(p))
    for (const k of e.added ?? []) theirs.added.add(k)
    for (const k of e.removed ?? []) theirs.removed.add(k)
  }
  return { mine, theirs }
}
// Split a dirty file into my hunks and a peer's. `whole` when no peer has uncommitted edits in it,
// or when hunks cannot be split (binary, new, deleted, no final newline).
function split(f, live) {
  const { mine, theirs } = lineSets(f, live)
  if (!theirs.who.length) return { whole: true }
  const d = parseDiff(git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD', '--', f]))
  const cut = !d.binary && d.hunks.length && !d.hunks.some(h => h.noEol) && d.head.every(x => !/^(new|deleted) file/.test(x))
  if (!cut) return { whole: true, who: theirs.who, uncut: true }
  const by = { mine: [], theirs: [], mixed: [] }
  for (const h of d.hunks) by[owner(h, mine, theirs)].push(h)
  return { whole: false, who: theirs.who, head: d.head, ...by }
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
    // Uncommitted only: the list to hand a formatter, `biome check --write $(mine files)`.
    for (const f of mineDirty(l)) console.log(f)
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
    const live = peers()
    for (const f of shared) {
      const s = split(f, live)
      if (s.who) note.push(s.whole ? `${f} shared with ${s.who.join(', ')} (whole file)` : `${f}: ${s.mine.length} hunk(s) yours, ${s.theirs.length} ${s.who.join(', ')}'s${s.mixed.length ? `, ${s.mixed.length} mixed` : ''}`)
    }
    if (note.length) console.log(`(${note.join('; ')})`)
    break
  }
  case 'diff': {
    const mine = mineDirty(l)
    if (!mine.length) break
    const live = peers()
    const parts = mine.map(f => ({ f, s: split(f, live) }))
    const whole = parts.filter(p => p.s.whole).map(p => p.f)
    if (whole.length) process.stdout.write(git(['diff', 'HEAD', '--', ...whole]))
    for (const { f, s } of parts.filter(p => !p.s.whole)) {
      if (!s.mine.length && !s.mixed.length) continue
      console.log([...s.head, ...[...s.mine, ...s.mixed].sort((x, y) => x.a - y.a).flatMap(h => h.text)].join('\n'))
      console.log(`(${f}: ${s.theirs.length} hunk(s) of ${s.who.join(', ')} not shown)`)
    }
    break
  }
  case 'commit': {
    const i = argv.indexOf('-m')
    const msg = i > 0 ? argv[i + 1] : null
    if (!msg) die('mine commit -m "message" [--whole]')
    const mine = mineDirty(l)
    if (!mine.length) die('nothing of yours to commit (edited in this same command? the ledger lands after it ends: run mine commit on its own)')
    const body = [msg, '', ...(l.ticket ? [`Ticket: ${l.ticket}`] : []), 'Co-Authored-By: Claude <noreply@anthropic.com>'].join('\n')
    // A private index built from HEAD: a peer's staged files never ride along, and the
    // update-ref below lands only if HEAD did not move under us.
    const index = git(['rev-parse', '--path-format=absolute', '--git-path', `peers-${session}.index`]).trim()
    const env = { ...process.env, GIT_INDEX_FILE: index }
    let sha
    let notes
    for (let attempt = 0; ; attempt++) {
      notes = []
      const live = peers()
      const head = git(['rev-parse', 'HEAD']).trim()
      git(['read-tree', head], { env })
      const whole = []
      const files = []
      for (const f of mine) {
        const s = argv.includes('--whole') ? { whole: true } : split(f, live)
        if (s.whole) {
          whole.push(f)
          files.push(f)
          if (s.who) notes.push(`${f}: whole file, it also carries uncommitted lines of ${s.who.join(', ')}${s.uncut ? ' (cannot split this file)' : ''}`)
          continue
        }
        const take = [...s.mine, ...s.mixed]
        if (s.theirs.length) notes.push(`${f}: left ${s.theirs.length} hunk(s) of ${s.who.join(', ')} uncommitted`)
        if (s.mixed.length) notes.push(`${f}: ${s.mixed.length} hunk(s) mix your lines with ${s.who.join(', ')}'s; committed whole`)
        if (!take.length) continue
        const blob = git(['hash-object', '-w', '--stdin'], { input: applyHunks(git(['show', `${head}:${f}`]), take) }).trim()
        const mode = git(['ls-tree', head, '--', f]).split(/\s/)[0] || '100644'
        git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${f}`], { env })
        files.push(f)
      }
      if (whole.length) git(['add', '-A', '--', ...whole], { env })
      const tree = git(['write-tree'], { env }).trim()
      if (tree === git(['rev-parse', `${head}^{tree}`]).trim()) die(`nothing of yours to commit${notes.length ? `\n${notes.join('\n')}` : ''}`)
      const commit = git(['commit-tree', tree, '-p', head, '-F', '-'], { input: body }).trim()
      try {
        git(['update-ref', '-m', `commit: ${msg}`, 'HEAD', commit, head])
      } catch (e) {
        if (attempt < 5) continue // a peer committed meanwhile: build again on the new HEAD
        throw e
      }
      sha = commit
      // The shared index catches up for these paths only; a peer's hunks stay in the worktree.
      withIndexRetry(() => git(['reset', '-q', '--', ...files]))
      l.commits.push({ sha, at: Date.now(), files })
      break
    }
    try {
      execFileSync('rm', ['-f', index])
    } catch {}
    // Keep only lines that are still uncommitted: committed ones are no longer anyone's.
    for (const f of mine) {
      const e = l.files[f]
      if (!e?.added && !e?.removed) continue
      const d = parseDiff(git(['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', f]))
      const plus = keys(d.hunks.flatMap(h => h.plus).join('\n'))
      const minus = keys(d.hunks.flatMap(h => h.minus).join('\n'))
      e.added = (e.added ?? []).filter(k => plus.has(k))
      e.removed = (e.removed ?? []).filter(k => minus.has(k))
    }
    save(l)
    spawnSync('git', ['hook', 'run', '--ignore-missing', 'post-commit'], { stdio: 'inherit' })
    const n = l.commits.at(-1).files.length
    console.log(`${sha.slice(0, 7)} ${msg} (${n} file${n === 1 ? '' : 's'})`)
    for (const x of notes) console.log(`note: ${x}`)
    if (l.ticket && hasBoard()) board(['task', 'edit', l.ticket, '--append-notes', `${sha.slice(0, 7)} ${msg}`])
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
  case 'ready': {
    if (!hasBoard()) die('mine ready: backlog not on PATH (npm i -g backlog.md)')
    process.exit(board(['task', 'list', '-s', 'To Do', '--plain'], false) ? 0 : 1)
  }
  case 'claim': {
    const id = argv[1]
    if (!id) die('mine claim <task>')
    if (hasBoard() && !board(['task', 'edit', id, '-s', 'In Progress'])) die(`mine claim: no task ${id}`)
    l.ticket = id
    save(l)
    console.log(`claimed ${id}`)
    break
  }
  case 'close': {
    if (!l.ticket) die('no ticket bound: mine claim <ticket> first')
    const i = argv.indexOf('-r')
    const last = l.commits.at(-1)
    const reason = (i > 0 ? argv[i + 1] : 'done') + (last ? ` (${last.sha.slice(0, 7)})` : '')
    if (hasBoard() && board(['task', 'edit', l.ticket, '-s', 'Done', '--final-summary', reason])) board(['task', 'archive', l.ticket])
    console.log(`closed ${l.ticket}: ${reason}`)
    delete l.ticket
    save(l)
    break
  }
  default:
    die(usage)
}
