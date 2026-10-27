// The task board behind `peers ready | claim | commit | close`: one adapter, picked by `board` in ~/.claude/peers/config.json.
//   "backlog" (default): Backlog.md, `backlog` on PATH.
//   "jira": settings in `jira` ({ via, jql, claim, close, assign }).
//     via "acli" (default): Atlassian's own CLI, signed in already (`acli jira auth login`); peers holds no token.
//     via "rest": REST v2 for Cloud or Data Center, with `url`. The token only from env: JIRA_API_TOKEN,
//     with JIRA_EMAIL for Cloud (basic auth), without it a Data Center PAT (Bearer).
//   a path to an .mjs file (relative to the config's folder): its default export, (config) => adapter.
// An adapter: { name, ready() -> lines, claim(id) -> { title }, note(id, text), open(id) -> unchecked items, close(id, reason) }.
// Only the CLI calls it: the claim keeps the title in the ledger, so the mod and the view never need the board or its token.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Windows: npm's backlog.cmd runs only through a shell, so each argument goes quoted for cmd.
const backlogRun = (args, opts = {}) =>
  process.platform !== 'win32'
    ? spawnSync('backlog', args, { encoding: 'utf8', ...opts })
    : spawnSync('backlog', args.map(a => `"${a.replace(/"/g, '""')}"`), { encoding: 'utf8', ...opts, shell: true, windowsHide: true })

