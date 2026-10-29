// node lib/core.test.mjs — lib/core.mjs and the agent hooks (lib/hook.mjs) against real temp repos.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { core, isLive, nameOf, runningOf } from './core.mjs'
import { handle, install } from './hook.mjs'
import { nodeIo } from './io.mjs'
import { delta } from './lines.mjs'
import { isAbs, slash, winOf } from './path.mjs'
import { pick, terms } from './rows.mjs'

// One spelling on Windows too: core keys ledgers by git's root, `C:/x` with long names (native expands `RUNNER~1`).
const tmp = slash(realpathSync.native(mkdtempSync(`${tmpdir()}/peers-core-`)), process.platform === 'win32')
const home = `${tmp}/home`
const root = `${tmp}/repo`
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' })
mkdirSync(root, { recursive: true })
git('init', '-q')
writeFileSync(`${root}/a.txt`, 'first line here\nsecond line here\n')
writeFileSync(`${root}/b.txt`, 'bee line one\n')
git('add', '.')
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

const ledger = s => JSON.parse(readFileSync(`${home}/.claude/peers/${encodeURIComponent(root)}/${s}.json`, 'utf8'))
const peer = (session, files) => {
  const now = Date.now()
  const path = `${home}/.claude/peers/${encodeURIComponent(root)}/${session}.json`
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
  writeFileSync(path, JSON.stringify({ v: 1, session, root, started: now, updated: now, files, commits: [] }))
}
const results = []
const check = (name, got, want) => results.push([name, JSON.stringify(got) === JSON.stringify(want), got, want])

// Claude Code's path: the mod binds core to `$`; here to node.
const c = core({ home, session: 'claude-1' })
const k = c(nodeIo)

await k.record(root, ['a.txt'], new Map([['a.txt', delta('first line here\n', 'first line changed\n')]]), 'Change the first line')
const l1 = ledger('claude-1')
check('Edit: lines added and removed', [l1.files['a.txt'].added, l1.files['a.txt'].removed], [['first line changed'], ['first line here']])
check('Edit: the title', l1.files['a.txt'].edits[0].t, 'Change the first line')
check('Claude session name', nameOf(l1), 'cc-clau')

// A command edits a file that was already dirty: the delta is the command's lines only.
writeFileSync(`${root}/a.txt`, 'first line changed\nsecond line here\n')
let snap = await k.before([root])
snap.at = Date.now()
appendFileSync(`${root}/a.txt`, 'third line by bash\n')
check('Bash on a dirty file: no peer hit', await k.after(snap, 'Append a line'), [])
check('Bash on a dirty file: its line only', ledger('claude-1').files['a.txt'].added, ['first line changed', 'third line by bash'])

check('openFiles: the dirty paths', [...(await k.openFiles(root))].sort(), ['a.txt'])

// WA-933: a Write into a folder that does not exist yet still finds the repo, and an Edit after it too.
{
  const kn = core({ home, session: 'claude-new' })(nodeIo)
  check('new folder: the repo from its parent', await kn.locate(`${root}/map/system/w.c4`), { root, rel: 'map/system/w.c4' })
  mkdirSync(`${root}/map/system`, { recursive: true })
  check('new folder: found again once made', (await kn.locate(`${root}/map/system/w.c4`))?.rel, 'map/system/w.c4')
  check('outside a repo: none', await kn.locate(`${tmp}/elsewhere/x.md`), null)
  rmSync(`${root}/map`, { recursive: true, force: true })
}

// A command makes a clean file dirty: the delta is against HEAD.
snap = await k.before([root])
snap.at = Date.now()
writeFileSync(`${root}/b.txt`, 'bee line one\nbee line two\n')
await k.after(snap)
check('Bash on a clean file: delta against HEAD', ledger('claude-1').files['b.txt'].added, ['bee line two'])

// A command makes a new file: every line added.
snap = await k.before([root])
snap.at = Date.now()
writeFileSync(`${root}/n.txt`, 'new by bash\n')
await k.after(snap)
check('Bash new file: its lines', ledger('claude-1').files['n.txt'].added, ['new by bash'])
rmSync(`${root}/n.txt`)

