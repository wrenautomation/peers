// The one row model of the /peers-view pane and `peers tui`: plain data, no elements, so each draws it its own way.
//   span  { s, color?, bg?, bold?, dim?, strike?, under?, hit? }   dim is for times and hints only
//   row   { key, spans, press?, indent? }   press: { fold: id } or { open: { root, rel, mode } }
// indent: cells left of the row; a wrapped line starts there too, so text hangs under its own row.
// A pressable row marks its name spans `hit`: only those take the pointer and the ring, as the band's names do.
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

// Names and colors for one index. A session's name: the one the person gave it, else its id (`cc-2724`).
// A session claims its task in one repo: that task and its title hold in every repo.
export const cast = ix => {
  const byId = new Map()
  const named = new Map()
  for (const s of ix.repos.flatMap(r => r.sessions)) {
    if ((byId.get(s.id)?.updated ?? -1) < s.updated) byId.set(s.id, s)
    if (s.ticket) named.set(s.id, s)
  }
  // Its commits over every repo, newest first.
  const all = ix.repos.flatMap(r => r.sessions)
  for (const [id, s] of byId) {
    const t = named.get(id)
    const each = all.filter(x => x.id === id)
    const commits = each.flatMap(x => x.commits ?? []).sort((a, b) => b.at - a.at)
    const commitCount = each.reduce((n, x) => n + (x.commitCount ?? (x.commits ?? []).length), 0)
    byId.set(id, { ...s, ...(t ? { ticket: t.ticket, title: t.title } : {}), cc: s.name, name: s.label || s.name, commits: commits.slice(0, 5), commitCount })
  }
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

// A session group is open and a file is shut, unless the person toggled it.
export const isOpen = (fold, id, depth) => depth <= 2 !== fold.flip.includes(id)

// The new-file lines no hunk shows: before each hunk, and after the last up to the file's length.
//   [{ before: index of the hunk it precedes (hunks.length: the end), from, to }]
export const gaps = (hunks, size = 0) => {
  const out = []
  let end = 0
  for (const [i, h] of hunks.entries()) {
    if (h.new - 1 > end) out.push({ before: i, from: end + 1, to: h.new - 1 })
    end = Math.max(end, h.new - 1 + h.lines.filter(x => x.t !== '-').length)
  }
  if (size > end) out.push({ before: hunks.length, from: end + 1, to: size })
  return out
}
export const gapText = g => `⋯  ${g.to - g.from + 1 === 1 ? `line ${g.from}` : `lines ${g.from}–${g.to}`} not shown`

// The keys of each view, for the `?` help of the pane and `peers tui`.
export const HELP = {
  list: [
    ['↑ ↓', 'move'],
    ['enter', 'open a file, or fold a session'],
    ['?', 'this help'],
  ],
  file: [
    ['↑ ↓', 'scroll'],
    ['d', 'document'],
    ['f', 'diff'],
    ['b', 'back to the list'],
    ['?', 'this help'],
  ],
}
export const helpRows = (list, extra = []) =>
  [...list, ...extra].map(([k, what]) => ({ key: `help:${k}`, spans: [{ s: k.padEnd(10), color: FILE, bold: true }, { s: what }] }))

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
  const { mine, loose, shared } = owners(ix)
  if (people.length) out.push(head('sessions', 'Sessions'))
  for (const s of people) out.push(...sessionRows(s, mine.get(s.id) ?? [], fold, now, width, col, nameOf))
  if (loose.length) out.push(...sessionRows(null, loose, fold, now, width, col, nameOf))
  if (shared.length) out.push(blank('gap:shared'), head('shared', 'Shared'))
  for (const { r, f, by } of shared)
    out.push({
      key: `x:${r.root}/${f.rel}`,
      press: { open: { root: r.root, rel: f.rel, mode: isDoc(f.rel) ? 'doc' : 'diff' } },
      spans: [kindMark(f.kind ?? 'edit'), ...pathSpans(`${r.name}/${shown(f.rel, f.isDir)}`, f.kind === 'delete'), ...by.map(a => ({ s: `  ${nameOf(a)}`, color: col(a), bold: true }))],
    })
  const feed = ix.repos
    .flatMap(r => r.feed ?? [])
    .sort((a, b) => b.at - a.at)
    .slice(0, 6)
  if (feed.length) out.push(blank('gap:feed'), head('feed', 'Activity', 'newest first, live'))
  const dirs = new Set(ix.repos.flatMap(r => r.files.filter(f => f.isDir).map(f => f.rel)))
  for (const [i, e] of feed.entries()) {
    const rels = e.rels.slice(0, 3).map(x => leaf(shown(x, dirs.has(x))))
    out.push({
      key: `e:${i}`,
      spans: [
        { s: `${nameOf(e.a)} `, color: col(e.a), bold: true },
        e.kind === 'commit' ? { s: `✓ ${e.sha ?? ''} `, color: col(e.a) } : null,
        { s: e.kind === 'commit' ? e.t : e.t || 'Edited' },
        { s: `  ${rels.join(', ')}${e.rels.length > 3 ? ` +${e.rels.length - 3}` : ''}`, color: col(e.a) },
        { s: `  ${ago(now - e.at)}`, dim: true },
      ].filter(Boolean),
    })
  }
  return out
}

