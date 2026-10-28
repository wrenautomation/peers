// node lib/platform.test.mjs — every OS implements every key, and each method returns the shape the callers run.
import { readdirSync, readFileSync } from 'node:fs'
import { KEYS, PLATFORMS, platform, SUPERVISOR_KEYS } from './platform.mjs'

const results = []
const check = (name, ok, got) => results.push([name, !!ok, got])
const argv = a => Array.isArray(a) && a.length > 0 && a.every(x => typeof x === 'string' && x.length > 0)
const text = t => typeof t === 'string' && t.length > 0

check('three OSes', Object.keys(PLATFORMS).sort().join() === 'darwin,linux,win32', Object.keys(PLATFORMS))
check('unknown OS gets linux', platform('freebsd') === PLATFORMS.linux)

for (const [os, p] of Object.entries(PLATFORMS)) {
  const home = os === 'win32' ? 'C:/Users/me' : '/home/me'
  for (const k of KEYS) check(`${os}: has ${k}`, p[k] !== undefined, typeof p[k])
  for (const k of SUPERVISOR_KEYS) check(`${os}: supervisor has ${k}`, p.supervisor?.[k] !== undefined, typeof p.supervisor?.[k])
  const extra = Object.keys(p).filter(k => !KEYS.includes(k))
  check(`${os}: no key outside KEYS`, !extra.length, extra)

  check(`${os}: opener`, argv(p.opener('http://x/?a=1&b=2')) && p.opener('http://x/?a=1&b=2').at(-1) === 'http://x/?a=1&b=2')
  const s = p.shims(home, `${home}/.claude/plugins/peers/bin/peers.mjs`)
  check(`${os}: shims`, text(s.dir) && Array.isArray(s.files) && Array.isArray(s.links) && s.files.length + s.links.length > 0, s)
  check(`${os}: hookCommand`, text(p.hookCommand(home, 'codex')) && p.hookCommand(home, 'codex').endsWith(' hook codex'))
  check(`${os}: processList`, argv(p.processList))
  const n = p.npmCommand('backlog', ['task', 'a "b"'])
  check(`${os}: npmCommand`, n.cmd === 'backlog' && n.args.length === 2 && typeof n.shell === 'boolean', n)

  const sv = p.supervisor
  const base = { home, node: '/usr/bin/node', uid: 501, vars: { PEERS_VIEW_HOST: 'h.example.com' } }
  const c = { ...base, log: sv.log(base) }
  check(`${os}: supervisor path and log`, text(sv.path(base)) && text(c.log))
  check(`${os}: supervisor text names the server`, text(sv.text(c)) && sv.text(c).includes('--serve') && sv.text(c).includes('--keep'))
  check(`${os}: supervisor text carries vars`, sv.text(c).includes('h.example.com'))
  check(`${os}: supervisor start, stop`, sv.start(c).every(argv) && sv.start(c).length > 0 && sv.stop(c).every(argv) && sv.stop(c).length > 0)
  check(`${os}: supervisor loaded`, argv(sv.loaded(c)))
  check(`${os}: supervisor detach`, typeof sv.detach === 'boolean')
}

// Windows spells its own paths with `\`, and its shims and script end lines as cmd and wscript want.
const w = PLATFORMS.win32
check('win32: hook command uses \\', w.hookCommand('C:/Users/me', 'cursor') === 'C:\\Users\\me\\.local\\bin\\peers.cmd hook cursor')
check('win32: .cmd ends in CRLF', w.shims('C:/Users/me', 'C:/p/peers.mjs').files[0][1] === '@node "C:\\p\\peers.mjs" %*\r\n')
check('win32: npm args quoted for cmd', w.npmCommand('backlog', ['a "b"']).args[0] === '"a ""b"""')
const wc = { home: 'C:/Users/me', node: 'node', vars: { A: 'x"y' }, log: 'C:/Users/me/.claude/peers-view.log' }
check('win32: script quotes for VBScript', w.supervisor.text(wc).includes('("A") = "x""y"'))
check('win32: script hides the window', /sh\.Run ".*", 0, True/.test(w.supervisor.text(wc)))
check('win32: APPDATA when given', w.supervisor.path({ ...wc, appData: 'D:/Roam' }).startsWith('D:/Roam/Microsoft/'))
check('darwin: plist escapes', PLATFORMS.darwin.supervisor.text({ ...wc, home: '/h', uid: 1, vars: { A: 'a&b' } }).includes('a&amp;b'))

// The guard: no OS branch outside platform.mjs. A new one belongs there, as a key every OS must fill.
const here = new URL('..', import.meta.url)
const files = ['bin/peers.mjs', 'hooks/register.tsx', ...readdirSync(new URL('lib/', here)).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'platform.mjs').map(f => `lib/${f}`)]
for (const f of files) {
  const hits = readFileSync(new URL(f, here), 'utf8')
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /process\.platform\s*[!=]==|['"](win32|darwin|linux)['"]/.test(l) && !/platform\(/.test(l))
  check(`no OS branch in ${f}`, !hits.length, hits.map(([n]) => n))
}

let bad = 0
for (const [name, ok, got] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `: got ${JSON.stringify(got)}`}`)
}
process.exit(bad ? 1 : 0)
