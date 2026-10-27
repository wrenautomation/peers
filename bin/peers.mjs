#!/usr/bin/env node
// peers: git scoped to the files this agent session touched.
// Ledger: ~/.claude/peers/<encodeURIComponent(repo root)>/<session>.json, written by the peers mod (Claude Code)
// or by `peers hook <agent>` (Codex, Cursor), both through lib/core.mjs.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { nameOf, uncommitted } from '../lib/core.mjs'
import { applyHunks, keys, owner, parseDiff, statusPaths } from '../lib/lines.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const usage = `peers status | diff [--who [file...]] | commit -m "msg" [--whole] | check | ls | ready | claim <task> | close [-r reason] [--force] | files | view [match...] | tui [match...]
Scope: the files this session edited (ledger kept by the peers mod). In a file a peer also edits, only your hunks
(--whole takes the file as it is). Tasks: Backlog.md (\`backlog\` on PATH, board at BACKLOG_CWD).
view: a live page (127.0.0.1:6421) of every session's uncommitted edits, each in its author's color; /peers-view shows it in a pane.
tui: the same view full screen in any terminal (no agent session needed).
  match: only the repos it names. A path (., ../lander, ~/x) is that folder; a name is a repo name, part of one,
  or a folder in the path (wren_automation = every repo in it). Same words in /peers-view <match...>.
  view --install [--host <public host>] keeps it up under launchd; view --uninstall stops that.
Other agents: peers install codex|cursor [--project] [--uninstall] adds the hooks; the agent runs peers hook <agent>.
Env: PEERS_SESSION overrides the session id.`

if (!cmd || cmd === '-h' || cmd === '--help') die(usage, 0)
if (cmd === 'hook') {
  const { handle } = await import('../lib/hook.mjs')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  // A hook must never stop the agent: any failure answers "go on".
  let out = {}
  try {
    out = (await handle(argv[1], JSON.parse(input), { home: homedir() })).out
  } catch (err) {
    process.stderr.write(`peers hook: ${err?.message ?? err}\n`)
  }
  process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}
if (cmd === 'install') {
  const { AGENTS, install } = await import('../lib/hook.mjs')
  if (!AGENTS[argv[1]]) die(`peers install: one of ${Object.keys(AGENTS).join(', ')}`)
  let root
  if (argv.includes('--project')) root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const path = install(argv[1], { home: homedir(), root, remove: argv.includes('--uninstall') })
  console.log(`${argv.includes('--uninstall') ? 'removed from' : 'hooks in'} ${path}`)
  process.exit(0)
}
const session = process.env.PEERS_SESSION || process.env.CLAUDE_CODE_SESSION_ID || (await import('../lib/hook.mjs')).findSession(homedir())
if (cmd === 'tui') await (await import('../lib/tui.mjs')).tui()
if (cmd === 'view') {
  await (await import('../lib/view.mjs')).view()
  if (!argv.includes('--serve')) process.exit(0)
  await new Promise(() => {}) // the server runs until stopped
}
if (!session) die('peers: no session id. Run it from an agent session (Claude Code, or one with peers install), or set PEERS_SESSION.')

const root = (() => {
  try {
    return git(['rev-parse', '--show-toplevel']).trim()
  } catch {
    die(`peers: ${process.cwd()} is not in a git repo. cd into the repo you work in.`)
  }
})()
// Ledger paths are relative to the root: run every git call from there.
process.chdir(root)
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
    .filter(l => l && !(l.ended && l.updated - l.ended < 5000) && now - l.updated < 12 * 3600 * 1000)
}
function dirtySet() {
  return new Set(statusPaths(git(['status', '--porcelain', '-z', '--untracked-files=all'])))
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
  const theirs = { added: new Set(), removed: new Set(), who: [], blind: false }
  for (const p of live) {
    const e = p.files[f]
    if (!e || p.commits.some(c => c.at >= e.last && c.files.includes(f))) continue
    theirs.who.push(nameOf(p))
    // A peer on an old mod, or whose edits held no distinctive line: nothing to split by.
    if (!e.added?.length && !e.removed?.length) theirs.blind = true
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
  // No line of ours at all: the file is the peers' (a command only brushed it), unless --whole.
  const none = !mine.added.size && !mine.removed.size
  const d = parseDiff(git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD', '--', f]))
  const cut = !d.binary && d.hunks.length && !d.hunks.some(h => h.noEol) && d.head.every(x => !/^(new|deleted) file/.test(x))
  if (!cut) return { whole: true, who: theirs.who, uncut: true, none }
  // A peer with no line data: hunks holding our lines are ours, the rest theirs.
  const by = { mine: [], theirs: [], mixed: [] }
  for (const h of d.hunks) by[owner(h, mine, theirs, theirs.blind)].push(h)
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
    // Uncommitted only: the list to hand a formatter, `biome check --write $(peers files)`.
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
      if (s.who) note.push(s.whole ? `${f} shared with ${s.who.join(', ')} (whole file${s.none ? ', no lines of yours: commit skips it' : ''})` : `${f}: ${s.mine.length} hunk(s) yours, ${s.theirs.length} ${s.who.join(', ')}'s${s.mixed.length ? `, ${s.mixed.length} mixed` : ''}`)
    }
    if (note.length) console.log(`(${note.join('; ')})`)
    break
  }
  case 'diff': {
    if (argv.includes('--who')) {
      // Every hunk of the named files (default: all of yours), headed by whose it is.
      const named = argv.slice(1).filter(a => a !== '--who')
      const live = peers()
      for (const f of named.length ? named : mineDirty(l)) {
        const s = split(f, live)
        if (s.whole) {
          console.log(`# ${f}: whole file, ${s.who ? `yours and ${s.who.join(', ')}'s${s.none ? ' (no lines of yours)' : ''}` : 'yours'}`)
          continue
        }
        const tagged = [...s.mine.map(h => [h, 'yours']), ...s.theirs.map(h => [h, `${s.who.join(', ')}'s`]), ...s.mixed.map(h => [h, 'mixed'])]
        console.log(`# ${f}`)
        for (const [h, who] of tagged.sort((x, y) => x[0].a - y[0].a)) console.log([`## ${who}`, ...h.text].join('\n'))
      }
      break
    }
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
    if (!msg?.trim()) die('peers commit -m "message" [--whole]: the message is empty')
    // A message file a blocked command never rewrote still holds the last one: never reuse it.
    const subject = msg.split('\n')[0].trim()
    const last = l.commits.at(-1)?.sha
    const used = [git(['log', '-1', '--format=%s', 'HEAD']).trim(), last ? spawnSync('git', ['log', '-1', '--format=%s', last], { encoding: 'utf8' }).stdout?.trim() : '']
    if (used.includes(subject)) die(`peers commit: "${subject}" is the subject of the last commit. Write a new message.`)
    const mine = mineDirty(l)
    if (!mine.length) die('nothing of yours to commit (edited in this same command? the ledger lands after it ends: run peers commit on its own)')
    const body = [msg, '', ...(l.ticket ? [`Ticket: ${l.ticket}`] : []), 'Co-Authored-By: Claude <noreply@anthropic.com>'].join('\n')
    // A private index built from HEAD: a peer's staged files never ride along, and the
    // update-ref below lands only if HEAD did not move under us.
    const index = git(['rev-parse', '--path-format=absolute', '--git-path', `peers-${session}.index`]).trim()
    const env = { ...process.env, GIT_INDEX_FILE: index }
    process.on('exit', () => rmSync(index, { force: true }))
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
        if (s.whole && s.none && s.who) {
          notes.push(`${f}: skipped, no lines of yours (${s.who.join(', ')} edited it); --whole takes it`)
          continue
        }
        if (s.whole) {
          whole.push(f)
          files.push(f)
          if (s.who) notes.push(`${f}: whole file, it also carries uncommitted lines of ${s.who.join(', ')}${s.uncut ? ' (cannot split this file)' : s.blind ? ' (no line data for a peer)' : ''}`)
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
    // Keep only lines that are still uncommitted: committed ones are no longer anyone's.
    for (const f of mine) {
      const e = l.files[f]
      if (!e?.added && !e?.removed) continue
      // An untracked file has no diff against HEAD: all its lines are still uncommitted.
      const untracked = git(['ls-files', '--others', '--exclude-standard', '--', f]).trim()
      const d = untracked ? null : parseDiff(git(['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', f]))
      const plus = d ? keys(d.hunks.flatMap(h => h.plus).join('\n')) : existsSync(f) ? keys(readFileSync(f, 'utf8')) : new Set()
      const minus = d ? keys(d.hunks.flatMap(h => h.minus).join('\n')) : new Set()
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
    if (!last) die('no commit of yours yet: peers commit first')
    const wt = join(homedir(), 'worktrees', `${basename(root)}-check`)
    if (!existsSync(wt)) {
      mkdirSync(join(homedir(), 'worktrees'), { recursive: true })
      git(['worktree', 'add', '--detach', wt, last.sha], { stdio: 'inherit' })
    } else {
      git(['-C', wt, 'checkout', '-q', '--detach', last.sha])
    }
    console.log(`peers check: ${wt} at ${git(['-C', wt, 'log', '-1', '--format=%h %s']).trim()}`)
    // Every run: a commit that moves the lockfile or a package.json needs fresh node_modules; a no-op otherwise.
    if (existsSync(join(wt, 'pnpm-lock.yaml'))) {
      const i = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: wt, stdio: 'inherit' })
      if (i.status !== 0) die(`peers check: pnpm install failed in ${wt}`)
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
    const dirty = dirtySet()
    for (const p of rows) {
      // Open files, as the band and the pane count them: dirty and not taken by their own commit since.
      const files = Object.keys(p.files).filter(f => dirty.has(f) && uncommitted(p, f))
      const last = Object.keys(p.files).reduce((m, f) => Math.max(m, p.files[f].last), p.updated)
      console.log(
        `${p.me ? '*' : ' '} ${nameOf(p).padEnd(12)} ${String(files.length).padStart(3)} open  ${Math.round((now - last) / 60000)}m ago  ${p.commits.length} commits`,
      )
    }
    break
  }
  case 'ready': {
    if (!hasBoard()) die('peers ready: backlog not on PATH (npm i -g backlog.md)')
    process.exit(board(['task', 'list', '-s', 'To Do', '--plain'], false) ? 0 : 1)
  }
  case 'claim': {
    const id = argv[1]
    if (!id) die('peers claim <task>')
    if (hasBoard() && !board(['task', 'edit', id, '-s', 'In Progress'])) die(`peers claim: no task ${id}`)
    l.ticket = id
    save(l)
    console.log(`claimed ${id}`)
    break
  }
  case 'close': {
    if (!l.ticket) die('no ticket bound: peers claim <ticket> first')
    const i = argv.indexOf('-r')
    const last = l.commits.at(-1)
    const reason = (i > 0 ? argv[i + 1] : 'done') + (last ? ` (${last.sha.slice(0, 7)})` : '')
    // Big tasks carry acceptance criteria and a DoD per phase: every item is ticked before close.
    if (hasBoard() && !argv.includes('--force')) {
      const view = spawnSync('backlog', ['task', 'view', l.ticket, '--plain'], { encoding: 'utf8' }).stdout ?? ''
      const open = view.split('\n').filter(x => /^\s*- \[ \] #\d+/.test(x))
      if (open.length)
        die(`peers close: ${l.ticket} has ${open.length} unchecked item(s):\n${open.join('\n')}\nTick each: backlog task edit ${l.ticket} --check-ac <n> | --check-dod <n>. --force closes anyway.`)
    }
    if (hasBoard() && board(['task', 'edit', l.ticket, '-s', 'Done', '--final-summary', reason])) board(['task', 'archive', l.ticket])
    console.log(`closed ${l.ticket}: ${reason}`)
    delete l.ticket
    save(l)
    break
  }
  default:
    die(usage)
}
