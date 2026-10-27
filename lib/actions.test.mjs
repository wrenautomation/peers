// node lib/actions.test.mjs — lib/actions.mjs: the log, the outbox's retries and its give-up.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TRIES, actions } from './actions.mjs'

const results = []
const check = (name, got, want) => results.push([name, JSON.stringify(got) === JSON.stringify(want), got, want])

const a = actions(`${mkdtempSync(`${tmpdir()}/peers-act-`)}/s.actions.jsonl`)
check('empty log reads empty', [a.read(), a.pending()], [[], []])
a.log('claim', { ticket: 'X-1' })
check('an action lands with its time', [a.read()[0].op, a.read()[0].ticket, typeof a.read()[0].at], ['claim', 'X-1', 'number'])

const sent = []
let up = false
const run = (call, args) => {
  if (!up) throw new Error('board down')
  sent.push([call, ...args])
}
const r = await a.send('note', ['X-1', 'abc fix'], run)
check('a failed send stays pending', [r.ok, r.last, a.pending().length], [false, false, 1])
up = true
check('the drain sends it', [(await a.drain(run)).map(x => x.ok), sent, a.pending()], [[true], [['note', 'X-1', 'abc fix']], []])
check('a sent write never sends again', (await a.drain(run)).length, 0)

up = false
await a.send('note', ['X-1', 'never'], run)
for (let i = 1; i < TRIES - 1; i++) await a.drain(run)
const last = await a.drain(run)
check('the last try says so, then it is dropped', [last.map(x => x.last), a.pending()], [[true], []])

let bad = 0
for (const [name, ok, got, want] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
process.exit(bad ? 1 : 0)
