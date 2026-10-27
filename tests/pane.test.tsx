import { expect, mock, test } from 'claude-code/testing'

// The /peers pane against a fake `peers view` server: a file list, then one file as a document.
const S1 = 'aaaa1111-x'
const S2 = 'bbbb2222-y'
const S3 = 'cccc3333-z'
const INDEX = {
  sig: 's1',
  repos: [
    {
      root: '/r/lab',
      name: 'lab',
      sessions: [
        { id: S1, name: 'WA-901', title: 'launch plan', doing: 'Move the launch to Monday', started: 1, updated: 60_000, commits: [] },
        { id: S2, name: 's-bbbb', title: null, doing: null, started: 2, updated: 1, commits: [] },
        { id: S3, name: 's-cccc', title: null, doing: null, started: 3, updated: 2, commits: [{ sha: 'abcdef1234567', at: 5_000, files: 13, t: 'Add the comment flow' }] },
      ],
      files: [
        {
          rel: 'plan.md',
          authors: [S1, S2],
          isNew: false,
          mtime: 5,
          adds: 3,
          dels: 1,
          titles: ['Move the launch to Monday'],
          changes: [
            { line: 2, t: 'Move the launch to Monday', said: true, a: S1, adds: 1, dels: 1 },
            { line: 3, t: 'Launch plan', said: false, a: S2, adds: 2, dels: 0 },
          ],
        },
      ],
      feed: [{ kind: 'edit', at: 60_000, a: S1, t: 'Move the launch to Monday', rels: ['plan.md'] }],
    },
  ],
}
const DOC = {
  text: '',
  lines: [
    { k: '=', s: '# Launch plan', a: null, fence: false },
    { k: '~', s: 'We ship on Monday.', a: S1, pre: '', runs: [{ t: '=', s: 'We ship on ' }, { t: '-', s: 'Friday' }, { t: '+', s: 'Monday' }, { t: '=', s: '.' }], fence: false },
    { k: '+', s: '- Record the demo', a: S2, pre: '- ', fence: false },
  ],
}
const HUNKS = [{ old: 1, new: 1, at: '', lines: [{ t: '-', s: 'We ship on Friday.', a: S1 }, { t: '+', s: 'We ship on Monday.', a: S1 }] }]