export const backlog = () => {
  let has
  const on = () => (has ??= backlogRun(['--version'], { stdio: 'ignore' }).status === 0)
  const run = args => {
    const r = backlogRun(args)
    if (r.status !== 0) throw new Error(`backlog ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`)
    return r.stdout ?? ''
  }
  return {
    name: 'backlog',
    on,
    ready: () => {
      if (!on()) throw new Error('backlog not on PATH (npm i -g backlog.md)')
      return run(['task', 'list', '-s', 'To Do', '--plain'])
    },
    claim: id => {
      if (!on()) return { title: null }
      run(['task', 'edit', id, '-s', 'In Progress'])
      return { title: /^Task \S+ - (.+)$/m.exec(run(['task', 'view', id, '--plain']))?.[1] ?? null }
    },
    note: (id, text) => on() && run(['task', 'edit', id, '--append-notes', text]),
    // Big tasks carry acceptance criteria and a DoD per phase: every item is ticked before close.
    open: id => (on() ? run(['task', 'view', id, '--plain']).split('\n').filter(x => /^\s*- \[ \] #\d+/.test(x)) : []),
    openHint: id => `Tick each: backlog task edit ${id} --check-ac <n> | --check-dod <n>.`,
    // Done stays in backlog/tasks/, so the board's Done column lists it. The archive is for dropped tasks.
    close: (id, reason) => on() && run(['task', 'edit', id, '-s', 'Done', '--final-summary', reason]),
  }
}

const JQL = 'assignee = currentUser() AND statusCategory = "To Do" ORDER BY priority DESC, updated DESC'

// acli prints JSON whose shape its docs leave out: a list or { issues }, each item Jira's REST shape or flat.
const items = v => (Array.isArray(v) ? v : v?.issues ?? v?.workItems ?? v?.values ?? [])
const summaryOf = i => i?.fields?.summary ?? i?.summary ?? null
const statusOf = i => i?.fields?.status?.name ?? i?.status?.name ?? (typeof i?.status === 'string' ? i.status : null)
// A login that expired may wait for input: never hang the CLI on it.
const acliRun = args => spawnSync('acli', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })

export const jiraAcli = (cfg = {}, run = acliRun) => {
  const call = args => {
    const r = run(args)
    if (r.error?.code === 'ENOENT') throw new Error('acli not on PATH: install Atlassian CLI, then acli jira auth login')
    if (r.error?.code === 'ETIMEDOUT') throw new Error(`acli ${args.slice(1, 3).join(' ')}: no answer in 30 s (signed in? acli jira auth status)`)
    if (r.status !== 0) throw new Error(`acli ${args.slice(1, 3).join(' ')}: ${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`)
    return r.stdout ?? ''
  }
  const json = args => JSON.parse(call([...args, '--json']) || 'null')
  // A shape we do not know fails loud, never as an empty list.
  const list = v => {
    const got = items(v)
    if (!got.length && v && !Array.isArray(v) && Object.keys(v).length && !('total' in v)) throw new Error(`acli search printed JSON peers cannot read (keys: ${Object.keys(v).join(', ')})`)
    return got
  }
  // A status change takes the status's name. A claim still binds when the workflow names it otherwise.
  const move = (id, status) => {
    try {
      call(['jira', 'workitem', 'transition', '--key', id, '--status', status, '--yes'])
    } catch (e) {
      process.stderr.write(`peers: ${e.message} (set jira.claim / jira.close to your workflow's status names)\n`)
    }
  }
  const comment = (id, text) => call(['jira', 'workitem', 'comment', 'create', '--key', id, '--body', text])
  return {
    name: 'jira',
    key: id => id.toUpperCase(),
    on: () => true,
    ready: () =>
      list(json(['jira', 'workitem', 'search', '--jql', cfg.jql || JQL, '--fields', 'key,summary,status', '--limit', '50']))
        .map(i => `${i.key} - ${summaryOf(i) ?? ''}${statusOf(i) ? ` (${statusOf(i)})` : ''}`)
        .join('\n'),
    claim: id => {
      const title = summaryOf(json(['jira', 'workitem', 'view', id, '--fields', 'summary']))
      move(id, cfg.claim || 'In Progress')
      if (cfg.assign !== false)
        try {
          call(['jira', 'workitem', 'assign', '--key', id, '--assignee', '@me', '--yes'])
        } catch (e) {
          process.stderr.write(`peers: ${e.message}\n`)
        }
      return { title }
    },
    note: comment,
    open: () => [],
    openHint: () => '',
    // The move first, and it must land: a ticket that is not Done stays bound. The comment after it only warns.
    close: (id, reason) => {
      call(['jira', 'workitem', 'transition', '--key', id, '--status', cfg.close || 'Done', '--yes'])
      try {
        comment(id, `Done: ${reason}`)
      } catch (e) {
        process.stderr.write(`peers: ${e.message}\n`)
      }
    },
  }
}

export const jira = (cfg = {}, env = process.env, fetchFn = globalThis.fetch) => {
  const url = (cfg.url || env.JIRA_URL || '').replace(/\/+$/, '')
  const token = env.JIRA_API_TOKEN
  const auth = env.JIRA_EMAIL ? `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${token}`).toString('base64')}` : `Bearer ${token}`
  const api = async (method, path, body) => {
    if (!url || !token) throw new Error('jira: set jira.url in ~/.claude/peers/config.json (or JIRA_URL) and JIRA_API_TOKEN (+ JIRA_EMAIL on Cloud)')
    const r = await fetchFn(`${url}/rest/api/2${path}`, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await r.text()
    if (!r.ok) throw Object.assign(new Error(`jira ${method} ${path}: ${r.status} ${text.slice(0, 200)}`), { status: r.status })
    return text ? JSON.parse(text) : null
  }
  // Cloud moved search to /search/jql; Data Center has only /search.
  const search = async jql => {
    const q = `?jql=${encodeURIComponent(jql)}&fields=summary,status&maxResults=50`
    try {
      return await api('GET', `/search/jql${q}`)
    } catch (e) {
      if (e.status !== 404 && e.status !== 405 && e.status !== 410) throw e
      return api('GET', `/search${q}`)
    }
  }
  // A status change is a transition: by its name or its target's name, else the first into that status category.
  const move = async (id, want, category) => {
    const { transitions = [] } = await api('GET', `/issue/${encodeURIComponent(id)}/transitions`)
    const w = String(want ?? '').toLowerCase()
    const t =
      transitions.find(t => t.name?.toLowerCase() === w || t.to?.name?.toLowerCase() === w) ??
      transitions.find(t => t.to?.statusCategory?.key === category)
    if (!t) return `no transition to "${want}" from here (${transitions.map(t => t.name).join(', ') || 'none'})`
    await api('POST', `/issue/${encodeURIComponent(id)}/transitions`, { transition: { id: t.id } })
    return null
  }
  const warn = m => m && process.stderr.write(`peers: ${m}\n`)
  return {
    name: 'jira',
    key: id => id.toUpperCase(),
    on: () => true,
    ready: async () =>
      ((await search(cfg.jql || JQL)).issues ?? []).map(i => `${i.key} - ${i.fields?.summary ?? ''}${i.fields?.status?.name ? ` (${i.fields.status.name})` : ''}`).join('\n'),
    claim: async id => {
      const issue = await api('GET', `/issue/${encodeURIComponent(id)}?fields=summary`)
      warn(await move(id, cfg.claim || 'In Progress', 'indeterminate'))
      // Cloud names people by accountId, Data Center by name.
      if (cfg.assign !== false) {
        const me = await api('GET', '/myself')
        await api('PUT', `/issue/${encodeURIComponent(id)}/assignee`, me.accountId ? { accountId: me.accountId } : { name: me.name }).catch(e => warn(e.message))
      }
      return { title: issue.fields?.summary ?? null }
    },
    note: (id, text) => api('POST', `/issue/${encodeURIComponent(id)}/comment`, { body: text }),
    open: () => [],
    openHint: () => '',
    close: async (id, reason) => {
      const no = await move(id, cfg.close || 'Done', 'done')
      if (no) throw new Error(no)
      await api('POST', `/issue/${encodeURIComponent(id)}/comment`, { body: `Done: ${reason}` }).catch(e => warn(e.message))
    },
  }
}

export const boardOf = async (config, dir) => {
  const kind = config.board ?? 'backlog'
  if (kind === 'backlog') return backlog()
  if (kind === 'jira') return config.jira?.via === 'rest' ? jira(config.jira) : jiraAcli(config.jira)
  const mod = await import(pathToFileURL(resolve(dir, kind)).href)
  return { on: () => true, open: () => [], openHint: () => '', name: kind, ...(await mod.default(config)) }
}
