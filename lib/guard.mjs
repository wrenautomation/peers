// Bash commands that can wreck a peer's uncommitted files: whole-tree staging,
// discards (stash, reset --hard, checkout/restore, clean), branch switches and
// formatters that write. `scan` reads a command and returns each hit with the
// paths it targets; `targets: null` means the whole tree. The mod denies a hit
// only when a live peer has an uncommitted file among those paths.

export const HINT = {
  stage: 'Use `peers commit -m "..."` (your files only) or `git add -- <your files>`.',
  discard: 'Name only your own files (`git restore -- <file>`), or wait until they commit.',
  switch: 'A branch switch changes the files of every session in this checkout. Wait until they commit, or work in a worktree under ~/worktrees.',
  format: 'Run it on your files only, e.g. `pnpm biome check --write $(peers files)`.',
}

const WRITES = {
  biome: a => a.some(x => /^--(write|apply|apply-unsafe|fix)$/.test(x)),
  prettier: a => a.includes('--write') || a.includes('-w'),
  eslint: a => a.includes('--fix'),
  oxlint: a => a.includes('--fix'),
  stylelint: a => a.includes('--fix'),
  markdownlint: a => a.includes('--fix'),
  'markdownlint-cli2': a => a.includes('--fix'),
  ruff: a => (a[0] === 'format' && !a.includes('--check') && !a.includes('--diff')) || a.includes('--fix'),
  black: a => !a.includes('--check') && !a.includes('--diff'),
  dprint: a => a[0] === 'fmt',
  gofmt: a => a.includes('-w'),
  rustfmt: a => !a.includes('--check'),
}
const TOOL_WORDS = new Set(['check', 'format', 'lint', 'ci', 'fmt'])
// package.json scripts that rewrite the whole tree (wren and autobrowse: `lint:fix`).
const FIX_SCRIPT = /^(lint[:-]fix|format(:write)?|fmt|fix|check[:-]fix)$/
const LAUNCHERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'bunx', 'turbo'])
const LAUNCH_WORDS = new Set(['exec', 'dlx', 'x', 'run', '-s', '--silent', '-y', '--yes', '-w', '--workspace-root'])
const STASH_SAFE = new Set(['list', 'show', 'pop', 'apply', 'drop', 'branch', 'clear', 'create', 'store'])
const PREFIX = new Set(['sudo', 'time', 'command', 'env', 'nice', 'nohup'])

const MINE = '__mine__'
const OPAQUE = '__q__'

// Paths, or null for the whole tree. `$(peers files)` names only this session's files.
const pathsOf = tokens => {
  const t = tokens.filter(x => x !== MINE)
  if (t.length === 0) return tokens.length ? [] : null
  if (t.some(x => x === OPAQUE || x.includes('*') || x.includes('$') || x === ':/')) return null
  return t
}

const afterDashes = a => {
  const i = a.indexOf('--')
  return i < 0 ? null : a.slice(i + 1)
}

// Non-flag words, skipping the values of the given flags.
const words = (a, valued = []) => {
  const out = []
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--') break
    if (valued.includes(a[i])) i++
    else if (!a[i].startsWith('-')) out.push(a[i])
  }
  return out
}

const shortFlag = (a, ch) => a.some(x => /^-[A-Za-z]+$/.test(x) && x.includes(ch))

