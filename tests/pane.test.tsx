import { expect, mock, test } from 'claude-code/testing'

// The /peers pane against a fake `peers view` server: a file list, then one file as a document.
const S1 = 'aaaa1111-x'
const S2 = 'bbbb2222-y'
const INDEX = {
  sig: 's1',
  repos: [
    {
      root: '/r/lab',
      name: 'lab',
      sessions: [
        { id: S1, name: 'WA-901', title: 'launch plan', updated: 1 },
        { id: S2, name: 's-bbbb', title: null, updated: 1 },
      ],
      files: [{ rel: 'plan.md', authors: [S1, S2], isNew: false, mtime: 5, adds: 3, dels: 1 }],
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'peers-view' } }))
  await $.command.run({
    command: 'peers-view',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  for (const surface of ['terminal', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /launch plan/ }))?.text).toContain('WA-901')
    await ui.press({ key: 'f:/r/lab/plan.md' })
    expect((await ui.find({ type: 'Text', text: /We ship on/ }))?.text).toBe('We ship on FridayMonday.')
    expect((await ui.find({ type: 'Text', text: /Record the demo/ }))?.text).toBe('- Record the demo')
    await ui.press({ key: 'diff' })
    expect((await ui.find({ type: 'Text', text: /^\+ We ship/ }))?.text).toBe('+ We ship on Monday.')
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /launch plan/ })).toBeDefined()
    await ui.unmount()
  }
})
