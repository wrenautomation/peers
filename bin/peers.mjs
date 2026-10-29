#!/usr/bin/env node
// peers: git scoped to the files this agent session touched.
// Ledger: ~/.claude/peers/<encodeURIComponent(repo root)>/<session>.json, written by the peers mod (Claude Code)
// or by `peers hook <agent>` (Codex, Cursor), both through lib/core.mjs.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { actions } from '../lib/actions.mjs'
import { holding, isLive, nameOf } from '../lib/core.mjs'
import { boardOf } from '../lib/board.mjs'
import { configSync, runningSync } from '../lib/io.mjs'
import { slash, winOf } from '../lib/path.mjs'
import { platform } from '../lib/platform.mjs'
import { applyHunks, delta, keys, owner, parseDiff, statusPaths } from '../lib/lines.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const usage = `peers status | diff [--who [file...]] | commit -m "msg" [--whole] [-- paths] | take <file...> | check | ls | ready | claim <task> | close [-r reason] [--force] | log [n] | files | view [match...] | tui [match...]
Scope: the files this session edited (ledger kept by the peers mod). In a file a peer also edits, only your hunks
(--whole takes the file as it is). Tasks: Backlog.md by default (\`backlog\` on PATH), or Jira or your own module: README, Task boards.
view: a live page (127.0.0.1:6421) of every session's uncommitted edits, each in its author's color; /peers-view shows it in a pane.
tui: the same view full screen in any terminal (no agent session needed).
  match: only the repos it names. A path (., ../lander, ~/x) is that folder; a name is a repo name, part of one,
  or a folder in the path (wren_automation = every repo in it). Same words in /peers-view <match...>.
  view --install [--host <public host>] keeps it up (launchd, systemd or the Windows Startup folder); view --uninstall stops that.
  doctor checks node, git, the shim, PATH, the server's version, the supervisor and the board.
Other agents: peers install codex|cursor [--project] [--uninstall] adds the hooks; the agent runs peers hook <agent>.
Output: one summary line; -v lists each file, --json (status, take) prints one object. A file list may be - (read from stdin).
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
if (cmd === 'doctor') process.exit(await (await import('../lib/doctor.mjs')).doctor())
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
    return slash(git(['rev-parse', '--show-toplevel']).trim(), winOf(homedir()))
  } catch {
    die(`peers: ${process.cwd()} is not in a git repo. cd into the repo you work in.`)
  }
})()
// Ledger paths are relative to the root: run every git call from there.
process.chdir(root)
const dir = join(homedir(), '.claude', 'peers', encodeURIComponent(root))
const own = join(dir, `${session}.json`)
// The action log and the board's outbox: lib/actions.mjs.
const act = actions(join(dir, `${session}.actions.jsonl`))

// Output like git's oneline: a summary line by default, each file under -v, a JSON object under --json.
const FLAGS = new Set(['-v', '--verbose', '--json'])
const verbose = argv.includes('-v') || argv.includes('--verbose')
const asJson = argv.includes('--json')
// Paths from args; `-` reads more from stdin, one per line: `git diff --name-only | peers take -`.
function pathsOf(list) {
  const out = []
  for (const a of list) {
    if (FLAGS.has(a)) continue
    if (a === '-') out.push(...readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean))
    else out.push(a)
  }
  return out.map(p => slash(p, winOf(p)).replace(/^\.\//, ''))
}
const few = (xs, n = 3) => xs.slice(0, n).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '')

function die(msg, code = 1) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}
// No optional locks: a read never takes index.lock from a peer's commit or a release script.
function git(args, opts = {}) {
  return execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8', stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts })
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
  const running = runningSync(homedir())
  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== `${session}.json`)
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(l => l && isLive(l, now, running))
}
function dirtySet() {
  return new Set(statusPaths(git(['status', '--porcelain', '-z', '--untracked-files=all'])))
}
function mineDirty(l) {
  const d = dirtySet()
  return Object.keys(l.files).filter(f => d.has(f))
}
// Task board: lib/board.mjs, picked by `board` in ~/.claude/peers/config.json (Backlog.md by default).
const config = configSync(homedir())
// A board that will not load fails its own calls, never `peers status` or `diff`.
const board = await boardOf(config, join(homedir(), '.claude', 'peers')).catch(e => {
  const no = () => {
    throw new Error(`board "${config.board}" did not load: ${e.message}`)
  }
  return { name: String(config.board), on: () => true, ready: no, claim: no, note: no, open: no, openHint: () => '', close: no }
})
// A board call that fails warns and never undoes the git work around it.
const tryBoard = async (what, f) => {
  try {
    return await f()
  } catch (e) {
    process.stderr.write(`peers ${what}: ${e.message}\n`)
    return null
  }
}
// The outbox: board writes that failed go again, oldest first, before the next board call.
const send = (call, args) => board[call](...args)
const drain = async () => {
  for (const r of await act.drain(send))
    if (!r.ok) process.stderr.write(`peers: ${r.s.call} to ${r.s.args[0]} not sent${r.last ? ', gave up' : ', tries again on the next peers command'}: ${r.err}\n`)
}
// Live sessions in any repo that hold a ticket: a task can span repos.
const holders = ticket => {
  const base = join(homedir(), '.claude', 'peers')
  const now = Date.now()
  const running = runningSync(homedir())
  return readdirSync(base, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d =>
      readdirSync(join(base, d.name))
        .filter(f => f.endsWith('.json') && f !== `${session}.json`)
        .map(f => {
          try {
            return JSON.parse(readFileSync(join(base, d.name, f), 'utf8'))
          } catch {
            return null
          }
        }),
    )
    .filter(p => p?.ticket === ticket && isLive(p, now, running))
}
// Line sets of a file: mine, and every live peer's that has not committed it yet.
// f's lines that differ from HEAD: a peer whose lines are all in HEAD (committed by any route) holds nothing.
const liveOf = f => delta(spawnSync('git', ['show', `HEAD:${f}`], { encoding: 'utf8' }).stdout ?? '', existsSync(f) ? readFileSync(f, 'utf8') : '')
function lineSets(f, peers) {
  const mine = { added: new Set(l.files[f]?.added ?? []), removed: new Set(l.files[f]?.removed ?? []) }
  const theirs = { added: new Set(), removed: new Set(), who: [], blind: false }
  let live
  for (const p of peers) {
    const e = p.files[f]
    if (!e || !holding(p, f, (live ??= liveOf(f)))) continue
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
if (['ready', 'claim', 'commit', 'close'].includes(cmd)) await drain()

switch (cmd) {
  case 'take': {
    // The file's uncommitted lines become yours too: for a file a command of a peer took by mistake
    // (it ran while you wrote it). Their ledger keeps it; a line you both hold counts as yours in commit.
    const named = pathsOf(argv.slice(1))
    if (!named.length) die('peers take <file...|->: name the files, or - to read them from stdin')
    const dirty = dirtySet()
    const now = Date.now()
    const took = []
    const skipped = named.filter(f => !dirty.has(f))
    for (const f of named.filter(f => dirty.has(f))) {
      const untracked = git(['ls-files', '--others', '--exclude-standard', '--', f]).trim()
      const d = untracked ? null : parseDiff(git(['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', f]))
      const added = [...(d ? keys(d.hunks.flatMap(h => h.plus).join('\n')) : existsSync(f) ? keys(readFileSync(f, 'utf8')) : [])]
      const removed = [...(d ? keys(d.hunks.flatMap(h => h.minus).join('\n')) : [])]
      const e = (l.files[f] ??= { first: now })
      Object.assign(e, { from: now, last: now, named: true, added, removed })
      took.push({ file: f, added: added.length, removed: removed.length })
    }
    if (took.length) {
      save(l)
      act.log('take', { files: took.map(t => t.file) })
    }
    if (asJson) console.log(JSON.stringify({ took, skipped }))
    else {
      if (verbose) for (const t of took) console.log(`${t.file}: +${t.added} -${t.removed} lines, now yours`)
      const sum = (k) => took.reduce((n, t) => n + t[k], 0)
      if (took.length) console.log(`took ${took.length} file${took.length === 1 ? '' : 's'} (+${sum('added')} -${sum('removed')} lines)`)
      if (skipped.length) process.stderr.write(`skipped ${skipped.length}, no uncommitted change (paths are from the repo root): ${few(skipped)}\n`)
    }
    if (!took.length) process.exitCode = 1
    break
  }
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
    const live = peers()
    const sh = shared.map(f => ({ f, s: split(f, live) })).filter(x => x.s.who)
    if (asJson) {
      console.log(JSON.stringify({
        mine,
        shared: sh.map(({ f, s }) => ({ file: f, with: s.who, whole: !!s.whole, none: !!s.none, mine: s.mine?.length ?? 0, theirs: s.theirs?.length ?? 0, mixed: s.mixed?.length ?? 0 })),
        hidden: others.length - orphans.length,
        orphans,
      }))
      break
    }
    const CAP = 20
    if (mine.length) {
      const rows = git(['status', '--short', '--', ...mine]).trimEnd().split('\n')
      console.log((verbose ? rows : rows.slice(0, CAP)).join('\n'))
      if (!verbose && rows.length > CAP) console.log(`... ${rows.length - CAP} more (-v)`)
    } else console.log('nothing of yours is uncommitted')
    const note = []
    if (others.length - orphans.length) note.push(`${others.length - orphans.length} peer file(s) hidden`)
    if (orphans.length) note.push(`${orphans.length} file(s) nobody claims`)
    const whole = sh.filter(x => x.s.whole)
    const none = whole.filter(x => x.s.none)
    if (verbose)
      for (const { f, s } of sh)
        note.push(s.whole ? `${f} shared with ${s.who.join(', ')} (whole file${s.none ? ', no lines of yours: commit skips it' : ''})` : `${f}: ${s.mine.length} hunk(s) yours, ${s.theirs.length} ${s.who.join(', ')}'s${s.mixed.length ? `, ${s.mixed.length} mixed` : ''}`)
    else if (sh.length) {
      const who = [...new Set(sh.flatMap(x => x.s.who))].join(', ')
      note.push(`${sh.length} shared with ${who}: ${sh.length - whole.length} by hunk, ${whole.length} whole` + (none.length ? `, ${none.length} with no lines of yours (commit skips them: ${few(none.map(x => x.f))})` : '') + ' (-v for each)')
    }
    if (note.length) console.log(`(${note.join('; ')})`)
    break
  }
  case 'diff': {
    if (argv.includes('--who')) {
      // Every hunk of the named files (default: all of yours), headed by whose it is.
      const named = pathsOf(argv.slice(1).filter(a => a !== '--who'))
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
    // Our last commit counts only while HEAD holds it: after a reset it is gone, and its subject is free again.
    const held = last && spawnSync('git', ['merge-base', '--is-ancestor', last, 'HEAD']).status === 0
    const used = [git(['log', '-1', '--format=%s', 'HEAD']).trim(), held ? spawnSync('git', ['log', '-1', '--format=%s', last], { encoding: 'utf8' }).stdout?.trim() : '']
    if (used.includes(subject)) die(`peers commit: "${subject}" is the subject of the last commit. Write a new message.`)
    // `-- <paths>`: only these of your files (with --whole, a regenerated file stays out).
    // --whole with paths: every dirty file under them, in the ledger or not (an untracked file it missed).
    const dash = argv.indexOf('--')
    const only = dash > 0 ? pathsOf(argv.slice(dash + 1)).map(p => p.replace(/\/$/, '')) : null
    const under = f => only.some(p => f === p || f.startsWith(`${p}/`))
    const mine = only && argv.includes('--whole') ? [...dirtySet()].filter(under) : mineDirty(l).filter(f => !only || under(f))
    if (!mine.length) die(only ? `none of ${only.join(', ')} is an uncommitted file of yours (peers status)` : 'nothing of yours to commit (edited in this same command? the ledger lands after it ends: run peers commit on its own)')
    const body = [msg, '', ...(l.ticket ? [`Ticket: ${l.ticket}`] : [])].join('\n')
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
    // An edit's line keys find its hunk's title while the hunk is uncommitted. Once committed they only fill
    // the ledger (whole lines, rewritten on each edit): keep the time and title, drop the keys.
    for (const [f, e] of Object.entries(l.files)) {
      if (!e.edits?.some(x => x.k?.length)) continue
      const left = l.commits.some(c => c.at >= e.last && c.files.includes(f)) ? new Set() : new Set([...(e.added ?? []), ...(e.removed ?? [])])
      for (const x of e.edits) x.k = (x.k ?? []).filter(k => left.has(k))
    }
    save(l)
    spawnSync('git', ['hook', 'run', '--ignore-missing', 'post-commit'], { stdio: 'inherit' })
    // Co-author and session trailers add nothing to the board or the log.
    const told = msg.replace(/^(Co-Authored-By|Claude-Session):.*\n?/gim, '').trimEnd()
    const n = l.commits.at(-1).files.length
    console.log(`${sha.slice(0, 7)} ${told} (${n} file${n === 1 ? '' : 's'})`)
    for (const x of verbose ? notes : notes.slice(0, 3)) console.log(`note: ${x}`)
    if (!verbose && notes.length > 3) console.log(`note: ${notes.length - 3} more (-v)`)
    act.log('commit', { sha, files: l.commits.at(-1).files, ticket: l.ticket, t: told.split('\n')[0] })
    if (l.ticket) {
      const r = await act.send('note', [l.ticket, `${sha.slice(0, 7)} ${told}`], send)
      if (!r.ok) process.stderr.write(`peers commit: note to ${l.ticket} not sent, tries again on the next peers command: ${r.err}\n`)
    }
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
      const pn = platform(process.platform).npmCommand('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'])
      const i = spawnSync(pn.cmd, pn.args, { cwd: wt, stdio: 'inherit', shell: pn.shell })
      if (i.status !== 0) die(`peers check: pnpm install failed in ${wt}`)
    }
    // `check` in the config (a shell line, as `npm test`), else the repo's gate script, else the commit's stat.
    // The gate goes through bash: Windows runs no .sh by itself (Git for Windows brings bash).
    const gate = join(wt, 'scripts', 'gates.sh')
    const r = config.check
      ? spawnSync(config.check, { cwd: wt, stdio: 'inherit', shell: true })
      : existsSync(gate)
        ? spawnSync('bash', [gate, 'changed'], { cwd: wt, stdio: 'inherit' })
        : spawnSync('git', ['-C', wt, 'show', '--stat', '--oneline', 'HEAD'], { stdio: 'inherit' })
    act.log('check', { sha: last.sha, status: r.status ?? 1 })
    process.exit(r.status ?? 1)
  }
  case 'ls': {
    const rows = [{ ...l, me: true }, ...peers()]
    const now = Date.now()
    const dirty = dirtySet()
    for (const p of rows) {
      // Open files, as the band and the guard count them: dirty, not taken by their own commit, lines not in HEAD.
      const files = Object.keys(p.files).filter(f => dirty.has(f) && holding(p, f, liveOf(f)))
      const last = Object.keys(p.files).reduce((m, f) => Math.max(m, p.files[f].last), p.updated)
      console.log(
        `${p.me ? '*' : ' '} ${nameOf(p).padEnd(12)} ${String(files.length).padStart(3)} open  ${Math.round((now - last) / 60000)}m ago  ${p.commits.length} commits`,
      )
    }
    break
  }
  case 'ready': {
    const out = await tryBoard('ready', () => board.ready())
    if (out === null) process.exit(1)
    console.log(String(out).trimEnd())
    break
  }
  case 'claim': {
    if (!argv[1]) die('peers claim <task>')
    // Jira keys are upper case: a trailer with `proj-1` links to nothing.
    const id = board.key ? board.key(argv[1]) : argv[1]
    let got
    try {
      got = await board.claim(id)
    } catch (e) {
      die(`peers claim: no task ${id} (${e.message})`)
    }
    l.ticket = id
    // The title travels in the ledger: the views show it without asking the board.
    if (got?.title) l.title = got.title
    else delete l.title
    save(l)
    act.log('claim', { ticket: id, title: got?.title ?? null })
    console.log(`claimed ${id}`)
    break
  }
  case 'close': {
    if (!l.ticket) die('no ticket bound: peers claim <ticket> first')
    const i = argv.indexOf('-r')
    const last = l.commits.at(-1)
    const reason = (i > 0 ? argv[i + 1] : 'done') + (last ? ` (${last.sha.slice(0, 7)})` : '')
    if (!argv.includes('--force')) {
      const still = holders(l.ticket)
      if (still.length) die(`peers close: ${still.map(nameOf).join(', ')} also works on ${l.ticket}. Close it there last, or --force.`)
      const open = (await tryBoard('close', () => board.open(l.ticket))) ?? []
      if (open.length) die(`peers close: ${l.ticket} has ${open.length} unchecked item(s):\n${open.join('\n')}\n${board.openHint(l.ticket)} --force closes anyway.`)
    }
    if ((await tryBoard('close', () => board.close(l.ticket, reason))) === null && board.on()) die(`peers close: ${l.ticket} stays bound; fix the board error, then run it again.`)
    act.log('close', { ticket: l.ticket, reason })
    console.log(`closed ${l.ticket}: ${reason}`)
    delete l.ticket
    delete l.title
    save(l)
    break
  }
  case 'log': {
    // The trace: this session's last actions, oldest first.
    const n = Number(argv[1]) || 20
    const sends = new Map()
    for (const a of act.read().slice(-n * 3)) {
      const t = new Date(a.at).toLocaleString('sv-SE').slice(5, 16)
      if (a.op === 'send') sends.set(a.id, a)
      const s = a.op === 'sent' ? sends.get(a.id) : null
      const what =
        a.op === 'send' ? null
        : a.op === 'sent' ? `${s?.call ?? 'send'} ${s?.args?.[0] ?? ''} ${a.ok ? 'sent' : `failed: ${a.err}`}`
        : a.op === 'commit' ? `commit ${a.sha.slice(0, 7)} ${a.t ?? ''}${a.ticket ? ` (${a.ticket})` : ''}`
        : a.op === 'check' ? `check ${a.sha.slice(0, 7)} ${a.status === 0 ? 'passed' : `failed (${a.status})`}`
        : a.op === 'claim' ? `claim ${a.ticket}${a.title ? ` ${a.title}` : ''}`
        : a.op === 'close' ? `close ${a.ticket}: ${a.reason}`
        : a.op === 'take' ? `take ${a.files.join(', ')}`
        : a.op
      if (what) console.log(`${t}  ${what}`)
    }
    const p = act.pending()
    if (p.length) console.log(`${p.length} board write(s) wait to send: ${p.map(s => `${s.call} ${s.args[0]}`).join(', ')}`)
    break
  }
  default:
    die(usage)
}
