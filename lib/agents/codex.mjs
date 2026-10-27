// Codex CLI hooks (~/.codex/hooks.json): stdin JSON in, JSON out. https://learn.chatgpt.com/docs/hooks
// apply_patch names its files in the patch text; Bash is a shell command.

const EVENTS = { SessionStart: 'start', PreToolUse: 'pre', PostToolUse: 'post', SessionEnd: 'end' }
const READS = /^(read|grep|glob|ls|list|search|view|web)/i

export const name = 'codex'
export const exe = 'codex'

export const parse = e => {
  const event = EVENTS[e.hook_event_name]
  if (!event) return null
  const tool = e.tool_name === 'Bash' || e.tool_name === 'shell' ? 'shell' : READS.test(e.tool_name ?? '') ? 'read' : 'edit'
  const patch = typeof e.tool_input === 'string' ? e.tool_input : (e.tool_input?.input ?? e.tool_input?.patch ?? '')
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm), ...patch.matchAll(/^\*\*\* Move to: (.+)$/gm)].map(m => m[1].trim())
  return { event, session: e.session_id, cwd: e.cwd, id: e.tool_use_id ?? e.turn_id ?? '', tool, command: e.tool_input?.command ?? '', files }
}

export const deny = reason => ({ out: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } })
export const context = text => ({ out: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } } })

// timeout: seconds. No matcher: every tool.
export const install = cmd => ({
  path: home => `${home}/.codex/hooks.json`,
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: cmd, timeout: 10 }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: cmd, timeout: 10 }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: cmd, timeout: 20 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }],
  },
  has: (list, cmd) => list.some(g => g.hooks?.some(h => h.command === cmd)),
})
