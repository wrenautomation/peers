// lib/core.mjs's io on node: what `peers hook` uses where the mod uses `$`.
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
      execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1 << 28, encoding: 'utf8' }, (err, stdout) =>
        res({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '' }),
      ),
    ),
  now: async () => Date.now(),
}
