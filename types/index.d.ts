export type Peer = {
  session: string
  name: string
  ticket?: string
  files: number
  shared: number
  last: number
}

declare module 'claude-code' {
  interface PluginState {
    peers: { peers: Peer[] }
  }
}
