// `peers doctor`: what this machine runs against what is installed, one line per check. Exit 1 when a check fails.
// Each check reads only; it changes nothing.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { configSync } from './io.mjs'
import { homeOf } from './path.mjs'
import { platform } from './platform.mjs'
import { loaded, older, ping, supervision, VERSION } from './view.mjs'

const has = (cmd, args = ['--version']) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000 }).trim().split('\n')[0]
  } catch {
    return null
  }
}

// The newest peers in Claude Code's plugin cache.
const newest = home => {
  try {
    return readdirSync(join(home, '.claude', 'plugins', 'cache', 'wrenautomation', 'peers'))
      .filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .reduce((a, v) => (!a || older(a, v) ? v : a), '')
  } catch {
    return ''
  }
}

// The version the shim runs: the version folder in its link's target or its script's text.
const shimVersion = home => {
  const s = platform(process.platform).shims(homeOf(home), '')
  try {
    const target = s.links.length ? realpathSync(s.links[0][1]) : readFileSync(s.files[0][0], 'utf8')
    return /[\\/](\d+\.\d+\.\d+)[\\/]bin[\\/]peers\.mjs/.exec(target)?.[1] ?? '?'
  } catch {
    return null
  }
}

export const doctor = async () => {
  const home = homedir()
  const out = []
  const line = (ok, name, text) => out.push({ ok, text: `${ok === true ? 'ok  ' : ok === false ? 'FAIL' : 'warn'} ${name}: ${text}` })

  const node = process.versions.node
  line(+node.split('.')[0] >= 20, 'node', `${node}${+node.split('.')[0] >= 20 ? '' : ' (needs 20 or newer)'}`)
  const git = has('git')
  line(!!git, 'git', git ?? 'not on PATH')

  const top = newest(home)
  line(!top || !older(VERSION, top), 'peers', top && older(VERSION, top) ? `this is ${VERSION}, ${top} is installed: restart Claude Code` : VERSION)

  const shim = shimVersion(home)
  const bin = join(home, '.local', 'bin')
  const onPath = (process.env.PATH ?? '').split(delimiter).some(d => d && homeOf(d).replace(/\/$/, '') === homeOf(bin))
  if (shim === null) line(false, 'shim', `none in ${bin}: start a Claude Code session to write it`)
  else line(shim === VERSION || shim === '?', 'shim', `${bin} runs ${shim}${shim !== VERSION && shim !== '?' ? `, not ${VERSION}: start a Claude Code session to rewrite it` : ''}`)
  line(onPath || null, 'PATH', onPath ? `has ${bin}` : `lacks ${bin}: add it`)

  const p = await ping()
  if (!p) line(true, 'server', 'not running (the pane, the TUI and peers view start it)')
  else if (p.old) line(false, 'server', 'from before 0.16.7: stop it once by hand (README, After an update)')
  else line(!older(p.version, VERSION), 'server', `${p.version}, pid ${p.pid}${p.keep ? ', supervised' : ''}${older(p.version, VERSION) ? `: older than ${VERSION}; the next pane, TUI or peers view replaces it` : ''}`)

  const s = supervision()
  const file = existsSync(s.sv.path(s.c))
  if (!file) line(true, 'supervisor', `${s.sv.name}: not installed (peers view --install)`)
  else line(loaded(s) || null, 'supervisor', `${s.sv.name}: ${loaded(s) ? 'runs the server' : 'installed, not running: peers view --install'}; log ${s.c.log}`)

  const cfg = configSync(home)
  const kind = cfg.board ?? 'backlog'
  if (kind === 'backlog') {
    const c = platform(process.platform).npmCommand('backlog', ['--version'])
    const r = spawnSync(c.cmd, c.args, { encoding: 'utf8', shell: c.shell, windowsHide: true, timeout: 15_000 })
    line(r.status === 0 || null, 'board', r.status === 0 ? `backlog ${r.stdout.trim()}` : 'backlog not on PATH (npm i -g backlog.md)')
  } else if (kind === 'jira' && cfg.jira?.via !== 'rest') {
    const v = has('acli', ['--version'])
    line(!!v, 'board', v ? `jira via acli ${v}` : 'jira via acli, but acli is not on PATH')
  } else line(true, 'board', kind === 'jira' ? 'jira via REST' : kind)

  for (const o of out) console.log(o.text)
  return out.some(o => o.ok === false) ? 1 : 0
}