const git = a => {
  let dir
  let i = 0
  while (i < a.length && a[i].startsWith('-')) {
    if (a[i] === '-C') dir = a[i + 1]
    i += a[i] === '-C' || a[i] === '-c' ? 2 : 1
  }
  const sub = a[i]
  const r = a.slice(i + 1)
  const hit = (rule, targets, extra = {}) => ({ rule, targets, dir, ...extra })
  switch (sub) {
    case 'add': {
      if (r.some(x => ['-A', '--all', '-u', '--update'].includes(x))) return hit('stage', null)
      const p = afterDashes(r) ?? words(r, ['--chmod', '--pathspec-from-file'])
      return p.length ? hit('stage', pathsOf(p)) : null
    }
    case 'commit': {
      if (r.includes('--all') || r.some(x => /^-[A-Za-z]*a[A-Za-z]*$/.test(x))) return hit('stage', null)
      const p = afterDashes(r)
      return p?.length ? hit('stage', pathsOf(p)) : null
    }
    case 'stash': {
      if (STASH_SAFE.has(r[0])) return null
      const p = afterDashes(r)
      return hit('discard', p?.length ? pathsOf(p) : null)
    }
    case 'reset':
      return r.some(x => ['--hard', '--merge', '--keep'].includes(x)) ? hit('discard', null) : null
    case 'clean':
      if (r.includes('-n') || r.includes('--dry-run') || !(r.includes('--force') || shortFlag(r, 'f'))) return null
      return hit('discard', pathsOf(words(r, ['-e', '--exclude'])))
    case 'restore': {
      const staged = r.includes('--staged') || r.includes('-S')
      if (staged && !(r.includes('--worktree') || r.includes('-W'))) return null
      const p = afterDashes(r) ?? words(r, ['-s', '--source'])
      return p.length ? hit('discard', pathsOf(p)) : null
    }
    case 'checkout': {
      if (r.includes('-f') || r.includes('--force')) return hit('discard', null)
      const p = afterDashes(r)
      if (p) return hit('discard', pathsOf(p))
      if (r.includes('-b')) return null
      const w = words(r, ['-B', '--orphan'])
      if (!w.length) return null
      // `git checkout X`: a path if X exists in the tree, else a branch. The mod checks.
      return hit('discard', pathsOf(w), { branchy: w[0] })
    }
    case 'switch':
      if (r.includes('-c') || r.includes('--create')) return null
      return hit(r.includes('-f') || r.includes('--discard-changes') ? 'discard' : 'switch', null)
    case 'rm':
      return hit('discard', pathsOf(afterDashes(r) ?? words(r)))
    default:
      return null
  }
}

const formatter = (name, a) => {
  const writes = WRITES[name]
  if (!writes || !writes(a)) return null
  return { rule: 'format', targets: pathsOf(a.filter(x => !x.startsWith('-') && !TOOL_WORDS.has(x) && !/^\d+$/.test(x))) }
}

const segment = t => {
  while (t.length && (PREFIX.has(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) t = t.slice(1)
  if (!t.length) return null
  const base = t[0].slice(t[0].lastIndexOf('/') + 1)
  if (base === 'git') return git(t.slice(1))
  if (base === 'cargo' && t[1] === 'fmt') return t.includes('--check') ? null : { rule: 'format', targets: null }
  if (WRITES[base]) return formatter(base, t.slice(1))
  if (LAUNCHERS.has(base)) {
    let i = 1
    while (i < t.length && LAUNCH_WORDS.has(t[i])) i++
    const name = t[i]
    if (!name) return null
    if (WRITES[name]) return formatter(name, t.slice(i + 1))
    if (base !== 'npx' && base !== 'bunx' && FIX_SCRIPT.test(name)) return { rule: 'format', targets: null }
  }
  return null
}

/**
 * @typedef {{ rule: 'stage' | 'discard' | 'switch' | 'format', targets: string[] | null, dir?: string, branchy?: string, cwd?: string }} Hit
 * @param {string} cmd
 * @returns {Hit[]}
 */
export const scan = cmd => {
  const text = cmd
    .replace(/\$\(\s*peers\s+files\s*\)/g, ` ${MINE} `)
    // Heredoc bodies and quoted strings are prose, not commands.
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`/g, ` ${OPAQUE} `)
  const hits = []
  let cwd
  for (const seg of text.split(/&&|\|\||[;&|\n()]/)) {
    const t = seg.trim().split(/\s+/).filter(Boolean)
    if (t[0] === 'cd') {
      cwd = t[1]
      continue
    }
    const h = segment(t)
    if (h) hits.push({ ...h, cwd })
  }
  return hits
}
