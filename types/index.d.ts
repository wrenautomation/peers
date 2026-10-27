export type Peer = {
  session: string
  name: string
  ticket?: string
  files: number
  shared: number
  last: number
  started?: number
  adds?: number
  dels?: number
  // The verbose band: what they last said their edits do, and the files we both changed.
  doing?: string
  sharedFiles?: string[]
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
  commitCount?: number
  // The last five, newest first.
  commits: { sha: string; at: number; files: number; t?: string }[]
}
export type ViewEvent = { kind: 'edit' | 'commit'; at: number; a: string; t: string; sha?: string; rels: string[] }
export type ViewRepo = { root: string; name: string; sessions: ViewSession[]; files: ViewFile[]; feed: ViewEvent[] }
// only/live: set when a filter asked for some repos: its words, and every live repo's name.
export type ViewIndex = { sig: string; repos: ViewRepo[]; error?: string; only?: string[]; live?: string[] }
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
    peers: { peers: Peer[]; index: Shaped<ViewIndex>; focus: Shaped<ViewFocus>; body: Shaped<ViewBody>; fold: Shaped<ViewFold>; wide: boolean; only: string[]; ring: Record<string, string> }
  }
}

// lib/rows.mjs: the one row model the pane and `peers tui` draw.
export type Span = { s: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; strike?: boolean; under?: boolean }
export type Row = { key: string; spans: Span[]; press?: { fold: string } | { open: NonNullable<ViewFocus> } }
