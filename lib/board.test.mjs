// node lib/board.test.mjs — lib/board.mjs: Jira against a fake server (Cloud and Data Center), a custom module.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { boardOf, jira, jiraAcli } from './board.mjs'

const results = []
const check = (name, got, want) => results.push([name, JSON.stringify(got) === JSON.stringify(want), got, want])

// A fake Jira: records each call; `cloud` false answers /search/jql with 404, as Data Center does.
const fake = cloud => {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      calls.push({ method: req.method, path: u.pathname, jql: u.searchParams.get('jql'), auth: req.headers.authorization, body: body ? JSON.parse(body) : null })
      const send = (code, v) => (res.writeHead(code, { 'Content-Type': 'application/json' }), res.end(v === undefined ? '' : JSON.stringify(v)))
      const p = u.pathname.replace('/rest/api/2', '')
      if (p === '/search/jql' && !cloud) return send(404, { errorMessages: ['no'] })
      if (p === '/search/jql' || p === '/search') return send(200, { issues: [{ key: 'PROJ-1', fields: { summary: 'Fix login', status: { name: 'To Do' } } }] })
      if (p === '/issue/PROJ-1' && req.method === 'GET') return send(200, { key: 'PROJ-1', fields: { summary: 'Fix login' } })
      if (p === '/issue/NOPE' || p === '/issue/NOPE/transitions') return send(404, { errorMessages: ['Issue does not exist'] })
      if (p === '/issue/PROJ-1/transitions' && req.method === 'GET')
        return send(200, {
          transitions: [
            { id: '11', name: 'Start work', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
            { id: '31', name: 'Resolve', to: { name: 'Closed', statusCategory: { key: 'done' } } },
          ],
        })
      if (p === '/myself') return send(200, cloud ? { accountId: 'acc-1' } : { name: 'will' })
      return send(204)
    })
  })
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

// Cloud: /search/jql, basic auth, accountId, a close by status category when no name matches.
{
  const j = await fake(true)
  const b = jira({ url: j.url }, { JIRA_API_TOKEN: 't', JIRA_EMAIL: 'w@x' })
  check('jira cloud: ready lines', await b.ready(), 'PROJ-1 - Fix login (To Do)')
  check('jira cloud: search path and default jql', [j.calls[0].path, /currentUser\(\)/.test(j.calls[0].jql)], ['/rest/api/2/search/jql', true])
  check('jira cloud: basic auth', j.calls[0].auth, `Basic ${Buffer.from('w@x:t').toString('base64')}`)
  j.calls.length = 0
  check('jira: claim gives the title', await b.claim('PROJ-1'), { title: 'Fix login' })
  check(
    'jira: claim moves by target name, assigns by accountId',
    j.calls.filter(c => c.method !== 'GET').map(c => [c.path, c.body]),
    [
      ['/rest/api/2/issue/PROJ-1/transitions', { transition: { id: '11' } }],
      ['/rest/api/2/issue/PROJ-1/assignee', { accountId: 'acc-1' }],
    ],
  )
  j.calls.length = 0
  await b.note('PROJ-1', 'abc1234 Fix the form')
  check('jira: note is a comment', [j.calls[0].path, j.calls[0].body], ['/rest/api/2/issue/PROJ-1/comment', { body: 'abc1234 Fix the form' }])
  j.calls.length = 0
  await b.close('PROJ-1', 'shipped (abc1234)')
  check(
    'jira: close moves into done, then comments',
    j.calls.filter(c => c.method === 'POST').map(c => c.body),
    [{ transition: { id: '31' } }, { body: 'Done: shipped (abc1234)' }],
  )
  check('jira: no open items', b.open('PROJ-1'), [])
  let err = null
  await b.claim('NOPE').catch(e => (err = e.message))
  check('jira: claim of a missing issue throws', /404/.test(err), true)
  j.close()
}

// Data Center: /search only, a PAT as Bearer, a name for the assignee, a status named in the config.
{
  const j = await fake(false)
  const b = jira({ url: `${j.url}/`, jql: 'project = PROJ', claim: 'start work', assign: true }, { JIRA_API_TOKEN: 'pat' })
  check('jira dc: ready falls back to /search', [await b.ready(), j.calls.map(c => c.path)], ['PROJ-1 - Fix login (To Do)', ['/rest/api/2/search/jql', '/rest/api/2/search']])
  check('jira dc: own jql, bearer', [j.calls[1].jql, j.calls[1].auth], ['project = PROJ', 'Bearer pat'])
  j.calls.length = 0
  await b.claim('PROJ-1')
  check('jira dc: transition by its own name, assignee by name', j.calls.filter(c => c.method === 'PUT' || c.method === 'POST').map(c => c.body), [{ transition: { id: '11' } }, { name: 'will' }])
  j.close()
}

