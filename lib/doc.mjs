// A file's text in suggestion style, line by line: what `peers view` and the /peers pane both draw.
//   k  '=' unchanged, '+' added, '-' removed, '~' changed in place (runs: a word diff, t '=' '+' '-')
//   a  the author's session id, or null
//   pre  the Markdown prefix (list marker, heading, quote) kept outside the marks
//   g  set on lines that go in one block (a run of whole added or removed lines); else inline
//   fence  inside a code fence
import { diffLines, diffWordsWithSpace } from './vendor/diff.mjs'
import { key } from './lines.mjs'

export const isDoc = rel => /\.(md|mdx|markdown)$/i.test(rel)
const prefix = line => /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|\s*#{1,6}\s+|\s*>\s*)?/.exec(line)[0]
const item = line => /^\s*([-*+]|\d+[.)])\s/.test(line)
const split = text => text.replace(/\n$/, '').split('\n')

export const docLines = (old, now, authors) => {
  const by = (side, line) => authors[side][key(line)] ?? null
  const out = []
  let fence = false
  let g = 0
  const push = x => {
    x.fence = fence
    if (x.k !== '-' && /^\s*(```|~~~)/.test(x.s)) fence = !fence
    out.push(x)
  }
  // Whole lines: a line too plain to own (a brace, a blank) takes its neighbour's author.
  const whole = (k, ls, block) => {
    const id = block ? ++g : undefined
    let prev = null
    for (const s of ls) {
      const a = by(k === '+' ? 'added' : 'removed', s) ?? (key(s) ? null : prev)
      prev = a
      push({ k, s, a, pre: prefix(s), g: id })
    }
  }
  const parts = diffLines(old, now)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p.added && !p.removed) {
      for (const s of split(p.value)) push({ k: '=', s, a: null })
      continue
    }
    const next = parts[i + 1]
    if (p.removed && next?.added) {
      i++
      const a = split(p.value)
      const b = split(next.value)
      const n = Math.min(a.length, b.length)
      // Line pairs get a word diff; the rest of a list stays in the list, other leftovers go in a block.
      if (a.length === b.length || (a.slice(n).every(item) && b.slice(n).every(item))) {
        for (let j = 0; j < n; j++) {
          const pre = prefix(b[j])
          const runs = diffWordsWithSpace(a[j].slice(prefix(a[j]).length), b[j].slice(pre.length)).map(w => ({
            t: w.added ? '+' : w.removed ? '-' : '=',
            s: w.value,
          }))
          push({ k: '~', s: b[j], a: by('added', b[j]) ?? by('removed', a[j]), pre, runs })
        }
        whole('+', b.slice(n), false)
        whole('-', a.slice(n), false)
      } else {
        whole('-', a, true)
        whole('+', b, true)
      }
      continue
    }
    const ls = split(p.value)
    whole(p.added ? '+' : '-', ls, p.removed || ls.length !== 1 || !ls[0].trim())
  }
  return out
}
