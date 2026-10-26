export type Peer = {
  session: string
  name: string
  ticket?: string
  files: number
  shared: number
  last: number
}

// The /peers pane: what the `peers view` server answers (lib/view.mjs, lib/doc.mjs).
export type ViewRun = { t: '=' | '+' | '-'; s: string }
export type ViewLine = {
  k: '=' | '+' | '-' | '~'
  s: string
  a: string | null
  pre?: string
  runs?: ViewRun[]
  g?: number
  fence?: boolean
}
export type ViewHunk = { old: number; new: number; at: string; lines: { t: ' ' | '+' | '-'; s: string; a?: string | null }[] }
export type ViewFile = { rel: string; authors: string[]; isNew: boolean; mtime: number; adds: number; dels: number }
export type ViewSession = { id: string; name: string; title: string | null; updated: number }
export type ViewRepo = { root: string; name: string; sessions: ViewSession[]; files: ViewFile[] }
export type ViewIndex = { sig: string; repos: ViewRepo[]; error?: string }
export type ViewFocus = { root: string; rel: string; mode: 'doc' | 'diff' } | null
export type ViewBody = {
  root: string
  rel: string
  mode: 'doc' | 'diff'
  mtime: number
  lines?: ViewLine[]
  hunks?: ViewHunk[]
} | null

declare module 'claude-code' {
  interface PluginState {
    peers: { peers: Peer[]; index: Shaped<ViewIndex>; focus: Shaped<ViewFocus>; body: Shaped<ViewBody> }
  }
}
