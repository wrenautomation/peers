// node lib/tui.test.mjs — the pure parts of `peers tui`: syntax spans and diff rows.
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

let bad = 0
for (const [name, ok, got, want] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
process.exit(bad ? 1 : 0)
