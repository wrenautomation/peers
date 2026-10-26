// node lib/lines.test.mjs
import { owner, statusPaths, unclaimed, yields } from './lines.mjs'

const peer = (rel, last, added = [], removed = []) => ({ files: { [rel]: { first: last, last, added, removed } } })
const d = { added: ['const mine = 1', 'const theirs = 2'], removed: ['const old = 0'] }
const cases = [
  ['no peer touched it since: ours whole', unclaimed(d, [peer('a.ts', 5)], 'a.ts', 10), d],
  ['peer touched another file: ours', unclaimed(d, [peer('b.ts', 20)], 'a.ts', 10), d],
  ['peer lines dropped, ours kept', unclaimed(d, [peer('a.ts', 20, ['const theirs = 2'])], 'a.ts', 10), { added: ['const mine = 1'], removed: ['const old = 0'] }],
  ['all lines the peer\'s: not ours', unclaimed(d, [peer('a.ts', 20, ['const mine = 1', 'const theirs = 2'], ['const old = 0'])], 'a.ts', 10), null],
  ['no delta, peer touched it: not ours', unclaimed(undefined, [peer('a.ts', 20)], 'a.ts', 10), null],
  ['blind peer (no lines) touched it: not ours', unclaimed(d, [peer('a.ts', 20)], 'a.ts', 10), null],
  // Real cases (2026-10-26): a quick edit inside a peer's long command stays the quick one's.
  ['peer Edit at 34:19 inside our 30s Bash: theirs', yields('a.md', 100_000, { from: 80_000, to: 110_000 }, [{ files: { 'a.md': { first: 1, from: 100_100, last: 100_100 } } }]), true],
  ['our quick python inside a peer 5m run: ours', yields('a.ts', 100_000, { from: 99_000, to: 101_000 }, [{ files: { 'a.ts': { first: 1, from: 0, last: 300_000 } } }]), false],
  ['peer action long before the change: ours', yields('a.ts', 100_000, { from: 90_000, to: 110_000 }, [{ files: { 'a.ts': { first: 1, from: 10_000, last: 10_000 } } }]), false],
  ['old entry without from, edited at the change: theirs', yields('a.ts', 100_000, { from: 90_000, to: 110_000 }, [{ files: { 'a.ts': { first: 1, last: 100_500 } } }]), true],
  ['blind peer: hunk with no line of ours is theirs', owner({ plus: ['const x = 1'], minus: [] }, { added: new Set(), removed: new Set() }, { added: new Set(), removed: new Set() }, true), 'theirs'],
  ['blind peer: hunk with our line is ours', owner({ plus: ['const x = 1'], minus: [] }, { added: new Set(['const x = 1']), removed: new Set() }, { added: new Set(), removed: new Set() }, true), 'mine'],
  ['rename row: both paths, whole', statusPaths('R  bin/peers.mjs\0bin/mine.mjs\0 M README.md\0?? new.ts\0'), ['bin/peers.mjs', 'bin/mine.mjs', 'README.md', 'new.ts']],
]
let bad = 0
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? 'ok ' : 'BAD'} ${name}${ok ? '' : `: ${JSON.stringify(got)}`}`)
}
process.exit(bad ? 1 : 0)