// A peer's uncommitted file: staging it all is denied, a status is not.
writeFileSync(`${root}/c.txt`, 'peer line here\n')
peer('peer-2', { 'c.txt': { first: 1, last: Date.now() - 10_000, added: ['peer line here'], removed: [] } })
snap = await k.before([root])
check('guard: git add -A reaches the peer file', /c\.txt \(cc-peer\)/.test((await k.guard('git add -A', root, snap)) ?? ''), true)
check('guard: git status passes', await k.guard('git status', root, snap), null)
check('guard: git add of our own file passes', await k.guard('git add a.txt', root, snap), null)

// A whole-file write that drops the peer's line is denied.
const deny = await k.writeDeny(root, 'c.txt', delta('peer line here\n', 'mine only now\n'))
check('Write deny: names the peer and the line', /cc-peer \(`peer line here`\)/.test(deny ?? ''), true)
check('Write keep: passes', await k.writeDeny(root, 'c.txt', delta('peer line here\n', 'peer line here\nmine too\n')), null)

// A command that changes the peer's file warns.
snap = await k.before([root])
snap.at = Date.now()
appendFileSync(`${root}/c.txt`, 'bash line in peer file\n')
check('Bash hit on a peer file: warned', await k.after(snap), ['c.txt (cc-peer)'])

// session end: the ledger stops counting as live.
k.roots.add(root)
await k.end()
check('end: ended set', typeof ledger('claude-1').ended, 'number')

// Codex: Bash pre and post, in two processes' worth of state.
const S = 'cdx-0001'
const cx = (ev, extra) => handle('codex', { hook_event_name: ev, session_id: S, cwd: root, tool_use_id: 't1', ...extra }, { home, pid: 0 })
check('codex start', (await cx('SessionStart', {})).out, {})
check('codex pre Bash', (await cx('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo codex line one >> b.txt' } })).out, {})
appendFileSync(`${root}/b.txt`, 'codex line one\n')
check('codex post Bash', (await cx('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo' }, tool_response: '' })).out, {})
const lc = ledger(`codex_${S}`)
check('codex: the line recorded', lc.files['b.txt'].added, ['codex line one'])
check('codex: agent and name', [lc.agent, nameOf(lc)], ['codex', 'codex-cdx-'])
const cd = await cx('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git add -A' } })
check('codex: guard deny', cd.out.hookSpecificOutput?.permissionDecision, 'deny')
// apply_patch names its files: a clean file it edits is recorded.
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'two')
const patch = '*** Begin Patch\n*** Update File: b.txt\n@@\n+patched in by codex\n*** End Patch\n'
await cx('PreToolUse', { tool_name: 'apply_patch', tool_use_id: 't2', tool_input: { command: patch } })
appendFileSync(`${root}/b.txt`, 'patched in by codex\n')
await cx('PostToolUse', { tool_name: 'apply_patch', tool_use_id: 't2', tool_input: { command: patch } })
check('codex apply_patch: recorded', ledger(`codex_${S}`).files['b.txt'].added.includes('patched in by codex'), true)
await cx('SessionEnd', {})
check('codex end: ended set', typeof ledger(`codex_${S}`).ended, 'number')

// Cursor: Write pre and post; a Write that drops a peer's line is denied.
const cu = (ev, extra) =>
  handle('cursor', { hook_event_name: ev, conversation_id: 'cur-0001', workspace_roots: [root], cwd: '', tool_use_id: 'u1', ...extra }, { home, pid: 0 })
const w = await cu('preToolUse', { tool_name: 'Write', tool_input: { file_path: `${root}/c.txt`, content: 'cursor only\n' } })
check('cursor: Write deny', [w.out.permission, /cc-peer/.test(w.out.agent_message)], ['deny', true])
await cu('preToolUse', { tool_name: 'Write', tool_input: { file_path: `${root}/d.txt`, content: 'cursor new file\n' } })
writeFileSync(`${root}/d.txt`, 'cursor new file\n')
await cu('postToolUse', { tool_name: 'Write', tool_input: { file_path: `${root}/d.txt` } })
check('cursor: new file recorded', ledger('cursor_cur-0001').files['d.txt'].added, ['cursor new file'])
check('cursor: Read is skipped', (await cu('preToolUse', { tool_name: 'Read', tool_input: { file_path: `${root}/a.txt` } })).out, {})
check('cursor: snapshot cleaned up', existsSync(`${home}/.claude/peers-run/snap/cursor_cur-0001-u1.json`), false)

