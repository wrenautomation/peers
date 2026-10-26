// node lib/lines.test.mjs
import { statusPaths, unclaimed } from './lines.mjs'

const peer = (rel, last, added = [], removed = []) => ({ files: { [rel]: { first: last, last, added, removed } } })
const d = { added: ['const mine = 1', 'const theirs = 2'], removed: ['const old = 0'] }
const cases = [
  ['no peer touched it since: ours whole', unclaimed(d, [peer('a.ts', 5)], 'a.ts', 10), d],
  ['peer touched another file: ours', unclaimed(d, [peer('b.ts', 20)], 'a.ts', 10), d],
  ['peer lines dropped, ours kept', unclaimed(d, [peer('a.ts', 20, ['const theirs = 2'])], 'a.ts', 10), { added: ['const mine = 1'], removed: ['const old = 0'] }],
  ['all lines the peer\'s: not ours', unclaimed(d, [peer('a.ts', 20, ['const mine = 1', 'const theirs = 2'], ['const old = 0'])], 'a.ts', 10), null],
  ['no delta, peer touched it: not ours', unclaimed(undefined, [peer('a.ts', 20)], 'a.ts', 10), null],
  ['blind peer (no lines) touched it: not ours', unclaimed(d, [peer('a.ts', 20)], 'a.ts', 10), null],
  ['rename row: both paths, whole', statusPaths('R  bin/peers.mjs\0bin/mine.mjs\0 M README.md\0?? new.ts\0'), ['bin/peers.mjs', 'bin/mine.mjs', 'README.md', 'new.ts']],
]
let bad = 0
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? 'ok ' : 'BAD'} ${name}${ok ? '' : `: ${JSON.stringify(got)}`}`)
}
process.exit(bad ? 1 : 0)