// No token: one plain message.
{
  let err = null
  await jira({ url: 'http://127.0.0.1:1' }, {}).ready().catch(e => (err = e.message))
  check('jira: no token says what to set', /JIRA_API_TOKEN/.test(err), true)
}

// acli: the argv it runs, and both JSON shapes it may print.
{
  const ran = []
  const out = {
    search: JSON.stringify([{ key: 'PROJ-1', fields: { summary: 'Fix login', status: { name: 'To Do' } } }]),
    view: JSON.stringify({ key: 'PROJ-1', fields: { summary: 'Fix login' } }),
  }
  const b = jiraAcli({ jql: 'project = PROJ' }, args => (ran.push(args), { status: 0, stdout: out[args[2]] ?? '' }))
  check('acli: ready', b.ready(), 'PROJ-1 - Fix login (To Do)')
  check('acli: search argv', ran[0], ['jira', 'workitem', 'search', '--jql', 'project = PROJ', '--fields', 'key,summary,status', '--limit', '50', '--json'])
  ran.length = 0
  check('acli: claim gives the title', b.claim('PROJ-1'), { title: 'Fix login' })
  check('acli: claim moves and self-assigns', ran.slice(1), [
    ['jira', 'workitem', 'transition', '--key', 'PROJ-1', '--status', 'In Progress', '--yes'],
    ['jira', 'workitem', 'assign', '--key', 'PROJ-1', '--assignee', '@me', '--yes'],
  ])
  ran.length = 0
  b.note('PROJ-1', 'abc1234 Fix the form')
  b.close('PROJ-1', 'shipped')
  check('acli: note and close', ran, [
    ['jira', 'workitem', 'comment', 'create', '--key', 'PROJ-1', '--body', 'abc1234 Fix the form'],
    ['jira', 'workitem', 'transition', '--key', 'PROJ-1', '--status', 'Done', '--yes'],
    ['jira', 'workitem', 'comment', 'create', '--key', 'PROJ-1', '--body', 'Done: shipped'],
  ])
  check('acli: keys upper case', b.key('proj-7'), 'PROJ-7')
  out.search = JSON.stringify({ things: [{ key: 'PROJ-3' }] })
  let shape = null
  try {
    b.ready()
  } catch (e) {
    shape = e.message
  }
  check('acli: an unknown JSON shape fails loud', /cannot read \(keys: things\)/.test(shape), true)
  out.search = JSON.stringify({ issues: [], total: 0 })
  check('acli: an empty result is empty', b.ready(), '')
  const stuck = jiraAcli({}, () => ({ status: null, error: { code: 'ETIMEDOUT' } }))
  let slow = null
  try {
    stuck.ready()
  } catch (e) {
    slow = e.message
  }
  check('acli: a hang times out', /no answer in 30 s/.test(slow), true)
  const noDone = jiraAcli({}, args => (args[2] === 'transition' ? { status: 1, stderr: 'Resolution is required' } : { status: 0, stdout: '' }))
  let held = null
  try {
    noDone.close('PROJ-1', 'x')
  } catch (e) {
    held = e.message
  }
  check('acli: a close that cannot move fails', /Resolution is required/.test(held), true)
  out.search = JSON.stringify({ issues: [{ key: 'PROJ-2', summary: 'Flat', status: 'In Review' }] })
  check('acli: flat JSON shape', b.ready(), 'PROJ-2 - Flat (In Review)')
  const missing = jiraAcli({}, () => ({ status: 1, stderr: 'work item not found' }))
  let err = null
  try {
    missing.claim('NOPE-1')
  } catch (e) {
    err = e.message
  }
  check('acli: a missing item fails the claim', /not found/.test(err), true)
  const none = jiraAcli({}, () => ({ status: null, error: { code: 'ENOENT' } }))
  try {
    none.ready()
  } catch (e) {
    err = e.message
  }
  check('acli: not installed says so', /acli not on PATH/.test(err), true)
  check('jira picks acli by default, rest on ask', [(await boardOf({ board: 'jira' }, '.')).ready === undefined, typeof (await boardOf({ board: 'jira', jira: { via: 'rest' } }, '.')).ready], [false, 'function'])
}

// A custom module, by a path relative to the config's folder.
{
  const dir = mkdtempSync(`${tmpdir()}/peers-board-`)
  writeFileSync(`${dir}/mine.mjs`, "export default cfg => ({ name: 'mine', ready: () => `from ${cfg.mine.team}`, claim: id => ({ title: `T ${id}` }) })\n")
  const b = await boardOf({ board: './mine.mjs', mine: { team: 'red' } }, dir)
  check('custom: its calls, defaults for the rest', [await b.ready(), await b.claim('X-1'), b.open('X-1'), b.on()], ['from red', { title: 'T X-1' }, [], true])
  check('default: backlog', (await boardOf({}, dir)).name, 'backlog')
}

let bad = 0
for (const [name, ok, got, want] of results) {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
process.exit(bad ? 1 : 0)