// install merges into an existing config, once, and uninstall takes only ours out.
mkdirSync(`${home}/.cursor`, { recursive: true })
writeFileSync(`${home}/.cursor/hooks.json`, JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'theirs' }] } }))
install('cursor', { home })
install('cursor', { home })
const cfg = JSON.parse(readFileSync(`${home}/.cursor/hooks.json`, 'utf8'))
check('install: kept theirs, added ours once', cfg.hooks.preToolUse.map(h => h.command), ['theirs', process.platform === 'win32' ? `${home.replace(/\//g, '\\')}\\.local\\bin\\peers.cmd hook cursor` : `${home}/.local/bin/peers hook cursor`])
install('cursor', { home, remove: true })
check('uninstall: only theirs left', JSON.parse(readFileSync(`${home}/.cursor/hooks.json`, 'utf8')).hooks, { preToolUse: [{ command: 'theirs' }] })
install('codex', { home })
check('install codex: four events', Object.keys(JSON.parse(readFileSync(`${home}/.codex/hooks.json`, 'utf8')).hooks), ['SessionStart', 'PreToolUse', 'PostToolUse', 'SessionEnd'])

// What a session is on: its task's title (open or archived), else its transcript's title, the person's name first.
const board = `${tmp}/board/backlog`
mkdirSync(`${board}/tasks`, { recursive: true })
mkdirSync(`${board}/archive/tasks`, { recursive: true })
writeFileSync(`${board}/tasks/wa-1 - Ship-the-thing.md`, '')
writeFileSync(`${board}/archive/tasks/wa-2 - Old-work.md`, '')
const proj = `${home}/.claude/projects/-x`
mkdirSync(proj, { recursive: true })
writeFileSync(`${proj}/uuid-1.jsonl`, '{"type":"ai-title","aiTitle":"Made by \\"Claude\\""}\n{"type":"user"}\n')
writeFileSync(`${proj}/uuid-2.jsonl`, '{"type":"custom-title","customTitle":"mine"}\n{"type":"ai-title","aiTitle":"later"}\n')
const t = core({ home, session: 'x', backlog: `${tmp}/board` })(nodeIo)
check('title: open task', await t.sessionTitle({ session: 'uuid-1', ticket: 'WA-1' }), 'Ship the thing')
check('title: archived task', await t.sessionTitle({ session: 'uuid-1', ticket: 'wa-2' }), 'Old work')
check('title: the made title', await t.sessionTitle({ session: 'uuid-1' }), 'Made by "Claude"')
check('title: the person\'s name beats a later made one', await t.sessionTitle({ session: 'uuid-2' }), 'mine')
check('title: no transcript', await t.sessionTitle({ session: 'uuid-3' }), null)
check('title: other agents have none', await t.sessionTitle({ session: 'codex_uuid-1' }), null)

// Caches: a peer's ledger is parsed once per change; git status runs again only when the index, HEAD or a ledger moved.
{
  let runs = 0
  let reads = 0
  const ck = core({ home, session: 'claude-1' })({
    ...nodeIo,
    run: argv => (argv.includes('status') && runs++, nodeIo.run(argv, { timeoutMs: 10000 })),
    read: p => (p.includes('cache-peer') && reads++, nodeIo.read(p)),
  })
  peer('cache-peer', { 'a.txt': { first: 1, last: Date.now(), added: ['x'] } })
  await ck.peersOf(root)
  await ck.peersOf(root)
  check('cache: an unchanged ledger is parsed once', reads, 1)
  peer('cache-peer', { 'a.txt': { first: 1, last: Date.now(), added: ['x', 'y'] } })
  check('cache: a changed ledger is parsed again', (await ck.peersOf(root)).find(p => p.session === 'cache-peer').files['a.txt'].added, ['x', 'y'])
  await ck.openFiles(root, 's1')
  await ck.openFiles(root, 's1')
  check('cache: git status once for one sig', runs, 1)
  await ck.openFiles(root, 's2')
  check('cache: git status again for a new sig', runs, 2)
  writeFileSync(`${root}/c.txt`, 'cee\n')
  git('add', 'c.txt')
  await ck.openFiles(root, 's2')
  check('cache: git status again when the index moved', runs, 3)
  git('rm', '-q', '--cached', 'c.txt')
  rmSync(`${root}/c.txt`)
  await ck.openFiles(root)
  check('cache: no sig, no cache', runs, 4)
  rmSync(`${home}/.claude/peers/${encodeURIComponent(root)}/cache-peer.json`)
}

