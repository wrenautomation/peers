// Every OS-specific command and file, one object per OS with the same keys. A method returns an argv or a file's
// text and runs nothing: the CLI runs it with node, the mod with $. platform.test.mjs holds every OS to every key
// in KEYS and SUPERVISOR_KEYS on all three CI runners; platform.d.mts types the contract.
// Paths in and out use `/` (path.mjs's slash); a method that writes a path for Windows itself turns it to `\`.
// No imports: the mod loads it.

export const KEYS = ['opener', 'shims', 'hookCommand', 'processList', 'npmCommand', 'supervisor']
export const SUPERVISOR_KEYS = ['name', 'detach', 'path', 'log', 'text', 'start', 'stop', 'loaded']

const LABEL = 'com.wrenautomation.peers-view'
const bs = p => p.replace(/\//g, '\\')
const powershell = cmd => ['powershell', '-NoProfile', '-Command', cmd]
const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const vbs = v => String(v).replace(/"/g, '""')

const posix = {
  // A symlink to this version's bin: `peers` follows each update.
  shims: (home, bin) => ({ dir: `${home}/.local/bin`, files: [], links: [[bin, `${home}/.local/bin/peers`]] }),
  hookCommand: (home, agent) => `${home}/.local/bin/peers hook ${agent}`,
  processList: ['ps', '-A', '-o', 'pid=,ppid=,comm='],
  npmCommand: (cmd, args) => ({ cmd, args, shell: false }),
}

const darwin = {
  ...posix,
  opener: url => ['open', url],
  // Runs the stable ~/.local/bin/peers link: a restart picks up the newest version.
  supervisor: {
    name: 'launchd',
    detach: false,
    path: c => `${c.home}/Library/LaunchAgents/${LABEL}.plist`,
    log: c => `${c.home}/Library/Logs/peers-view.log`,
    text: c => {
      const args = [c.node, `${c.home}/.local/bin/peers`, 'view', '--serve', '--keep']
      const vars = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: c.home, ...c.vars }
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(vars)
    .map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`)
    .join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(c.log)}</string>
  <key>StandardErrorPath</key><string>${xml(c.log)}</string>
</dict>
</plist>
`
    },
    start: c => [['launchctl', 'bootstrap', `gui/${c.uid}`, darwin.supervisor.path(c)]],
    // bootout returns before the job is gone: the caller waits on loaded before a start.
    stop: c => [['launchctl', 'bootout', `gui/${c.uid}/${LABEL}`]],
    loaded: c => ['launchctl', 'print', `gui/${c.uid}/${LABEL}`],
  },
}

const linux = {
  ...posix,
  opener: url => ['xdg-open', url],
  supervisor: {
    name: 'systemd',
    detach: false,
    path: c => `${c.home}/.config/systemd/user/peers-view.service`,
    log: c => `${c.home}/.local/state/peers-view.log`,
    text: c =>
      [
        '[Unit]',
        'Description=peers view',
        '',
        '[Service]',
        `ExecStart="${c.node}" "${c.home}/.local/bin/peers" view --serve --keep`,
        ...Object.entries(c.vars).map(([k, v]) => `Environment="${k}=${v}"`),
        'Restart=always',
        `StandardOutput=append:${c.log}`,
        `StandardError=append:${c.log}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    start: () => [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'peers-view'],
    ],
    stop: () => [['systemctl', '--user', 'disable', '--now', 'peers-view']],
    loaded: () => ['systemctl', '--user', 'is-active', '--quiet', 'peers-view'],
  },
}

const loop = `Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | ? CommandLine -match 'peers-view.vbs'`
const win32 = {
  // rundll32, not `start`: cmd would split the URL at each `&`.
  opener: url => ['rundll32', 'url.dll,FileProtocolHandler', url],
  // No symlink without admin: a .cmd for cmd and PowerShell, an sh script for Git Bash. Each session rewrites them.
  shims: (home, bin) => ({
    dir: `${home}/.local/bin`,
    files: [
      [`${home}/.local/bin/peers.cmd`, `@node "${bs(bin)}" %*\r\n`],
      [`${home}/.local/bin/peers`, `#!/bin/sh\nexec node "${bin}" "$@"\n`],
    ],
    links: [],
  }),
  hookCommand: (home, agent) => `${bs(home)}\\.local\\bin\\peers.cmd hook ${agent}`,
  // The same `pid ppid name` lines as ps.
  processList: powershell('Get-CimInstance Win32_Process | % { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'),
  // npm's .cmd files run only through cmd, each argument quoted for it.
  npmCommand: (cmd, args) => ({ cmd, args: args.map(a => `"${a.replace(/"/g, '""')}"`), shell: true }),
  // A script in the Startup folder: wscript runs it at logon with no window and starts the server again when it
  // exits, as launchd's KeepAlive. It runs peers.cmd, which each session points at the newest version.
  supervisor: {
    name: 'Startup folder',
    detach: true,
    path: c => `${c.appData ?? `${c.home}/AppData/Roaming`}/Microsoft/Windows/Start Menu/Programs/Startup/peers-view.vbs`,
    log: c => `${c.home}/.claude/peers-view.log`,
    text: c => {
      const run = `cmd /c ""${bs(c.home)}\\.local\\bin\\peers.cmd" view --serve --keep >> "${bs(c.log)}" 2>&1"`
      return [
        'Set sh = CreateObject("WScript.Shell")',
        ...Object.entries(c.vars).map(([k, v]) => `sh.Environment("Process")("${k}") = "${vbs(v)}"`),
        'Do',
        `  sh.Run "${vbs(run)}", 0, True`,
        '  WScript.Sleep 2000',
        'Loop',
        '',
      ].join('\r\n')
    },
    start: c => [['wscript.exe', bs(win32.supervisor.path(c))]],
    stop: () => [powershell(`${loop} | % { Stop-Process -Id $_.ProcessId -Force }`)],
    loaded: () => powershell(`if (${loop}) { exit 0 } else { exit 1 }`),
  },
}

export const PLATFORMS = { darwin, linux, win32 }
// An OS name (process.platform): any other POSIX gets linux's.
export const platform = os => PLATFORMS[os] ?? linux
