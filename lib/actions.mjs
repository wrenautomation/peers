// The action log: one JSONL file per session beside its ledger, append only, never sent anywhere.
// A line is an action, { at, op, ... }: claim, commit, check, close. A board write is a send,
// { op: 'send', id, call, args }, and each try of it adds { op: 'sent', id, ok, err? }.
// A send with no ok try and fewer than TRIES tries is pending: the next peers command sends it again.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const TRIES = 5

export const actions = path => {
  const read = () => {
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {}
    return text
      .split('\n')
      .filter(Boolean)
      .flatMap(x => {
        try {
          return [JSON.parse(x)]
        } catch {
          return [] // a line cut by a crash
        }
      })
  }
  const log = (op, data = {}) => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ at: Date.now(), op, ...data }) + '\n')
  }
  const pending = () => {
    const sends = new Map()
    for (const a of read()) {
      if (a.op === 'send') sends.set(a.id, { ...a, tries: 0 })
      else if (a.op === 'sent' && sends.has(a.id)) a.ok ? sends.delete(a.id) : sends.get(a.id).tries++
    }
    return [...sends.values()].filter(s => s.tries < TRIES)
  }
  // One try. A failure stays pending; the result says whether that was the last try.
  const attempt = async (s, run) => {
    try {
      await run(s.call, s.args)
      log('sent', { id: s.id, ok: true })
      return { ok: true, s }
    } catch (e) {
      log('sent', { id: s.id, ok: false, err: e.message })
      return { ok: false, s, err: e.message, last: (s.tries ?? 0) + 1 >= TRIES }
    }
  }
  return {
    read,
    log,
    pending,
    send: (call, args, run) => {
      const s = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, call, args }
      log('send', s)
      return attempt(s, run)
    },
    drain: async run => {
      const out = []
      for (const s of pending()) out.push(await attempt(s, run))
      return out
    },
  }
}
