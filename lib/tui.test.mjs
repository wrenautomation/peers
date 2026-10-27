// node lib/tui.test.mjs — the pure parts of `peers tui`: syntax spans and diff rows.
import { boxCols, boxes, fit, listRows, pick, terms } from './rows.mjs'
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
  20,
)
const text = r => r.spans.map(x => x.s).join('')
// Lines 1-9 and 13-20 sit outside the hunk: a gap row before and after says so.
check('diff: a gap row before the hunk', text(rows[0]).trim(), '⋯  lines 1–9 not shown')
check('diff: a gap row after the last hunk', text(rows.at(-1)).trim(), '⋯  lines 13–20 not shown')
check('diff: hunk head carries the title and owner', text(rows[1]), 'Fix it  me-name')
const body = rows.slice(2, -1)
check('diff: line numbers old for -, new for + and context', body.map(r => text(r).slice(0, 5).trim()), ['10', '11', '11', '12'])
check('diff: an author bar on changed lines only', body.map(r => r.spans[1].s), [' ', '▌', '▌', ' '])
check('diff: changed lines fill their tint', body.map(r => Boolean(r.fill)), [false, true, true, false])

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
const none = listRows({ sig: '', repos: [], only: ['nope'], live: ['wren', 'lander'] }, { flip: [] }, 0)
check('filter row: no match lists the live repos', none.map(r => r.spans.map(x => x.s).join('')), ['filter nope  →  no live repo matches. Live: wren, lander', ''])

// A folder row ends in a slash, in the list and in Activity; a file does not.
const S = 'cc_s1'
const dirIx = {
  sig: '',
  repos: [{ root: '/r', name: 'r', sessions: [{ id: S, name: 'cc-s1', title: null, doing: null, started: 0, updated: 0, commits: [] }],
    files: [{ rel: 'devboard', isDir: true, authors: [S], kind: 'add', isNew: true, mtime: 0, hunks: [] }, { rel: 'vendor/', count: 50, authors: [S], kind: 'add', isNew: true, mtime: 0, hunks: [] }, { rel: 'a/b.md', authors: [S], kind: 'edit', isNew: false, mtime: 0, hunks: [] }],
    feed: [{ a: S, at: 0, kind: 'edit', t: 'x', rels: ['devboard', 'vendor/', 'a/b.md'] }] }],
}
const dirRows = listRows(dirIx, { flip: [] }, 0).map(r => r.spans.map(x => x.s).join(''))
check('folder: a linked folder gets a slash', dirRows.some(t => t.includes('devboard/')), true)
check('folder: a bulk folder keeps one slash', dirRows.some(t => t.includes('vendor/') && !t.includes('vendor//')), true)
check('folder: a file gets none', dirRows.some(t => t.includes('a/b.md/')), false)
check('folder: Activity shows the last parts', dirRows.some(t => t.includes('devboard/, vendor/, b.md')), true)

// A session's row wraps to 2 rows at most: the cut spans shorten at a word, the last first.
const txt = sp => sp.map(x => x.s).join('')
check('fit: short text whole', txt(fit([{ s: 'cc-1' }, { s: '  a title', cut: true }], 20)), 'cc-1  a title')
check('fit: no width, whole', txt(fit([{ s: 'cc-1' }, { s: ' x'.repeat(50), cut: true }], 0)).length, 104)
const long = fit([{ s: 'cc-b641  2m' }, { s: '  the session title that runs on and on', cut: true }, { s: '  what it did last, also long', cut: true }], 20)
check('fit: two rows at most, the last span cut first', txt(long), 'cc-b641  2m  the session title that…')
check('fit: a span with no room goes', long.length, 2)
check('fit: wraps whole when 2 rows hold it', txt(fit([{ s: 'cc-1' }, { s: '  one two three four five', cut: true }], 16)), 'cc-1  one two three four five')

// Boxes: the session that waits on you first, then working, then idle; each says its state.
const ses = (id, x) => ({ id, name: `cc-${id}`, updated: 100, commits: [], ...x })
const bx = boxes(
  {
    repos: [
      {
        name: 'r',
        root: '/r',
        files: [],
        feed: [{ a: 'b', at: 90, t: 'Edit the thing', kind: 'edit' }],
        sessions: [ses('a', { updated: 300, status: 'idle' }), ses('b', { status: 'busy' }), ses('c', { updated: 50, status: 'idle', waitingFor: 'approve Bash' })],
      },
    ],
  },
  1000,
  40,
)
check('boxes: waiting, then working, then idle', bx.map(b => b.id), ['c', 'b', 'a'])
check('boxes: each says its state', bx.map(b => text(b.rows[1]).split('  ')[0]), ['◆ waits on you: approve Bash', '● working', '○ idle'])
check('boxes: the last things it did', bx[1].rows.some(r => text(r).startsWith('· Edit the thing')), true)
check('boxes: columns by width', [60, 100, 150, 300].map(boxCols), [1, 2, 3, 3])

let bad = 0
for (const [name, ok, got, want] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
process.exit(bad ? 1 : 0)
