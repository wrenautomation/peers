// node lib/tui.test.mjs — the pure parts of `peers tui`: syntax spans and diff rows.
import { listRows, pick, terms } from './rows.mjs'
import { diffRows, highlight } from './tui.mjs'

const results = []
const check = (name, got, want) => results.push([name, JSON.stringify(got) === JSON.stringify(want), got, want])

const js = highlight("const a = '<b>' && 1", 'js')
check('highlight: the text comes back whole, entities undone', js.map(x => x.s).join(''), "const a = '<b>' && 1")
check('highlight: a keyword and a string get colors', [js[0].color, js.find(x => x.s.includes('<b>'))?.color], ['#c792ea', '#c3e88d'])
check('highlight: no language, one plain span', highlight('x < y', null), [{ s: 'x < y' }])

const col = id => (id === 'me' ? '#4a86e8' : '#8e8e93')
const rows = diffRows(
  [{ old: 10, new: 10, a: 'me', t: 'Fix it', lines: [{ t: ' ', s: 'keep' }, { t: '-', s: 'old line' }, { t: '+', s: 'new line' }, { t: ' ', s: 'tail' }] }],
  'a.txt',
  col,
  () => 'me-name',
)
const text = r => r.spans.map(x => x.s).join('')
check('diff: hunk head carries the title and owner', text(rows[0]), 'Fix it  me-name')
check('diff: line numbers old for -, new for + and context', rows.slice(1).map(r => text(r).slice(0, 5).trim()), ['10', '11', '11', '12'])
check('diff: an author bar on changed lines only', rows.slice(1).map(r => r.spans[1].s), [' ', '▌', '▌', ' '])
check('diff: changed lines fill their tint', rows.slice(1).map(r => Boolean(r.fill)), [false, true, true, false])

// The repo filter: paths are folders made absolute, other words are parts of folder names under home.
const H = '/Users/w'
check('terms: paths absolute, names kept', terms(['.', '../lander', '~/x', 'wren', 'a/b'], `${H}/wa/wren/packages`, H), [`${H}/wa/wren/packages`, `${H}/wa/wren/lander`, `${H}/x`, 'wren', `${H}/wa/wren/packages/a/b`])
const repos = ['wa/wren', 'wa/autobrowse', 'wa/lander', 'other/site'].map(p => ({ root: `${H}/${p}`, name: p.split('/')[1] }))
const names = only => pick(repos, only, H).map(r => r.name)
check('pick: no words, every repo', names([]), ['wren', 'autobrowse', 'lander', 'site'])
check('pick: a folder holds its repos', names([`${H}/wa`]), ['wren', 'autobrowse', 'lander'])
check('pick: a folder inside a repo picks that repo', names([`${H}/wa/wren/packages`]), ['wren'])
check('pick: a repo name first', names(['wren']), ['wren'])
check('pick: then part of a repo name, any case', names(['AUTO']), ['autobrowse'])
check('pick: then a folder in the path', names(['wa']), ['wren', 'autobrowse', 'lander'])
check('pick: then part of a folder in the path', names(['oth']), ['site'])
check('pick: the home folder name matches nothing by itself', names(['users']), [])
check('pick: words add up', names(['lander', 'site']), ['lander', 'site'])
const none = listRows({ sig: '', repos: [], only: ['nope'], live: ['wren', 'lander'] }, { zoom: 2, flip: [] }, 0)
check('filter row: no match lists the live repos', none.map(r => r.spans.map(x => x.s).join('')), ['filter nope  →  no live repo matches. Live: wren, lander', ''])

let bad = 0
for (const [name, ok, got, want] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
process.exit(bad ? 1 : 0)
