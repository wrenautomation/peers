// node lib/core.test.mjs — lib/core.mjs and the agent hooks (lib/hook.mjs) against real temp repos.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { core, nameOf } from './core.mjs'
import { handle, install } from './hook.mjs'
import { nodeIo } from './io.mjs'
import { delta } from './lines.mjs'

const tmp = realpathSync(mkdtempSync(`${tmpdir()}/peers-core-`))
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
check('Claude session name', nameOf(l1), 's-clau')

// A command edits a file that was already dirty: the delta is the command's lines only.
writeFileSync(`${root}/a.txt`, 'first line changed\nsecond line here\n')
let snap = await k.before([root])
snap.at = Date.now()
appendFileSync(`${root}/a.txt`, 'third line by bash\n')
check('Bash on a dirty file: no peer hit', await k.after(snap, 'Append a line'), [])
check('Bash on a dirty file: its line only', ledger('claude-1').files['a.txt'].added, ['first line changed', 'third line by bash'])

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
check('guard: git add -A reaches the peer file', /c\.txt \(s-peer\)/.test((await k.guard('git add -A', root, snap)) ?? ''), true)
check('guard: git status passes', await k.guard('git status', root, snap), null)
check('guard: git add of our own file passes', await k.guard('git add a.txt', root, snap), null)

// A whole-file write that drops the peer's line is denied.
const deny = await k.writeDeny(root, 'c.txt', delta('peer line here\n', 'mine only now\n'))
check('Write deny: names the peer and the line', /s-peer \(`peer line here`\)/.test(deny ?? ''), true)
check('Write keep: passes', await k.writeDeny(root, 'c.txt', delta('peer line here\n', 'peer line here\nmine too\n')), null)

// A command that changes the peer's file warns.
snap = await k.before([root])
snap.at = Date.now()
appendFileSync(`${root}/c.txt`, 'bash line in peer file\n')
check('Bash hit on a peer file: warned', await k.after(snap), ['c.txt (s-peer)'])

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
check('cursor: Write deny', [w.out.permission, /s-peer/.test(w.out.agent_message)], ['deny', true])
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
check('install: kept theirs, added ours once', cfg.hooks.preToolUse.map(h => h.command), ['theirs', `${home}/.local/bin/peers hook cursor`])
install('cursor', { home, remove: true })
check('uninstall: only theirs left', JSON.parse(readFileSync(`${home}/.cursor/hooks.json`, 'utf8')).hooks, { preToolUse: [{ command: 'theirs' }] })
install('codex', { home })
check('install codex: four events', Object.keys(JSON.parse(readFileSync(`${home}/.codex/hooks.json`, 'utf8')).hooks), ['SessionStart', 'PreToolUse', 'PostToolUse', 'SessionEnd'])

rmSync(tmp, { recursive: true, force: true })
let bad = 0
for (const [name, ok, got, want] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
process.exit(bad ? 1 : 0)
