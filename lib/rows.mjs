// The one row model of the /peers-view pane and `peers tui`: plain data, no elements, so each draws it its own way.
//   span  { s, color?, bg?, bold?, dim?, strike?, under? }   dim is for times and hints only
//   row   { key, spans, press? }   press: { fold: id } or { open: { root, rel, mode } }
import { isDoc } from './doc.mjs'

export const COLORS = ['#4a86e8', '#e8590c', '#37b24d', '#be4bdb', '#e64980', '#15aabf', '#f08c00', '#7950f2']
export const NOBODY = '#8e8e93'
// Only ticket names and commit hashes carry the session's color. File names are blue; all other text is white.
// Kind marks are plain bold letters (D struck). Diff signs and counts stay green and red.
export const FILE = '#82aaff'
export const ADD = '#7cc59a'
export const DEL = '#f07178'
export const MARK = { add: 'A', edit: 'M', delete: 'D' }

export const ago = ms => {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

// One color per session by start order, the same rule as the page: a session keeps its color everywhere.
export const colorRule = sessions => {
  const first = new Map()
  for (const s of sessions) first.set(s.id, Math.min(first.get(s.id) ?? Infinity, s.started ?? 0))
  const order = [...first.keys()].sort((a, b) => first.get(a) - first.get(b))
  return id => {
    const i = order.indexOf(id ?? '')
    return i < 0 ? NOBODY : COLORS[i % COLORS.length]
  }
}

// How many rows text takes at width cells, word-wrapped as Ink wraps it (a word wider than the row breaks).
const rowsOf = (t, w) => {
  let n = 1
  let col = -1
  for (const word of t.split(' ')) {
    col = col < 0 ? word.length : col + 1 + word.length <= w ? col + 1 + word.length : (n++, word.length)
    while (col > w) n++, (col -= w)
  }
  return n
}
const CUT = '…'
// Spans cut to wrap to at most `lines` rows of `width`: spans marked `cut` shorten, last first, at a word.
// Whole text first (show-whole-text); a cut only where a row would take a third line. No width: as is.
export const fit = (spans, width, lines = 2) => {
  if (!width) return spans
  const out = spans.map(x => ({ ...x }))
  const ok = () => rowsOf(out.map(x => x.s).join(''), width) <= lines
  for (let i = out.length - 1; i >= 0 && !ok(); i--) {
    if (!out[i].cut) continue
    const full = out[i].s
    let lo = 0
    let hi = full.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      out[i].s = full.slice(0, mid).trimEnd() + CUT
      if (ok()) lo = mid
      else hi = mid - 1
    }
    const at = full.slice(0, lo).lastIndexOf(' ')
    out[i].s = lo === full.length ? full : lo ? `${full.slice(0, at > 2 ? at : lo).trimEnd()}${CUT}` : ''
  }
  return out.filter(x => x.s).map(({ cut, ...x }) => x)
}

// Names and colors for one index. A session claims its task in one repo: that name holds in every repo.
export const cast = ix => {
  const byId = new Map()
  const named = new Map()
  for (const s of ix.repos.flatMap(r => r.sessions)) {
    if ((byId.get(s.id)?.updated ?? -1) < s.updated) byId.set(s.id, s)
    if (s.ticket) named.set(s.id, s)
  }
  for (const [id, s] of named) byId.set(id, { ...byId.get(id), name: s.name, title: s.title })
  return {
    col: colorRule(ix.repos.flatMap(r => r.sessions)),
    nameOf: id => byId.get(id)?.name ?? 'nobody',
    people: [...byId.values()].sort((a, b) => b.updated - a.updated),
  }
}

export const nums = (a, d) => [a ? { s: `  +${a}`, color: ADD } : null, d ? { s: ` −${d}`, color: DEL } : null].filter(Boolean)
export const kindMark = kind => ({ s: ` ${MARK[kind]} `, bold: true, strike: kind === 'delete' })
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
const blank = key => ({ key, spans: [] })

// A group is open when the zoom reaches its depth, unless the person toggled it.
export const isOpen = (fold, id, depth) => fold.zoom >= depth !== fold.flip.includes(id)

// What a filter word means: a path (`.`, `..`, `~`, `/`, or one with a `/`) is a folder, made absolute; any other word is a name.
export const terms = (words, cwd, home) =>
  words.filter(Boolean).map(w => {
    if (!/^[.~/]/.test(w) && !w.includes('/')) return w
    const abs = w.startsWith('/') ? w : w === '~' || w.startsWith('~/') ? home + w.slice(1) : `${cwd}/${w}`
    const out = []
    for (const p of abs.split('/')) p === '..' ? out.pop() : p && p !== '.' && out.push(p)
    return `/${out.join('/')}`
  })

