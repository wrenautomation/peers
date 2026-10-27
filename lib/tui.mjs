// `peers tui`: the /peers-view pane as a full-screen terminal app, for any terminal split. No agent session:
// it reads the `peers view` server (lib/view.mjs) and draws lib/rows.mjs, the pane's own row model, with Ink.
import { spawn } from 'node:child_process'
import { get } from 'node:http'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import hljs from './vendor/highlight.mjs'
import { Box, Text, createElement as h, render, useApp, useEffect, useInput, useRef, useState, useStdout } from './vendor/ink.mjs'
import { ADD, DEL, HELP, cast, docRow, fileHead, gapText, gaps, helpRows, hunkHead, listRows, onlyQuery, terms } from './rows.mjs'

const PORT = Number(process.env.PEERS_VIEW_PORT) || 6421
const POLL_MS = 1500
// The focused row: a blue no session color uses, so the ring never reads as an author.
const RING = '#264f78'
const TINT = { '+': '#1f3a2a', '-': '#3d2226' }
// Syntax colors in soft tones, no yellow. Comments are the one gray: they are not the change.
const THEME = {
  keyword: '#c792ea',
  built_in: '#82aaff',
  type: '#82aaff',
  title: '#82aaff',
  string: '#c3e88d',
  number: '#f78c6c',
  literal: '#f78c6c',
  regexp: '#f07178',
  attr: '#89ddff',
  property: '#89ddff',
  meta: '#89ddff',
  tag: '#f07178',
  name: '#f07178',
  comment: '#8e8e93',
}

// undefined: unchanged (204); null: not found.
const getJson = path =>
  new Promise((ok, no) => {
    const r = get(`http://127.0.0.1:${PORT}${path}`, res => {
      let b = ''
      res.setEncoding('utf8')
      res.on('data', c => (b += c))
      res.on('end', () => ok(res.statusCode === 204 ? undefined : res.statusCode === 200 ? JSON.parse(b) : null))
    })
    r.on('error', no)
    r.setTimeout(5000, () => r.destroy(new Error('timeout')))
  })