// A path in its owner's color (blue when it has none, or several), its name bold: the eye finds the name first. Both take the press.
const pathSpans = (rel, strike, color = FILE) => {
  const i = rel.lastIndexOf('/', rel.length - 2)
  return [i < 0 ? null : { s: rel.slice(0, i + 1), color, strike, hit: true }, { s: rel.slice(i + 1), color, bold: true, strike, hit: true }].filter(Boolean)
}

// A folder always ends in a slash, so it reads as one; Activity shows the last part of each path.
const shown = (rel, isDir) => (isDir && !rel.endsWith('/') ? `${rel}/` : rel)
const leaf = rel => rel.replace(/\/$/, '').split('/').pop() + (rel.endsWith('/') ? '/' : '')

const head = (key, s, hint) => ({ key, spans: [{ s, bold: true, under: true }, hint ? { s: `  ${hint}`, dim: true } : null].filter(Boolean) })

// Who owns each open file. A file sits under each session that owns a change in it; changes of no live
// session are loose (Unattributed). A file two or more sessions own is also shared.
//   mine: session -> [{ r, f, own }]   own: that session's changes in f
const owners = ix => {
  const mine = new Map()
  const loose = []
  const shared = []
  for (const r of ix.repos) {
    const ids = new Set(r.sessions.map(s => s.id))
    const own = a => (a && ids.has(a) ? a : null)
    for (const f of r.files) {
      const by = [...new Set(f.changes?.length ? f.changes.map(c => own(c.a)) : f.authors.length ? f.authors.map(own) : [null])]
      for (const a of by) {
        const item = { r, f, own: f.changes?.length ? f.changes.filter(c => own(c.a) === a) : [] }
        if (a) mine.set(a, [...(mine.get(a) ?? []), item])
        else loose.push(item)
      }
      if (by.filter(Boolean).length > 1) shared.push({ r, f, by: by.filter(Boolean) })
    }
  }
  return { mine, loose, shared }
}

// One session: its name in its color, its id when it has a name, its task, its age and title, then what it does.
// Open, its files as repo/path, newest first, then its commits. s null: the loose files, as Unattributed.
const sessionRows = (s, items, fold, now, width, col, nameOf) => {
  const a = s?.id ?? null
  const id = `s:${a}`
  const open = isOpen(fold, id, 2)
  const sum = (it, k) => (it.own.length ? it.own.reduce((m, c) => m + c[k], 0) : it.f[k] ?? 0)
  const commits = s?.commits ?? []
  const total = s?.commitCount ?? commits.length
  const out = [
    {
      key: id,
      press: { fold: id },
      spans: fit(
        [
          { s: open ? '▼ ' : '▶ ', bold: true, hit: true },
          { s: s ? s.name : 'Unattributed', color: col(a), bold: true, hit: true },
          s && s.name !== s.cc ? { s: `  ${s.cc}`, dim: true } : null,
          s?.ticket && s.ticket !== s.name ? { s: `  ${s.ticket}`, color: col(a) } : null,
          s ? { s: `  ${ago(now - s.updated)}`, dim: true } : null,
          { s: items.length ? `  ${items.length} open` : '  nothing open' },
          ...nums(
            items.reduce((n, it) => n + sum(it, 'adds'), 0),
            items.reduce((n, it) => n + sum(it, 'dels'), 0),
          ),
        ].filter(Boolean),
        width,
      ),
    },
  ]
  // Under the name: the title, then what it does now. A wrapped line uses the full width.
  // Folded: each at most 2 rows, cut at a word. Open: whole.
  const line = (key, t) => {
    const spans = [{ s: '  ' }, { s: t, cut: true }]
    out.push({ key, spans: open ? spans.map(({ cut, ...x }) => x) : fit(spans, width) })
  }
  if (s?.title) line(`${id}:title`, s.title)
  if (s?.doing) line(`${id}:doing`, s.doing)
  if (!open) return out
  for (const { r, f, own } of items.slice().sort((x, y) => y.f.mtime - x.f.mtime)) {
    const said = [...new Set(own.filter(c => c.said).map(c => c.t))]
    const kind = f.kind ?? (f.isNew ? 'add' : 'edit')
    out.push({
      key: `f:${a}:${r.root}/${f.rel}`,
      press: { open: { root: r.root, rel: f.rel, mode: isDoc(f.rel) ? 'doc' : 'diff' } },
      indent: 2,
      spans: [
        { s: `${MARK[kind]} `, bold: true, strike: kind === 'delete' },
        ...pathSpans(`${r.name}/${shown(f.rel, f.isDir)}`, kind === 'delete', a ? col(a) : FILE),
        ...f.authors.filter(x => x !== a && r.sessions.some(o => o.id === x)).map(x => ({ s: `  ${nameOf(x)}`, color: col(x) })),
        f.count ? { s: `  ${f.count} new files` } : null,
        ...nums(sum({ f, own }, 'adds'), sum({ f, own }, 'dels')),
        { s: `  ${ago(now - f.mtime)}`, dim: true },
        said.length ? { s: `  ${said.join(' · ')}` } : null,
      ].filter(Boolean),
    })
  }
  for (const c of commits)
    out.push({
      key: `c:${a}:${c.sha}`,
      indent: 2,
      spans: [
        { s: '✓ ', color: col(a), bold: true },
        { s: c.sha.slice(0, 8), color: col(a) },
        { s: `  ${c.t || 'commit'}  ${plural(c.files, 'file')}` },
        { s: `  ${ago(now - c.at)}`, dim: true },
      ],
    })
  if (total > commits.length) out.push({ key: `c:${a}:more`, indent: 4, spans: [{ s: `${total - commits.length} older`, dim: true }] })
  return out
}

