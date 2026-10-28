// lib/core.mjs's io on node: what `peers hook` uses where the mod uses `$`.
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runningOf, SESSIONS } from './core.mjs'

const kindOf = x => (x.isFile() ? 'file' : x.isDirectory() ? 'dir' : 'other')

export const nodeIo = {
  read: p => readFile(p, 'utf8'),
  write: async (p, t) => {
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, t)
  },
  list: async d => (await readdir(d, { withFileTypes: true })).map(e => ({ name: e.name, kind: kindOf(e) })),
  stat: async p => {
    const s = await stat(p)
    return { mtimeMs: s.mtimeMs, size: s.size, kind: kindOf(s) }
  },
  run: (argv, { timeoutMs }) =>
    new Promise(res =>
      execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1 << 28, encoding: 'utf8', windowsHide: true }, (err, stdout) =>
        res({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '' }),
      ),
    ),
  now: async () => Date.now(),
}

// core.mjs's runningOf, read at once: for the CLI and the view server, which read ledgers in sync.
export const runningSync = home => {
  try {
    const dir = SESSIONS(home)
    return runningOf(readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
      try {
        return readFileSync(`${dir}/${f}`, 'utf8')
      } catch {
        return ''
      }
    }))
  } catch {
    return null
  }
}

// Each running Claude session's state from its session file: busy or idle, and what it waits on (a question, a permission).
//   Map session id -> { status, waitingFor, at }. A parked terminal is left out, as in runningOf.
// ~/.claude/peers/config.json, over the defaults. boxScrollback: the events a session's box keeps, as a terminal's scrollback.
export const CONFIG = { boxScrollback: 50 }
export const configSync = home => {
  try {
    const d = JSON.parse(readFileSync(`${home}/.claude/peers/config.json`, 'utf8'))
    return { ...CONFIG, ...(d && typeof d === 'object' ? d : {}) }
  } catch {
    return { ...CONFIG }
  }
}

export const statusSync = home => {
  const out = new Map()
  try {
    const dir = SESSIONS(home)
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json')))
      try {
        const d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))
        if (typeof d?.sessionId === 'string' && !d.parkedJobId)
          out.set(d.sessionId, { status: d.status ?? null, waitingFor: d.waitingFor ?? null, statusAt: d.statusUpdatedAt ?? null })
      } catch {}
  } catch {}
  return out
}