const PANE = {
  plugin: 'peers',
  component: 'Pane',
  requestId: 'peers',
  props: { title: 'Peers', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane lists files and opens one as a document and a diff', async ($, on) => {
  mock.clock(on, { now: 65_000 })
  on('http.fetch', (_, e) => {
    const body = e.url.includes('/api/index') ? INDEX : e.url.includes('/api/doc') ? DOC : HUNKS
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  let open = false
  const opens: unknown[] = []
  on('ui.open', (_, e) => {
    open = true
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: open ? [{ id: 'peers', title: 'Peers', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('ui.close', () => {
    open = false
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'peers-view' } }))
  const run = () =>
    $.command.run({ command: 'peers-view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  // A toggle: it opens with the keys and Escape to close, then a second run closes it.
  expect((await run()).text).toBeUndefined()
  expect(opens[0]).toMatchObject({ id: 'peers', focus: true, closeOnEscape: true })
  await run()
  expect(open).toBe(false)
  await run()

  for (const surface of ['terminal', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /launch plan/ }))?.text).toContain('WA-901')
    // Zoom 2: the file under each session that owns a change in it, with the said title.
    expect(await ui.find({ key: `f:${S2}:/r/lab/plan.md` })).toBeDefined()
    expect((await ui.find({ key: `f:${S1}:/r/lab/plan.md` }))?.text).toContain('Move the launch to Monday')
    // Authors by name in their color, no dots; the fold arrow is the bold full triangle.
    const group = JSON.stringify(await ui.find({ key: `s:/r/lab:${S1}` }))
    expect(group).toContain('▼')
    expect(group).not.toContain('●')
    expect((await ui.find({ key: `f:${S1}:/r/lab/plan.md` }))?.text).toContain('s-bbbb')
    // All its work committed: the session still shows, with its commit.
    expect((await ui.find({ key: `s:/r/lab:${S3}` }))?.text).toContain('nothing open')
    expect((await ui.find({ type: 'Text', text: /Add the comment flow/ }))?.text).toContain('abcdef12  Add the comment flow  13 files')
    // Zoom 1 folds the files away; a press on a group opens that one group.
    await ui.press({ key: 'zoom1' })
    expect(await ui.find({ key: `f:${S1}:/r/lab/plan.md` })).toBeUndefined()
    await ui.press({ key: 'zoom3' })
    expect((await ui.find({ type: 'Text', text: /Launch plan/ }))?.text).toContain('+2')
    await ui.press({ key: 'zoom2' })
    await ui.press({ key: `f:${S1}:/r/lab/plan.md` })
    expect((await ui.find({ type: 'Text', text: /We ship on/ }))?.text).toBe('We ship on FridayMonday.')
    expect((await ui.find({ type: 'Text', text: /Record the demo/ }))?.text).toBe('- Record the demo')
    await ui.press({ key: 'diff' })
    const code: any = await ui.find({ type: 'Code' })
    expect(code?.props?.format).toBe('diff')
    expect(code?.props?.source).toBe('@@ -1,1 +1,1 @@\n-We ship on Friday.\n+We ship on Monday.')
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /launch plan/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the turn.step hook passes every chunk on unchanged', async ($, on) => {
  const chunks = [
    { kind: 'text', index: 0, text: 'Rename cap to dailyCap.\n' },
    { kind: 'tool', index: 1, id: 'tu1', name: 'Edit' },
    { kind: 'tool', index: 2, id: 'tu2', name: 'Edit' },
  ] as const
  const result = { turnId: 't', index: 0, answer: 'Rename cap to dailyCap.', toolUses: [], stopReason: 'tool_use' as const, usage: null }
  on('turn.step', async function* () {
    for (const c of chunks) yield c
    return result
  })
  const seen: unknown[] = []
  const it = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
  for (;;) {
    const r = await it.next()
    if (r.done) {
      expect(r.value).toEqual(result)
      break
    }
    seen.push(r.value)
  }
  expect(seen).toEqual([...chunks])
})

test('the band shows one line, and [+] opens a row per peer', async ($, on) => {
  mock.clock(on, { now: 65_000 })
  // A peer the ledgers gave: the band reads it from state.
  const PEERS = [{ session: S1, name: 'WA-901', files: 3, shared: 1, last: 5_000, adds: 4, dels: 2, doing: 'Move the launch to Monday', sharedFiles: ['plan.md'] }]
  on('ui.focus', () => ({}))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(INDEX) } }))
  const opens: any[] = []
  on('ui.open', (_, e) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('state.get', ($, e: any, next) => (JSON.stringify(e).includes('"peers"}') || e.key === 'peers' ? { value: { value: PEERS, version: 1 } } : next(e)))
  const ui = await $.ui.mount({
    plugin: 'peers',
    component: 'AbovePrompt',
    requestId: 'band',
    surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as any)
  expect((await ui.find({ key: `peer:${S1}` }))?.text).toContain('WA-901 3|1 +4 −2')
  // Peers wrap by whole peer left of [+]; [+] is the last child, flush right beside the engine's [-].
  const band: any = await ui.find({ type: 'Box' })
  expect(band).toMatchObject({ props: { width: '100%', paddingLeft: 1 } })
  expect(band.children.at(-1)).toMatchObject({ props: { key: 'peers-wide' } })
  expect(band.children[0]).toMatchObject({ props: { flexWrap: 'wrap', flexGrow: 1, columnGap: 3 } })
  expect((await ui.find({ type: 'Text', text: /shared: plan.md/ }))).toBeUndefined()
  // The ring on the band paints it one theme blue, so the engine's invert draws a blue bar.
  expect(JSON.stringify(await ui.find({ key: 'peers-band' }))).not.toContain('suggestion')
  await $.ui.focus({ component: 'AbovePrompt', requestId: 'band', plugin: 'peers', element: 'peers-band', origin: { kind: 'person' } })
  const lit = JSON.stringify(await ui.find({ key: 'peers-band' }))
  expect(lit).toContain('suggestion')
  expect(lit).not.toContain('dimColor":true')
  // A press on one peer opens the pane on that session's group.
  await ui.press({ key: `peer:${S1}` })
  expect(opens[0]).toMatchObject({ id: 'peers', focus: true })
  await ui.press({ key: 'peers-wide' })
  expect((await ui.find({ type: 'Text', text: /Move the launch to Monday/ }))?.text).toContain('WA-901')
  expect((await ui.find({ type: 'Text', text: /shared: plan.md/ }))).toBeDefined()
  await ui.press({ key: 'peers-wide' })
  expect((await ui.find({ type: 'Text', text: /shared: plan.md/ }))).toBeUndefined()
  await ui.unmount()
})