// Boxes: one per session, for `peers tui`'s second view (v). Waiting first, then working, then idle; newest first in each.
//   [{ id, color, rows }]   rows as the list's, cut to the box's inner width.
export const WAIT = '#f08c00'
// Columns by width: a box needs about 48.
export const boxCols = cols => Math.max(1, Math.min(3, Math.floor(cols / 48)))
// Claude Code's session status: busy, shell (runs a command) or idle; none when the session is gone.
const working = s => !!s.status && s.status !== 'idle'
const rank = s => (s.waitingFor ? 0 : working(s) ? 1 : 2)
export const boxes = (ix, now, width = 0) => {
  const { col, nameOf, people } = cast(ix)
  const { mine } = owners(ix)
  const feed = ix.repos.flatMap(r => (r.feed ?? []).map(e => ({ ...e, repo: r.name })))
  return people
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.updated - a.updated)
    .map(s => {
      const c = col(s.id)
      const rows = []
      const add = (key, spans, lines = 2) => rows.push({ key: `${s.id}:${key}`, spans: fit(spans, width, lines) })
      add('name', [
        { s: s.name, color: c, bold: true },
        s.name !== s.cc ? { s: `  ${s.cc}`, dim: true } : null,
        s.ticket ? { s: `  ${s.ticket}`, color: c } : null,
      ].filter(Boolean))
      const since = s.statusAt ? `  ${ago(now - s.statusAt)}` : ''
      add('state', s.waitingFor
        ? [{ s: `◆ waits on you: ${s.waitingFor}`, color: WAIT, bold: true, cut: true }, { s: since, dim: true }]
        : working(s)
          ? [{ s: s.status === 'shell' ? '● runs a command' : '● working', color: ADD, bold: true }, { s: since, dim: true }]
          : [{ s: s.status ? '○ idle' : '○ closed', bold: true }, { s: `  ${ago(now - s.updated)}`, dim: true }], 1)
      if (s.title) add('title', [{ s: s.title, cut: true }])
      if (s.doing) add('doing', [{ s: 'now ', dim: true }, { s: s.doing, cut: true }])
      // The last 4 things it did: titled edits and commits.
      const done = feed.filter(e => e.a === s.id).sort((a, b) => b.at - a.at).slice(0, 4)
      if (done.length) rows.push({ key: `${s.id}:gap1`, spans: [] })
      for (const [i, e] of done.entries())
        add(`e:${i}`, [
          e.kind === 'commit' ? { s: `✓ ${e.sha ?? ''} `, color: c } : { s: '· ', color: c },
          { s: e.t || 'Edited', cut: true },
          { s: `  ${ago(now - e.at)}`, dim: true },
        ], 1)
      const files = (mine.get(s.id) ?? []).slice().sort((x, y) => y.f.mtime - x.f.mtime)
      if (files.length) rows.push({ key: `${s.id}:gap2`, spans: [] })
      for (const { r, f, own } of files.slice(0, 4)) {
        const adds = own.length ? own.reduce((n, x) => n + x.adds, 0) : (f.adds ?? 0)
        const dels = own.length ? own.reduce((n, x) => n + x.dels, 0) : (f.dels ?? 0)
        add(`f:${r.root}/${f.rel}`, [{ s: `${MARK[f.kind ?? 'edit']} `, bold: true }, { s: `${r.name}/${shown(f.rel, f.isDir)}`, color: c, cut: true }, ...nums(adds, dels)], 1)
      }
      if (files.length > 4) add('more', [{ s: `${files.length - 4} more files`, dim: true }], 1)
      return { id: s.id, color: c, wait: !!s.waitingFor, rows }
    })
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