// A repo shows when any term matches it. A folder: the repo is that folder, under it, or holds it.
// A name: the first tier that matches any repo wins, any case: the repo's own folder name, then part of it,
// then a folder name in its path under home, then part of one. So `wren` is the wren repo, `auto` is autobrowse,
// and `wren_automation` is every repo in that folder.
const NAME_TIERS = [(s, t) => s === t, (s, t) => s.includes(t)]
export const pick = (repos, only, home) => {
  if (!only.length) return repos
  const parts = r => (r.root.startsWith(`${home}/`) ? r.root.slice(home.length + 1) : r.root).toLowerCase().split('/')
  const hits = t => {
    if (t.startsWith('/')) return repos.filter(r => r.root === t || r.root.startsWith(`${t.replace(/\/$/, '')}/`) || t.startsWith(`${r.root}/`))
    const w = t.toLowerCase()
    for (const own of [true, false])
      for (const tier of NAME_TIERS) {
        const got = repos.filter(r => (own ? parts(r).slice(-1) : parts(r)).some(s => tier(s, w)))
        if (got.length) return got
      }
    return []
  }
  const keep = new Set(only.flatMap(hits))
  return repos.filter(r => keep.has(r))
}

// The query that asks the server for a filter's repos only.
export const onlyQuery = only => only.map(t => `&only=${encodeURIComponent(t)}`).join('')

// The file list under the zoom bar: people, each repo's sessions with their open files and commits, activity.
// width: the cells a row has; a session's row (name, what it is on, age) then takes at most 2 rows.
export const listRows = (ix, fold, now, width = 0) => {
  const { col, nameOf, people } = cast(ix)
  const out = []
  if (ix.only?.length)
    out.push(
      {
        key: 'only',
        spans: [
          { s: 'filter ', dim: true },
          { s: ix.only.join(' ') },
          { s: '  →  ', dim: true },
          { s: ix.repos.length ? ix.repos.map(r => r.name).join(', ') : `no live repo matches. Live: ${ix.live?.join(', ') || 'none'}` },
        ],
      },
      blank('gap:only'),
    )
  if (ix.error) out.push({ key: 'error', spans: [{ s: ix.error, color: DEL }] })
  else if (!people.length && !ix.only?.length) out.push({ key: 'none', spans: [{ s: 'No live sessions.' }] })
  for (const s of people) {
    out.push({
      key: `p:${s.id}`,
      spans: fit([{ s: s.name, color: col(s.id), bold: true }, { s: `  ${ago(now - s.updated)}`, dim: true }, s.title ? { s: `  ${s.title}`, cut: true } : null].filter(Boolean), width),
    })
    if (s.doing) out.push({ key: `p:${s.id}:doing`, spans: fit([{ s: `  ${s.doing}`, cut: true }], width) })
  }
  for (const r of ix.repos) {
    const rows = repoRows(r, fold, now, col, nameOf)
    if (rows.length) out.push(blank(`gap:${r.root}`), { key: `r:${r.root}`, spans: [{ s: r.name, bold: true, under: true }] }, ...rows)
  }
  const feed = ix.repos
    .flatMap(r => r.feed ?? [])
    .sort((a, b) => b.at - a.at)
    .slice(0, 6)
  if (feed.length) out.push(blank('gap:feed'), { key: 'feed', spans: [{ s: 'Activity', bold: true, under: true }] })
  const dirs = new Set(ix.repos.flatMap(r => r.files.filter(f => f.isDir).map(f => f.rel)))
  for (const [i, e] of feed.entries()) {
    const rels = e.rels.slice(0, 3).map(x => leaf(shown(x, dirs.has(x))))
    out.push({
      key: `e:${i}`,
      spans: [
        { s: `${nameOf(e.a)} `, color: col(e.a), bold: true },
        e.kind === 'commit' ? { s: `✓ ${e.sha ?? ''} `, color: col(e.a) } : null,
        { s: e.kind === 'commit' ? e.t : e.t || 'Edited' },
        { s: `  ${rels.join(', ')}${e.rels.length > 3 ? ` +${e.rels.length - 3}` : ''}` },
        { s: `  ${ago(now - e.at)}`, dim: true },
      ].filter(Boolean),
    })
  }
  return out
}

// A folder always ends in a slash, so it reads as one; Activity shows the last part of each path.
const shown = (rel, isDir) => (isDir && !rel.endsWith('/') ? `${rel}/` : rel)
const leaf = rel => rel.replace(/\/$/, '').split('/').pop() + (rel.endsWith('/') ? '/' : '')