// peers commit: a committed edit keeps its time and title, not its line keys.
{
  const ch = `${tmp}/ch`
  const cr = `${tmp}/crepo`
  const cg = (...a) => execFileSync('git', ['-C', cr, ...a], { encoding: 'utf8' })
  mkdirSync(cr, { recursive: true })
  cg('init', '-q')
  writeFileSync(`${cr}/f.txt`, 'one line\n')
  cg('add', '.')
  cg('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  const rr = slash(realpathSync.native(cr), process.platform === 'win32')
  writeFileSync(`${cr}/f.txt`, 'one line\nan added line\n')
  const ck = core({ home: ch, session: 'cm-1' })(nodeIo)
  await ck.record(rr, ['f.txt'], new Map([['f.txt', delta('one line\n', 'one line\nan added line\n')]]), 'Add a line')
  execFileSync(process.execPath, [new URL('../bin/peers.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'commit', '-m', 'add'], {
    cwd: cr,
    env: { ...process.env, HOME: ch, USERPROFILE: ch, PEERS_SESSION: 'cm-1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    stdio: 'pipe',
  })
  const cl = JSON.parse(readFileSync(`${ch}/.claude/peers/${encodeURIComponent(rr)}/cm-1.json`, 'utf8'))
  check('commit: the edit keeps its title and drops its keys', cl.files['f.txt'].edits.map(x => [x.t, x.k]), [['Add a line', []]])
}

// A peer's lines committed with plain git: it holds nothing, though its ledger has no commit.
{
  const now = Date.now()
  writeFileSync(`${root}/plain.txt`, 'peer wrote this line\n')
  git('add', 'plain.txt')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'plain')
  peer('plain-git', { 'plain.txt': { first: now, from: now, last: now, added: ['peer wrote this line'], removed: [] } })
  writeFileSync(`${root}/plain.txt`, 'peer wrote this line\nmy own new line\n')
  const kp = core({ home, session: 'me-plain' })(nodeIo)
  const s = await kp.before([root])
  check('plain git commit: guard sees no peer file', (s.peer[root] ?? []).filter(([r]) => r === 'plain.txt'), [])
  check('plain git commit: Write may drop the line', await kp.writeDeny(root, 'plain.txt', delta('peer wrote this line\n', 'x line here\n')), null)
  const pl = ledger('plain-git')
  check('plain git commit: band lists no open file', await kp.heldFiles(root, pl, new Set(['plain.txt'])), [])
  writeFileSync(`${root}/plain.txt`, 'peer wrote this line\npeer second line\n')
  peer('plain-git', { 'plain.txt': { first: now, from: now, last: now, added: ['peer wrote this line', 'peer second line'], removed: [] } })
  const s2 = await kp.before([root])
  check('peer line not in HEAD: still held', (s2.peer[root] ?? []).filter(([r]) => r === 'plain.txt').length, 1)
  // mtime may not move within the same ms: the cache key also has the size.
  check('peer line not in HEAD: band lists it', await kp.heldFiles(root, ledger('plain-git'), new Set(['plain.txt'])), ['plain.txt'])
  writeFileSync(`${root}/plain.txt`, 'peer wrote this line\n')
}

// WA-936: /resume gives the process a new id; the old id's ledger merges into it, ended and empty.
{
  peer('res-new', { 'b.txt': { first: 1, from: 1, last: 2, added: ['bee old line'], removed: [] } })
  const kr = core({ home, session: 'res-old' })(nodeIo)
  await kr.record(root, ['b.txt', 'n.txt'], new Map([['b.txt', delta('', 'bee new line\n')]]), 'Edit b')
  await kr.rename('res-new')
  const n = ledger('res-new')
  check('rename: lines of both ids', [n.files['b.txt'].added, Object.keys(n.files).sort()], [['bee old line', 'bee new line'], ['b.txt', 'n.txt']])
  check('rename: old ledger empty and ended', [Object.keys(ledger('res-old').files).length, !!ledger('res-old').ended, ledger('res-old').into], [0, true, 'res-new'])
  check('rename: own path follows', kr.ownPath(root).endsWith('/res-new.json'), true)
}

rmSync(tmp, { recursive: true, force: true })
let bad = 0
// Live: the running list decides; an end mark alone lets a late write bring a closed session back.
{
  const now = 1e12
  const l = { session: 'a', files: { x: {} }, updated: now - 1000, ended: now - 600_000 }
  const running = runningOf(['{"sessionId":"b"}', 'not json'])
  check('live: closed session written after its end', isLive(l, now, running), false)
  check('live: running session', isLive({ ...l, session: 'b' }, now, running), true)
  check('live: a parked terminal is gone; its job runs on', [...runningOf(['{"sessionId":"p","parkedJobId":"j"}', '{"sessionId":"j"}'])], ['j'])
  check('live: no list, end mark decides', isLive(l, now, null), true)
  check('live: empty ledger never', isLive({ ...l, session: 'b', files: {} }, now, running), false)
  check('running: no ids is null', runningOf(['{}']), null)
  check('live: codex session not in the list', isLive({ ...l, session: 'codex_x', agent: 'codex', ended: undefined }, now, running), true)
}

// Windows: tools give `c:\x`, Git Bash `/c/x`, git `C:/x`. All meet as `C:/x`; macOS paths stay as given.
{
  check('win: home shape', [winOf('C:\\Users\\w'), winOf('/Users/w'), winOf(undefined)], [true, false, false])
  check('win: one spelling', ['c:\\Users\\w\\a.ts', '/c/Users/w', 'C:/x', '/c'].map(p => slash(p, true)), ['C:/Users/w/a.ts', 'C:/Users/w', 'C:/x', 'C:'])
  check('win: macOS paths untouched', [slash('/c/x', false), slash('a\\b', false)], ['/c/x', 'a\\b'])
  check('win: absolute', [isAbs('C:/x'), isAbs('/x'), isAbs('x/y'), isAbs('C:x')], [true, true, false, false])
  const wh = 'C:\\Users\\w'
  check('win: terms', terms(['.', '..\\lander', '~/tasks', 'D:\\repo', 'wren'], 'c:\\Users\\w\\wa\\wren', wh), ['C:/Users/w/wa/wren', 'C:/Users/w/wa/lander', 'C:/Users/w/tasks', 'D:/repo', 'wren'])
  const repos = [{ root: 'C:/Users/w/wa/wren' }, { root: 'C:/Users/w/wa/lander' }]
  check('win: pick by folder and name', [pick(repos, ['C:/Users/w/wa/lander'], 'C:/Users/w'), pick(repos, ['wa'], 'C:/Users/w').length], [[repos[1]], 2])
  // A fake io: git prints `C:/...` for any dir under the repo.
  const R = 'C:/Users/w/repo'
  const runs = []
  const wio = {
    ...nodeIo,
    run: async argv => {
      runs.push(argv)
      if (argv[0] === 'perl') throw new Error('ENOENT')
      const dir = slash(argv[argv.indexOf('-C') + 1], true)
      return dir === R || dir.startsWith(`${R}/`) ? { exitCode: 0, stdout: `${R}\n` } : { exitCode: 128, stdout: '' }
    },
  }
  const wk = core({ home: wh, session: 'claude-w' })(wio)
  check('win: locate a tool path', await wk.locate('c:\\Users\\w\\repo\\src\\a.ts'), { root: R, rel: 'src/a.ts' })
  check('win: ledger dir', wk.ledgerDir(R), `C:/Users/w/.claude/peers/${encodeURIComponent(R)}`)
  check('win: Git Bash path in a command', (await wk.commandRoots('cat /c/Users/w/repo/a.ts', 'C:\\elsewhere')).includes(R), true)
  check('win: drive path in a command', (await wk.commandRoots('cat C:\\Users\\w\\repo\\a.ts', 'C:\\elsewhere')).includes(R), true)
}

// No perl (Windows): the titles come from a scan in JS.
{
  const th = `${tmp}/th`
  const tdir = `${th}/.claude/projects/x`
  mkdirSync(tdir, { recursive: true })
  writeFileSync(`${tdir}/s-1.jsonl`, '{"type":"ai-title","aiTitle":"first"}\n{"customTitle":"Say \\"hi\\""}\n{"aiTitle":"second"}\n')
  const tk = core({ home: th, session: 'x' })({ ...nodeIo, run: async argv => { if (argv[0] === 'perl') throw new Error('ENOENT'); return nodeIo.run(argv) } })
  check('no perl: titles', [await tk.sessionLabel({ session: 's-1' }), await tk.sessionAbout({ session: 's-1' })], ['Say "hi"', 'second'])
}

for (const [name, ok, got, want] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
process.exit(bad ? 1 : 0)
