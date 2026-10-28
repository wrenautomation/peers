// `peers hook <agent>`: one hook event of a terminal agent (Codex, Cursor) → lib/core.mjs → the agent's answer.
// Claude Code needs none of this: the mod (hooks/register.tsx) calls core in process.
// Each event is its own process, so the snapshot a pre-tool event takes waits on disk for the post-tool event:
//   ~/.claude/peers-run/snap/<session>-<tool use id>.json
// A `peers` command in the agent's shell has no session env: agents/<pid>.json maps the agent's process to it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as codex from './agents/codex.mjs'
import * as cursor from './agents/cursor.mjs'
import { core } from './core.mjs'
import { nodeIo } from './io.mjs'
import { delta } from './lines.mjs'
import { isAbs, slash, winOf } from './path.mjs'
import { platform } from './platform.mjs'

export const AGENTS = { codex, cursor }
const STALE_MS = 60 * 60 * 1000
const run = home => `${home}/.claude/peers-run`

// pid -> { ppid, comm } for every process.
const procs = () => {
  const m = new Map()
  const [exe, ...args] = platform(process.platform).processList
  let out = ''
  try {
    out = execFileSync(exe, args, { encoding: 'utf8', windowsHide: true })
  } catch {}
  for (const line of out.split('\n')) {
    const x = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (x) m.set(+x[1], { ppid: +x[2], comm: x[3].trim() })
  }
  return m
}
const ancestors = (pid, table = procs()) => {
  const out = []
  for (let p = pid; p > 1 && out.length < 64; p = table.get(p)?.ppid ?? 0) out.push({ pid: p, comm: table.get(p)?.comm ?? '' })
  return out
}

// The agent process above this hook: later `peers` calls under it find the session.
const mark = (home, a, session, pid) => {
  const agent = ancestors(pid).find(x => x.comm.split('/').pop().startsWith(a.exe))
  if (!agent) return
  const path = `${run(home)}/agents/${agent.pid}.json`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ session, agent: a.name, at: Date.now() }))
}

// The session of the agent that runs this `peers` process, or null.
export const findSession = home => {
  try {
    for (const x of ancestors(process.ppid)) {
      const path = `${run(home)}/agents/${x.pid}.json`
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')).session
    }
  } catch {}
  return null
}

const sweep = home => {
  const now = Date.now()
  for (const d of ['snap', 'agents']) {
    let names = []
    try {
      names = readdirSync(`${run(home)}/${d}`)
    } catch {}
    for (const n of names) {
      const p = `${run(home)}/${d}/${n}`
      try {
        const old = now - statSync(p).mtimeMs > (d === 'snap' ? STALE_MS : 48 * STALE_MS)
        if (old) rmSync(p, { force: true })
      } catch {}
    }
  }
}

// The repos where this session has a ledger.
const ownRoots = (home, session) => {
  const dir = `${home}/.claude/peers`
  try {
    return readdirSync(dir)
      .filter(enc => existsSync(`${dir}/${enc}/${session}.json`))
      .map(decodeURIComponent)
  } catch {
    return []
  }
}

// One event: { out } (JSON to print), never a throw. pid: the hook's parent, for `mark`.
export const handle = async (agent, e, { home, io = nodeIo, pid = process.ppid } = {}) => {
  const a = AGENTS[agent]
  const ev = a?.parse(e)
  if (!ev?.session) return { out: {} }
  const session = `${a.name}_${ev.session}`
  const k = core({ home, session, agent: a.name })(io)
  const snapPath = `${run(home)}/snap/${encodeURIComponent(session)}-${encodeURIComponent(ev.id || 'x')}.json`
  const win = winOf(home)
  const abs = p => ((p = slash(p, win)), isAbs(p) ? p : `${slash(ev.cwd, win)}/${p}`)

  if (ev.event === 'start') {
    if (pid) mark(home, a, session, pid)
    sweep(home)
    return { out: {} }
  }
  if (ev.event === 'end') {
    await k.end(ownRoots(home, session))
    return { out: {} }
  }
  if (ev.tool === 'read') return { out: {} }

  if (ev.event === 'pre') {
    if (pid && ev.tool === 'shell' && /\b(peers|mine)\b/.test(ev.command)) mark(home, a, session, pid)
    const files = ev.files.map(abs)
    const roots = await k.commandRoots(ev.command, ev.cwd)
    for (const r of ownRoots(home, session)) if (!roots.includes(r)) roots.push(r)
    for (const f of files) {
      const at = await k.locate(f)
      if (at && !roots.includes(at.root)) roots.push(at.root)
    }
    if (!roots.length) return { out: {} }
    const snap = await k.before(roots, files)
    if (ev.tool === 'shell') {
      const d = await k.guard(ev.command, ev.cwd, snap)
      if (d) return a.deny(d)
    }
    // A whole-file write must keep a peer's lines, as Claude Code's Write.
    if (ev.content !== undefined && files[0]) {
      const at = await k.locate(files[0])
      const d = at && (await k.writeDeny(at.root, at.rel, delta((await k.readText(files[0])) ?? '', ev.content)))
      if (d) return a.deny(d)
    }
    snap.at = await io.now()
    snap.cmd = ev.command ?? ''
    await io.write(snapPath, JSON.stringify(snap))
    return { out: {} }
  }

  // post: no snapshot means no pre event saw it (a read, or a hook that timed out): nothing to record.
  let snap
  try {
    snap = JSON.parse(await io.read(snapPath))
  } catch {
    return { out: {} }
  }
  rmSync(snapPath, { force: true })
  const hit = await k.after(snap, '')
  if (!hit.length) return { out: {} }
  return a.context(`peers: this command changed uncommitted peer files: ${hit.join(', ')}. Check them with git diff and put back any of their lines it broke.`)
}

// Add (or with remove, take out) `peers hook <agent>` in the agent's hook config. root: a repo's own config.
export const install = (agent, { home, root, remove = false }) => {
  const a = AGENTS[agent]
  const cmd = platform(process.platform).hookCommand(slash(home, winOf(home)), agent)
  const spec = a.install(cmd)
  const path = root ? spec.path(home).replace(home, root) : spec.path(home)
  const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : (spec.wrap?.({}) ?? {})
  cfg.hooks ??= {}
  for (const [ev, list] of Object.entries(spec.hooks)) {
    const cur = (cfg.hooks[ev] ??= [])
    if (remove) cfg.hooks[ev] = cur.filter(x => !spec.has([x], cmd))
    else if (!spec.has(cur, cmd)) cur.push(...list)
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev]
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n')
  return path
}