// One line of code in syntax color: highlight.js gives HTML, so walk its spans.
const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'" }
const langOf = rel => {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
  return ext && hljs.getLanguage(ext) ? ext : null
}
export const highlight = (s, lang) => {
  if (!lang || !s) return [{ s }]
  let html
  try {
    html = hljs.highlight(s, { language: lang, ignoreIllegals: true }).value
  } catch {
    return [{ s }]
  }
  const out = []
  const stack = []
  for (const m of html.matchAll(/<span class="hljs-([\w-]+)[^"]*">|<\/span>|[^<]+/g)) {
    if (m[1]) stack.push(m[1])
    else if (m[0] === '</span>') stack.pop()
    else out.push({ s: m[0].replace(/&(?:lt|gt|amp|quot|#x27|#39);/g, x => ENT[x]), color: [...stack].reverse().map(x => THEME[x]).find(Boolean) })
  }
  return out
}

// A diff as rows: the owner's title over each hunk, then each line with its number, an author bar, a tinted sign.
// Lines no hunk shows get one row, as GitHub's expander: before a hunk, between two, after the last.
export const diffRows = (hunks, rel, col, nameOf, size = 0) => {
  const lang = langOf(rel)
  const out = []
  const gap = new Map(gaps(hunks, size).map(g => [g.before, g]))
  const gapRow = i => gap.has(i) && out.push({ key: `gap:${i}`, spans: [{ s: gapText(gap.get(i)), dim: true }] })
  for (const [i, hunk] of hunks.entries()) {
    if (!gapRow(i) && i) out.push({ key: `gap:${i}`, spans: [] })
    out.push({ key: `h:${i}`, spans: hunkHead(hunk, col, nameOf) })
    let o = hunk.old
    let n = hunk.new
    for (const [j, x] of hunk.lines.entries()) {
      const at = x.t === '-' ? o++ : n++
      if (x.t === ' ') o++
      const bg = TINT[x.t]
      const sign = x.t === '+' ? { s: '+ ', color: ADD, bold: true, bg } : x.t === '-' ? { s: '- ', color: DEL, bold: true, bg } : { s: '  ' }
      out.push({
        key: `h:${i}:${j}`,
        spans: [
          { s: `${String(at).padStart(5)} `, dim: true },
          x.t === ' ' ? { s: ' ' } : { s: '▌', color: col(x.a ?? hunk.a) },
          sign,
          ...highlight(x.s, lang).map(sp => ({ ...sp, bg })),
        ],
        fill: bg,
      })
    }
  }
  gapRow(hunks.length)
  return out
}

const width = r => r.spans.reduce((n, x) => n + x.s.length, 0)
const height = (r, cols) => Math.max(1, Math.ceil(width(r) / Math.max(1, cols - (r.indent ?? 0))))

// The ring lights a row's name spans only; a row with no name span lights whole.
const Row = ({ row, cols, on }) => (row.indent ? h(Box, { paddingLeft: row.indent }, h(Line, { row, cols: cols - row.indent, on })) : h(Line, { row, cols, on }))
const Line = ({ row, cols, on }) => {
  const named = row.spans.some(x => x.hit)
  const lit = x => on && (!named || x.hit)
  return h(
    Text,
    { wrap: 'wrap' },
    ...(row.spans.length ? row.spans : [{ s: ' ' }]).map((x, i) =>
      h(
        Text,
        { key: i, color: x.color, backgroundColor: lit(x) ? RING : x.bg, bold: x.bold || lit(x), dimColor: x.dim && !lit(x), strikethrough: x.strike, underline: x.under },
        x.s,
      ),
    ),
    // A tinted diff line, or the ring of a row with no name span, fills to the edge.
    (on && !named) || row.fill ? h(Text, { backgroundColor: on && !named ? RING : row.fill }, ' '.repeat(Math.max(0, cols - (width(row) % cols || cols)))) : null,
  )
}

const Bar = ({ items, hint }) =>
  h(
    Box,
    { gap: 2 },
    ...items.map(([key, label, on]) =>
      h(Text, { key }, h(Text, { color: '#82aaff', bold: true }, key), ' ', h(Text, { bold: on, underline: on, dimColor: !on }, label)),
    ),
    h(Text, { dimColor: true }, hint),
  )

const App = ({ only }) => {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [size, setSize] = useState({ cols: stdout.columns || 80, rows: stdout.rows || 24 })
  const [ix, setIx] = useState({ sig: '', repos: [] })
  const [fold, setFold] = useState({ flip: [] })
  const [help, setHelp] = useState(false)
  const [focus, setFocus] = useState(null)
  const [body, setBody] = useState(null)
  const [sel, setSel] = useState(null)
  const [off, setOff] = useState(0)
  const [now, setNow] = useState(Date.now())
  const top = useRef(0)
  const live = useRef({ ix, focus, body })
  live.current = { ix, focus, body }

  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 })
    stdout.on('resize', onResize)
    return () => void stdout.off('resize', onResize)
  }, [stdout])

  // The open file's document or diff, loaded again when its mtime moves.
  const load = useRef(null)
  load.current = async ix2 => {
    const { focus: f, body: b } = live.current
    if (!f) return
    const file = ix2.repos.find(r => r.root === f.root)?.files.find(x => x.rel === f.rel)
    const mtime = file?.mtime ?? 0
    if (b && b.root === f.root && b.rel === f.rel && b.mode === f.mode && b.mtime === mtime) return
    const q = `?root=${encodeURIComponent(f.root)}&rel=${encodeURIComponent(f.rel)}`
    const next = !file
      ? { ...f, mtime }
      : f.mode === 'doc'
        ? { ...f, mtime, lines: (await getJson(`/api/doc${q}`))?.lines ?? [] }
        : { ...f, mtime, hunks: (await getJson(`/api/hunks${q}`)) ?? [] }
    // A key may have moved on while this loaded.
    const now = live.current.focus
    if (now && now.root === f.root && now.rel === f.rel && now.mode === f.mode) {
      live.current.body = next
      setBody(next)
    }
  }

  // Poll the server's index by its sig.
  useEffect(() => {
    let spawned = false
    let stop = false
    const tick = async () => {
      const cur = live.current
      try {
        const next = await getJson(`/api/index?sig=${cur.ix.sig}${onlyQuery(only)}`)
        const ix2 = next ?? (cur.ix.error ? { ...cur.ix, error: undefined } : cur.ix)
        if (ix2 !== cur.ix) setIx(ix2)
        await load.current(ix2)
      } catch {
        // No server: launchd keeps one up; else start one, as the pane does.
        if (!spawned) {
          spawned = true
          spawn(process.execPath, [fileURLToPath(new URL('../bin/peers.mjs', import.meta.url)), 'view', '--no-open'], { stdio: 'ignore', detached: true }).unref()
        }
        if (!cur.ix.error) setIx({ ...cur.ix, error: `No peers view server on 127.0.0.1:${PORT}. Starting one…` })
      }
      setNow(Date.now())
      if (!stop) timer = setTimeout(tick, POLL_MS)
    }
    let timer = setTimeout(tick, 0)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [])

  const { cols } = size
  const room = Math.max(3, size.rows - 3)
  const { col, nameOf } = cast(ix)
  const open = f => {
    setBody(null)
    setOff(0)
    setFocus(f)
    live.current = { ...live.current, focus: f, body: null }
    setNow(Date.now())
    if (f) load.current(ix).catch(() => {})
  }

  // The file list: arrows walk the rows a press acts on; the window follows the selection.
  const rows = focus ? [] : listRows(ix, fold, now, cols - 1)
  const keys = rows.filter(r => r.press).map(r => r.key)
  const cur = keys.includes(sel) ? sel : (keys[0] ?? null)
  const at = Math.max(0, rows.findIndex(r => r.key === cur))
  const fit = (list, from) => {
    const out = []
    let used = 0
    for (let i = from; i < list.length; i++) {
      used += height(list[i], cols)
      if (used > room) break
      out.push(list[i])
    }
    return out
  }
  if (!focus) {
    if (at < top.current) top.current = at
    while (top.current < at && fit(rows, top.current).every(r => r.key !== cur)) top.current++
    top.current = Math.min(top.current, Math.max(0, rows.length - 1))
  }

  // One open file: its document or diff, scrolled by line.
  const head = focus ? fileHead(ix, focus) : null
  const ready = focus && body && body.root === focus.root && body.rel === focus.rel && body.mode === focus.mode
  const lines = !focus
    ? []
    : !head.file
      ? [{ key: 'gone', spans: [{ s: 'Committed or reverted: nothing uncommitted in this file now.' }] }]
      : !ready
        ? [{ key: 'loading', spans: [{ s: 'Loading…', dim: true }] }]
        : focus.mode === 'doc'
          ? (body.lines ?? []).map((x, i) => ({ key: `l:${i}`, spans: docRow(x, col) }))
          : (body.hunks ?? []).length
            ? diffRows(body.hunks, focus.rel, col, nameOf, head.file.size)
            : [{ key: 'none', spans: [{ s: 'No text diff (binary, empty or mode only).' }] }]
  const maxOff = Math.max(0, lines.length - 1)

  useInput((input, key) => {
    if (input === '?') return setHelp(v => !v)
    if (help) return key.escape || input === 'q' ? setHelp(false) : undefined
    if (input === 'q' || (key.escape && !focus)) return exit()
    if (!focus) {
      const i = keys.indexOf(cur)
      if (key.downArrow || input === 'j') return setSel(keys[Math.min(keys.length - 1, i + 1)] ?? null)
      if (key.upArrow || input === 'k') return setSel(keys[Math.max(0, i - 1)] ?? null)
      if (key.pageDown || input === ' ') return setSel(keys[Math.min(keys.length - 1, i + 10)] ?? null)
      if (key.pageUp) return setSel(keys[Math.max(0, i - 10)] ?? null)
      const row = rows.find(r => r.key === cur)
      if (!row?.press) return
      const isFold = 'fold' in row.press
      const shut = isFold && row.spans[0]?.s.startsWith('▶')
      if (key.return || (isFold && ((key.rightArrow && shut) || (key.leftArrow && !shut)))) {
        if (!isFold) return open(row.press.open)
        const id = row.press.fold
        setFold(v => ({ ...v, flip: v.flip.includes(id) ? v.flip.filter(x => x !== id) : [...v.flip.slice(-200), id] }))
      }
      return
    }
    if (input === 'b' || key.escape || key.leftArrow) return open(null)
    if (input === 'd' && focus.mode !== 'doc') return open({ ...focus, mode: 'doc' })
    if (input === 'f' && focus.mode !== 'diff') return open({ ...focus, mode: 'diff' })
    if (key.downArrow || input === 'j') return setOff(o => Math.min(maxOff, o + 1))
    if (key.upArrow || input === 'k') return setOff(o => Math.max(0, o - 1))
    if (key.pageDown || input === ' ') return setOff(o => Math.min(maxOff, o + room - 1))
    if (key.pageUp) return setOff(o => Math.max(0, o - room + 1))
    if (input === 'g') return setOff(0)
    if (input === 'G') return setOff(Math.max(0, lines.length - room))
  })

  if (help)
    return h(
      Box,
      { flexDirection: 'column', width: cols },
      h(Bar, { items: [['?', 'close help', true]], hint: 'esc closes' }),
      h(Text, null, ' '),
      ...helpRows(focus ? HELP.file : HELP.list, focus ? [['g G', 'top, end'], ['space', 'page down'], ['q', 'quit']] : [['← →', 'fold a session'], ['space', 'page down'], ['q', 'quit']]).map(r =>
        h(Row, { key: r.key, row: r, cols }),
      ),
    )
  if (!focus)
    return h(
      Box,
      { flexDirection: 'column', width: cols },
      h(Bar, { items: [], hint: '↑↓ move · enter opens · ? keys · q quits' }),
      h(Text, null, ' '),
      ...fit(rows, top.current).map(r => h(Row, { key: r.key, row: r, cols, on: r.key === cur })),
    )
  return h(
    Box,
    { flexDirection: 'column', width: cols },
    h(Bar, {
      items: [
        ['b', 'back', false],
        ['d', 'document', focus.mode === 'doc'],
        ['f', 'diff', focus.mode === 'diff'],
      ],
      hint: `↑↓ scroll · ? keys · q quits${lines.length > room ? `  ${Math.min(off + 1, lines.length)}/${lines.length}` : ''}`,
    }),
    h(Row, { row: { key: 'head', spans: head.spans }, cols }),
    ...fit(lines, Math.min(off, maxOff)).map(r => h(Row, { key: r.key, row: r, cols })),
  )
}

// The alternate screen keeps the shell's scrollback clean; Ink draws inside it.
export const tui = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('peers tui: needs a terminal. For a page, run `peers view`.')
    process.exit(1)
  }
  process.stdout.write('\x1b[?1049h\x1b[H')
  const leave = () => process.stdout.write('\x1b[?1049l')
  process.on('exit', leave)
  // `peers tui wren ./lander`: only the repos those words match.
  const only = terms(process.argv.slice(3), process.cwd(), homedir())
  const app = render(h(App, { only }), { exitOnCtrlC: true, patchConsole: true })
  await app.waitUntilExit()
  process.exit(0)
}
