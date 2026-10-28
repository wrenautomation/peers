// The contract for lib/platform.mjs. Every OS object implements Platform in full.

export type Argv = string[]

// What `peers view --install` needs to write and run a supervisor.
export interface SupervisorContext {
  home: string // with `/` separators
  node: string // process.execPath
  uid?: number // launchd's gui domain
  appData?: string // %APPDATA%, with `/` separators
  vars: Record<string, string> // extra environment for the server
  log: string
}

export interface Supervisor {
  name: string
  // Start runs a process that never exits (wscript's loop): spawn it detached, never wait on it.
  detach: boolean
  path(c: Omit<SupervisorContext, 'log'>): string
  log(c: Omit<SupervisorContext, 'log'>): string
  text(c: SupervisorContext): string
  start(c: SupervisorContext): Argv[]
  stop(c: SupervisorContext): Argv[]
  // Exit 0 when the supervisor runs the server.
  loaded(c: SupervisorContext): Argv
}

export interface Shims {
  dir: string
  files: [path: string, text: string][]
  links: [target: string, path: string][]
}

export interface Platform {
  opener(url: string): Argv
  shims(home: string, bin: string): Shims
  hookCommand(home: string, agent: string): string
  // Prints lines of `pid ppid name`.
  processList: Argv
  // A command from npm (backlog, pnpm): Windows runs its .cmd through a shell.
  npmCommand(cmd: string, args: string[]): { cmd: string; args: string[]; shell: boolean }
  supervisor: Supervisor
}

export type Os = 'darwin' | 'linux' | 'win32'
export declare const KEYS: (keyof Platform)[]
export declare const SUPERVISOR_KEYS: (keyof Supervisor)[]
export declare const PLATFORMS: Record<Os, Platform>
export declare const platform: (os: string) => Platform
