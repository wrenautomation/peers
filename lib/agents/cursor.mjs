// Cursor CLI hooks (~/.cursor/hooks.json, or <repo>/.cursor/hooks.json): stdin JSON in, JSON out.
// Seen live on cursor-agent 2026.09.18: cwd is "", the repo is workspace_roots[0]; Write's tool_input holds the content.

const EVENTS = { sessionStart: 'start', preToolUse: 'pre', postToolUse: 'post', sessionEnd: 'end' }
const READS = /^(read|grep|glob|ls|list|search|codebase|web|fetch)/i

export const name = 'cursor'
export const exe = 'cursor-agent'

export const parse = e => {
  const event = EVENTS[e.hook_event_name]
  if (!event) return null
  const tool = e.tool_name === 'Shell' ? 'shell' : READS.test(e.tool_name ?? '') ? 'read' : 'edit'
  const i = e.tool_input ?? {}
  const path = i.file_path ?? i.path ?? i.target_file
  return {
    event,
    session: e.conversation_id ?? e.session_id,
    cwd: i.cwd || e.workspace_roots?.[0] || e.cwd || '',
    id: e.tool_use_id ?? '',
    tool,
    command: i.command ?? '',
    files: path ? [path] : [],
    content: e.tool_name === 'Write' ? i.content : undefined,
  }
}

export const deny = reason => ({ out: { continue: true, permission: 'deny', user_message: reason, agent_message: reason } })
export const context = text => ({ out: { additional_context: text } })

export const install = cmd => ({
  path: home => `${home}/.cursor/hooks.json`,
  hooks: { sessionStart: [{ command: cmd }], preToolUse: [{ command: cmd }], postToolUse: [{ command: cmd }], sessionEnd: [{ command: cmd }] },
  has: (list, cmd) => list.some(h => h.command === cmd),
  wrap: hooks => ({ version: 1, hooks }),
})
