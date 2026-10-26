// Line attribution, shared by the mod (hooks/register.tsx) and `mine` (bin/mine.mjs).
// A session owns the lines its edits added and removed. Only distinctive lines count:
// a `}` or a blank line could be anyone's.

const CAP = 2000

export const key = line => {
  const t = line.trimEnd()
  return t.trim().length >= 4 && /[A-Za-z0-9]/.test(t) ? t.slice(0, 300) : null
}

export const keys = text => {
  const out = new Set()
  for (const line of text.split('\n')) {
    const k = key(line)
    if (k) out.add(k)
  }
  return out
}

// What an edit from `before` to `after` added and removed.
export const delta = (before, after) => {
  const a = keys(before)
  const b = keys(after)
  return { added: [...b].filter(k => !a.has(k)), removed: [...a].filter(k => !b.has(k)) }
}

export const merge = (old = [], more = []) => [...new Set([...old, ...more])].slice(-CAP)

// `git diff -U0` text for one file: header, then hunks with their old range and lines.
export const parseDiff = text => {
  const head = []
  const hunks = []
  let h = null
  for (const line of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
    if (m) {
      h = { a: +m[1], b: m[2] === undefined ? 1 : +m[2], text: [line], plus: [], minus: [] }
      hunks.push(h)
      continue
    }
    if (!h) {
      if (line) head.push(line)
      continue
    }
    if (line.startsWith('+')) h.plus.push(line.slice(1))
    else if (line.startsWith('-')) h.minus.push(line.slice(1))
    else if (line.startsWith('\\')) h.noEol = true
    else continue
    h.text.push(line)
  }
  return { head, hunks, binary: /^Binary files /m.test(text) }
}

// Whose is a hunk: 'mine' unless a peer's lines are in it and none of ours are.
// A line both sides claim counts for neither.
export const owner = (h, mine, theirs) => {
  let m = 0
  let t = 0
  const score = (line, mineSet, theirSet) => {
    const k = key(line)
    if (!k) return
    const a = mineSet.has(k)
    const b = theirSet.has(k)
    if (a && !b) m++
    if (b && !a) t++
  }
  for (const line of h.plus) score(line, mine.added, theirs.added)
  for (const line of h.minus) score(line, mine.removed, theirs.removed)
  return t > 0 ? (m > 0 ? 'mixed' : 'theirs') : 'mine'
}

// Apply some -U0 hunks of a diff to the base text. Old ranges stay valid: they count
// lines of the base, and the hunks are applied in order.
export const applyHunks = (base, hunks) => {
  const lines = base.split('\n')
  const out = []
  let pos = 0
  for (const h of [...hunks].sort((x, y) => x.a - y.a)) {
    const start = h.b === 0 ? h.a : h.a - 1
    out.push(...lines.slice(pos, start), ...h.plus)
    pos = start + h.b
  }
  out.push(...lines.slice(pos))
  return out.join('\n')
}