// A file sits under each session that owns a change in it; changes of no live session go to Unattributed.
// A session whose work is all committed still shows: its commits follow its open files.
const repoRows = (r, fold, now, col, nameOf) => {
  const ids = new Map(r.sessions.map(s => [s.id, s]))
  const own = a => (a && ids.has(a) ? a : null)
  const groups = new Map(r.sessions.slice().sort((a, b) => b.updated - a.updated).map(s => [s.id, []]))
  groups.set(null, [])
  for (const f of r.files) {
    const by = f.changes?.length ? f.changes.map(c => own(c.a)) : f.authors.length ? f.authors.map(own) : [null]
    for (const a of new Set(by)) groups.get(a).push(f)
  }
  const out = []
  for (const [a, files] of groups) {
    const s = a ? ids.get(a) : null
    const commits = s?.commits ?? []
    const total = s?.commitCount ?? commits.length
    if (!files.length && !commits.length) continue
    const id = `s:${r.root}:${a}`
    const mine = f => (f.changes?.length ? f.changes.filter(c => own(c.a) === a) : [])
    const sum = (f, k) => (mine(f).length ? mine(f).reduce((m, c) => m + c[k], 0) : f[k])
    const open = isOpen(fold, id, 2)
    out.push({
      key: id,
      press: { fold: id },
      spans: [
        { s: open ? '▼ ' : '▶ ', bold: true },
        { s: a ? nameOf(a) : 'Unattributed', color: col(a), bold: true },
        { s: files.length ? `  ${files.length} open` : '  nothing open' },
        ...nums(
          files.reduce((n, f) => n + sum(f, 'adds'), 0),
          files.reduce((n, f) => n + sum(f, 'dels'), 0),
        ),
        total ? { s: `  ${plural(total, 'commit')}` } : null,
      ].filter(Boolean),
    })
    if (!open) continue
    for (const f of files) {
      const cs = mine(f)
      const said = [...new Set(cs.filter(c => c.said).map(c => c.t))]
      const kind = f.kind ?? (f.isNew ? 'add' : 'edit')
      const fk = `f:${a}:${r.root}/${f.rel}`
      out.push({
        key: fk,
        press: { open: { root: r.root, rel: f.rel, mode: isDoc(f.rel) ? 'doc' : 'diff' } },
        spans: [
          { s: '  ' },
          kindMark(kind),
          { s: shown(f.rel, f.isDir), color: FILE, strike: kind === 'delete' },
          ...f.authors.filter(x => own(x) !== a).map(x => ({ s: `  ${nameOf(x)}`, color: col(x) })),
          f.count ? { s: `  ${f.count} new files` } : null,
          ...nums(sum(f, 'adds'), sum(f, 'dels')),
          { s: `  ${ago(now - f.mtime)}`, dim: true },
          fold.zoom < 3 && said.length ? { s: `  ${said.join(' · ')}` } : null,
        ].filter(Boolean),
      })
      if (fold.zoom >= 3)
        for (const [i, c] of cs.entries())
          out.push({
            key: `${fk}:${i}`,
            spans: [{ s: '    ' }, { s: c.t || 'change' }, ...nums(c.adds, c.dels), { s: `  L${c.line}`, dim: true }],
          })
    }
    for (const c of commits)
      out.push({
        key: `c:${a}:${c.sha}`,
        spans: [
          { s: '  ' },
          { s: ' ✓ ', color: col(a), bold: true },
          { s: c.sha.slice(0, 8), color: col(a) },
          { s: `  ${c.t || 'commit'}  ${plural(c.files, 'file')}` },
          { s: `  ${ago(now - c.at)}`, dim: true },
        ],
      })
    if (total > commits.length) out.push({ key: `c:${a}:more`, spans: [{ s: `     ${total - commits.length} older`, dim: true }] })
  }
  return out
}

// The head of one open file: its kind, repo/path, and its authors by name.
export const fileHead = (ix, focus) => {
  const { col, nameOf } = cast(ix)
  const repo = ix.repos.find(r => r.root === focus.root)
  const file = repo?.files.find(x => x.rel === focus.rel)
  return {
    file,
    spans: [
      file ? kindMark(file.kind ?? 'edit') : null,
      { s: `${repo?.name ?? ''}/${shown(focus.rel, file?.isDir)}`, color: FILE, bold: true },
      ...(file?.authors ?? []).map(a => ({ s: `  ${nameOf(a)}`, color: col(a) })),
    ].filter(Boolean),
  }
}

// Suggestion style: added text underlined, removed text struck, both in the author's color.
export const docRow = (x, col) => {
  const c = col(x.a)
  if (x.k === '=') return [{ s: x.s || ' ', bold: /^#{1,6}\s/.test(x.s) }]
  if (x.k === '~') return [{ s: x.pre ?? '' }, ...(x.runs ?? []).map(r => (r.t === '=' ? { s: r.s } : { s: r.s, color: c, under: r.t === '+', strike: r.t === '-' }))]
  return [{ s: x.pre ?? '' }, { s: x.s.slice(x.pre?.length ?? 0) || ' ', color: c, under: x.k === '+', strike: x.k === '-' }]
}

// The owner's title over each hunk of a diff.
export const hunkHead = (hunk, col, nameOf) => [{ s: hunk.t || hunk.at || `line ${hunk.new}`, bold: true }, hunk.a ? { s: `  ${nameOf(hunk.a)}`, color: col(hunk.a) } : null].filter(Boolean)
