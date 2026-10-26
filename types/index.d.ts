export type Peer = {
  session: string
  name: string
  ticket?: string
  files: number
  shared: number
  last: number
  started?: number
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
// t: the title of a change: the line its author wrote before the edit (said), else where it sits.
export type ViewHunk = {
  old: number
  new: number
  at: string
  t: string
  said: boolean
  a: string | null
  lines: { t: ' ' | '+' | '-'; s: string; a?: string | null }[]
}
export type ViewChange = { line: number; t: string; said: boolean; a: string | null; adds: number; dels: number }
export type ViewFile = {
  rel: string
  authors: string[]
  isNew: boolean
  kind: 'add' | 'edit' | 'delete'
  count?: number
  mtime: number
  adds: number
  dels: number
  titles: string[]
  changes: ViewChange[]
}
export type ViewSession = {
  id: string
  name: string
  title: string | null
  doing: string | null
  started: number
  updated: number
  commits: { sha: string; at: number; files: number }[]
}
export type ViewEvent = { kind: 'edit' | 'commit'; at: number; a: string; t: string; sha?: string; rels: string[] }
export type ViewRepo = { root: string; name: string; sessions: ViewSession[]; files: ViewFile[]; feed: ViewEvent[] }
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
// The pane's fold state: zoom 1 sessions, 2 files, 3 changes; flip holds the groups toggled away from it.
export type ViewFold = { zoom: 1 | 2 | 3; flip: string[] }

declare module 'claude-code' {
  interface PluginState {
    peers: { peers: Peer[]; index: Shaped<ViewIndex>; focus: Shaped<ViewFocus>; body: Shaped<ViewBody>; fold: Shaped<ViewFold> }
  }
}
