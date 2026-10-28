# peers

Run many agent sessions in one checkout: Claude Code, Codex, Cursor. No worktrees, no merges.

Each session gets a ledger of the files it edited. The ledger drives four things:

- **Scoped git.** `peers status`, `peers diff`, `peers commit -m "..."` see only this session's files. In a file a peer also edits, they see only this session's hunks. `peers check` runs the repo's gate on that commit in a side worktree.
- **Peer awareness.** When a peer edited the exact file this session reads or edits, the tool result carries one line: who, when, committed or not. Nothing else reaches the model.
- **A band above the prompt.** Live peers by name, their task, file counts, last edit. Zero tokens.
- **Tasks.** `peers ready` lists open work. `peers claim <id>` binds a task and sets it In Progress. Every `peers commit` appends the sha to its notes. `peers close` marks it Done; it stays on the board in the Done column; it refuses while an acceptance criterion or DoD item is unchecked, or while another live session holds the same task (`--force` overrides). The agent never edits the task by hand. The board is [Backlog.md](https://github.com/MrLesk/Backlog.md) by default: one Markdown file per task. Point `BACKLOG_CWD` at the board folder so every repo uses one board. Without `backlog` on PATH, the task id still lands in the commit trailer. Jira or your own board: see Task boards.

The system prompt gets one short rule: peers' changes in files you did not touch are theirs, never mention, revert or commit them.

Bash edits count too. The mod snapshots dirty files (and their text) before a Bash call and attributes the ones whose mtime changed.

## Guards

Each guard acts only when a live peer has uncommitted edits in the files the action reaches. Otherwise it stays out of the way.

| Action | Denied when it reaches a peer's uncommitted file |
|---|---|
| Staging | `git add -A`, `.`, `-u` or a folder; `git commit -a` |
| Discards | `git stash`, `reset --hard`, `checkout`/`restore` of `.` or a peer's path, `clean -f`, `rm` |
| Branch switch | `git switch`, `git checkout <branch>`: it changes every session's files |
| Formatters that write | `biome --write`, `prettier --write`, `eslint --fix`, `ruff format`, `cargo fmt` and others on `.`, a folder or no path; `pnpm lint:fix`, `format`, `fmt`. Run them on your files: `biome check --write $(peers files)` |
| Write | a whole-file Write that drops a peer's uncommitted lines. Use Edit |

An Edit that removes a peer's uncommitted lines goes through with a warning. A Bash command that changes a peer's uncommitted file goes through with a warning. Git in prose (quotes, heredocs, commit messages) does not count. A `cd $VAR` hides which repo a command is in, so it counts as every repo.

## Install

At the prompt of a Claude Code session:

```
/plugin install peers --marketplace wrenautomation/peers
```

From a shell:

```
claude plugin install peers --marketplace wrenautomation/peers
```

Answer `y` to add the marketplace, then pick the user scope. The next session links `peers` into `~/.local/bin`. Needs Claude Code 2.1.287 or newer.

### Windows

The next session writes `~/.local/bin/peers.cmd` (cmd, PowerShell) and `~/.local/bin/peers` (Git Bash). Put `~/.local/bin` on PATH if it is not there. Node and Git for Windows must be on PATH. `peers view --install` is macOS only: on Windows the pane, the TUI and `peers view` start the server when none answers. CI runs the unit tests on Windows.

### After an update

Each client (the pane, the TUI, `peers view`) asks the server its version (`/api/ping`). If the server is older, the client stops it (`POST /api/stop`, local only) and starts its own. A launchd server comes back on the new code by itself.

A server from before 0.16.7 has no stop. Stop it once by hand, then any client starts the new one.

PowerShell:

```
Get-NetTCPConnection -LocalPort 6421 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }
```

macOS or Linux:

```
pkill -f "peers.mjs view --serve"
```

## Other agents

Codex and Cursor use hooks. Install the plugin once (it links `peers`), then add the hooks:

```
peers install codex            # ~/.codex/hooks.json
peers install cursor           # ~/.cursor/hooks.json
peers install cursor --project # <repo>/.cursor/hooks.json
peers install codex --uninstall
```

The install merges into the config and keeps your own hooks. Each hook event runs `peers hook <agent>`. It records edits and shell commands, denies the same guarded commands, and tells the agent when a command changed a peer's file. Their sessions show as `codex-xxxx` and `cursor-xxxx` (Claude Code's as `cc-xxxx`) in the band, the pane and `peers view`. A session with no edit, commit or task shows nowhere and writes no ledger. `peers status|diff|commit` in the agent's shell find its session through the agent's process.

Claude Code needs none of this: its mod calls the same code in process (`lib/core.mjs`).

Differences from Claude Code:

- No read awareness line and no prompt rule. Put the rule in `AGENTS.md` or a Cursor rule.
- An Edit that drops a peer's lines is not stopped. A whole-file Write in Cursor is.
- A tool call whose pre-tool hook did not run (a timeout, a crash) records nothing.
- A `peers` command finds the session through the agent's process. Under a Claude Code shell, `CLAUDE_CODE_SESSION_ID` wins. Set `PEERS_SESSION` to choose.

Tested live on cursor-agent 2026.09.18. Codex is tested with fixtures from its hook docs only.

## Use

```
peers ready                 # open tasks
peers claim wa-b5f          # bind a task, set In Progress
peers status                # your dirty files, peers hidden
peers diff
peers commit -m "add thing" # your files, your hunks only, trailer Ticket: wa-b5f
peers files                 # your uncommitted files, for a formatter
peers check                 # gate (or config `check`) on that commit in ~/worktrees/<repo>-check
peers close -r "shipped"   # Done, summary carries the sha
peers log                   # this session's last actions and board writes
peers ls                    # every live session in this repo
peers view                  # live page of every session's edits
peers tui                   # the same view, full screen in a terminal
peers tui wren ./lander     # only those repos (view and /peers-view take the same words)
```

A filter word is a path or a name. A path (`.`, `../lander`, `~/x`) shows the repo it is, the repos under it, or the repo that holds it. A name shows, by the first tier that matches: the repo of that name, a repo whose name holds it, a folder of that name in the repo's path, a folder whose name holds it. Case does not matter. So `wren` is the wren repo, `auto` is autobrowse and `wren_automation` is every repo in that folder. Several words add up. The top row shows the words and the repos they matched. When nothing matches, it lists the live repos. There is no config file: the repos come from the live ledgers (see Where the state lives).

`peers view` opens http://127.0.0.1:6421 (`PEERS_VIEW_PORT` to change). It shows the uncommitted edits in every repo with a live session, each line in its author's color; grey is a line no ledger holds.

- Legend: one chip per session, with its task, its latest change title and its age. The chip pulses while the session writes. Click a chip to show only that session.
- Titles: before a group of edits the agent says in one line what they do. peers keeps that line as the title of each edit, and shows it on the change, the file and the session. An edit with no such line takes the heading or function above it.
- Zoom: `1` sessions, `2` files, `3` changes. A click folds or opens one group; the page keeps that per viewer.
- Tree: every file git lists, with +/− rolled up to folders. Each repo heads its tree as a folder (`wren/`). `⌘K` finds a file or a Markdown heading.
- Markdown opens as a GitHub-style document, folded by heading: added words marked, removed words struck, a bar in the author's color on each changed block. Code opens as a diff with syntax color.
- Activity: titled edits and commits (with their subjects), newest first.
- Live: a changed file and its new lines pulse in place; scroll and folds stay. The server starts on the first call and stops 15 minutes after the last page closes.

`/peers-view` in Claude Code (`/peers` is a built-in name) opens the same view in a pane, also mid-turn; Escape or `/peers-view` again closes it. `/peers-view wren` opens it on the repos those words match, or sets that filter on the open pane. It shows three parts. Sessions: one row per session, newest first, with its open files over all repos as `repo/path`, then its commits. Shared: each file that two or more sessions changed, with their names. Activity: the newest changes, live. Sessions start open; a press on a session's name folds it. `k` lists the keys. Each file shows its kind: a green `A` added, `M` edited, a red `D` deleted (struck). Each change title heads its files, first and in bold (`▼ Fix login  2 files`); a file sits under its newest title. Groups start open; a press folds one. Enter on a file opens it; `d` and `f` switch document and diff, `b` goes back. The diff is Claude Code's own (its highlighter and colors), headed by the owner's change title. A `⋯ lines 1–9 not shown` row marks each run of lines the diff leaves out; on the web a click on it shows them. `ctrl+x ←` widens the pane. The band above the prompt opens it too. A press on one peer in the band opens the pane on that session. ▶ and ▼ fold a group. Each session lists its open files, then its last 5 commits (sha, subject, file count): a session that committed all its work still shows. A press on `▶ 65 older` opens the older ones in place (up to 100; `peers log` has the rest); `▼ fewer` folds them back. Activity does the same past its newest 6. The band counts open files only. Color says who: a session's name, task, commit hashes and the paths of its files. A file with no owner, or several (Shared), is blue. White says what: titles and commit subjects. Bold marks what to read first: the session name, a title, a file name, the section heads. Gray marks only ids, times and key hints.

Up and down walk the rows with this in `~/.claude/keybindings.json` (by default they scroll, and Tab walks):

```json
{ "context": "AbovePrompt", "bindings": { "down": "abovePrompt:next", "up": "abovePrompt:previous" } }
``` The pane reads the same server and starts it when it is down.

`peers tui` shows the pane full screen in any terminal, with no agent session: a split beside Claude Code, Codex or Cursor. It draws the same rows as the pane (`lib/rows.mjs`) with Ink, reads the same server and starts it when it is down. Keys: `?` lists them, ↑↓ (or `j` `k`) move, Enter opens a file or folds a group, `d` document, `f` diff, `b` back, PgUp/PgDn or space page, `g` `G` top and end, `v` boxes, `q` quits. The diff has syntax color, line numbers and a bar in the author's color. `v` switches the list to boxes: one per session, in a grid of 1 to 3 columns by width. A box shows the name, id and task, its state (waits on you and for what, working, runs a command, idle), the title and what it does now; under them, all its open files, then its history of edits and commits. Every box has one height. The picked box scrolls: Shift+↑↓, or PgUp/PgDn (`u` and `n` on the focused box in the pane). The server keeps each session's last 50 events; set `{"boxScrollback": 200}` in `~/.claude/peers/config.json` to keep more. Sessions that wait on you come first, then working, then idle. Arrows pick a box; Enter opens that session in the list. The window moves only when the pick would leave the screen. The pane has the same view: `v` there too, and a press on a box's name opens that session in the list. Both draw `boxes()` from `lib/rows.mjs`; only the drawing differs (Ink here, Claude Code's elements in the pane). The focused row inverts its own colors, the same as the pointer's hover. The state comes from Claude Code's `~/.claude/sessions/<pid>.json`. Ink and React are bundled in `lib/vendor/ink.mjs` (MIT; licenses in `ink.LICENSE`).

`peers view --install --host peers.example.com` keeps the server up under launchd (log in `~/Library/Logs/peers-view.log`); `--uninstall` stops it. Run `--install` again after a plugin update. Point a Cloudflare tunnel with Access at 127.0.0.1:6421 for that host. Requests for the public host see only repos that are public on GitHub; any other host gets 403. This Mac sees all repos.

Edit, then commit, in separate commands: the ledger records a Bash edit after that command ends, so `sed ... && peers commit` sees nothing to commit.

## Names and titles

A session's id is its agent and the first four characters of its session id: `cc-b641` for Claude Code, `codex-…`, `cursor-…`. Its name is the name you gave it (`/rename`), else its id. The pane shows the id dim beside a given name, then the task id (`WA-879`) in the session's color. The band shows the name and the task; two peers with one name also show their ids. Under the name, the pane and `peers tui` show what the session is on: the task's title, else the title Claude Code made. The wide band shows it beside the name. A folded session cuts its title and its last change to 2 rows each; an open one shows them whole. Their wrapped lines use the full width. Its last change follows on the same line, after ` · `.  Task titles come from the ledger (`peers claim` keeps the board's title), else from the board at `BACKLOG_CWD`. Session titles come from the transcript, read again every 10 seconds.

## Where the state lives

`~/.claude/peers/<encoded repo root>/<session id>.json`. One file per session. No locks. A Claude session file counts only while its session is in Claude Code's running list (`~/.claude/sessions`), and for 12 hours at most. A terminal that moved its work to a background job counts as gone; the job shows under its own id. Peers lists only what `git status` lists, so `.gitignore`, `.git/info/exclude` and your global git ignore hide files from it too. A Codex or Cursor file, or any file with no such list, is ignored once marked ended. The band leaves out a peer with no open file and no task. Codex and Cursor ids carry a `codex_` or `cursor_` prefix.

`<session id>.actions.jsonl` beside it is the action log: one line per claim, commit, check and close, and per board write and each try of it. `peers log` prints it. A board write that fails (a comment, Jira down) waits there; the next `peers ready`, `claim`, `commit` or `close` sends it again, up to 5 tries.

All of it stays on this machine; nothing goes to a cloud. A ledger keeps at most 20 edits per file. A commit drops the line keys of the edits it took and keeps their times and titles, so the busiest ledger here dropped from 808 KB to 367 KB; an action is about 200 bytes. Heavy use (10 sessions a day) comes to about 1 GB a year.

`~/.claude/peers-run/` holds hook state for the other agents: `snap/` (a pre-tool snapshot until its post-tool event, swept after 1 hour) and `agents/<pid>.json` (agent process to session, swept after 48 hours).

## Hunks

Each edit records the lines it added and removed (`lib/lines.mjs`). Only distinctive lines count: four or more characters with a letter or digit. A `}` could be anyone's. `peers commit` splits a shared file into `git diff -U0` hunks. A hunk is the peer's when it holds their lines and none of yours. Every other hunk is yours. The commit is built in a private index from HEAD: a peer's staged files never ride along. It lands with a compare-and-swap on HEAD, and builds again if a peer committed meanwhile. `--whole` takes the file as it is.

## Task boards

Set `board` in `~/.claude/peers/config.json`. Only the `peers` CLI talks to the board. `peers claim` keeps the task's title in the ledger, so the pane and the view need no board access and no token.

- `"backlog"` (default): Backlog.md.
- `"jira"`: Jira, by one of two ways, set in `jira.via`:
  - `"acli"` (default): [Atlassian's CLI](https://developer.atlassian.com/cloud/acli/guides/install-acli/). Sign in once with `acli jira auth login`; peers uses that login and holds no token. The issue moves to the status named `claim` or `close`.

    ```json
    { "board": "jira", "jira": { "jql": "project = PROJ AND assignee = currentUser() AND statusCategory = \"To Do\"", "claim": "In Progress", "close": "Done" } }
    ```

  - `"rest"`: REST v2, for Cloud or Data Center, with `url`. The token comes only from env, never from the config. Cloud: `JIRA_EMAIL` and `JIRA_API_TOKEN` (an Atlassian API token). Data Center: `JIRA_API_TOKEN` (a personal access token), no `JIRA_EMAIL`. Here `claim` and `close` may name a transition or a status; with no match, the first status of the right category.

    ```json
    { "board": "jira", "jira": { "via": "rest", "url": "https://acme.atlassian.net" } }
    ```

  `ready` runs the JQL (default: your To Do issues). `claim` takes the key in upper case, moves the issue to `claim` (default In Progress) and assigns it to you (`"assign": false` skips that); a move or assign that fails there only warns. Each commit adds a comment with its sha and subject; one that fails waits in the action log and goes again. `close` moves the issue to `close` (default Done), then comments the reason. A move that fails there keeps the ticket bound, so you see it. acli output peers cannot read fails loud, never as an empty list; an acli call that hangs (an expired login) stops after 30 s.
- A path to an `.mjs` file, relative to the config's folder: its default export takes the config and returns `{ ready, claim, note, open, close }`. Any it leaves out does nothing. `lib/board.mjs` has the two built-in ones as examples.

Jira links commits, branches and PRs that name an issue key, once your Jira site has the GitHub (or GitLab, Bitbucket) app. Each `peers commit` carries a `Ticket: <key>` trailer, so its commits show on the issue with no setup in peers. Put the key in the PR title, so a squash merge commit names it too.

`check` in the config sets what `peers check` runs, as a shell line in the worktree (`"check": "npm test"`). Without it: `scripts/gates.sh changed` through bash, else the commit's stat. `peers check` tests your commit alone, without the peers' uncommitted hunks that your working tree also holds. A commit that needs a peer's hunk to pass fails there, not later in CI.

Why adapters in JS: the other choice was shell command lines in the config (no code, but fragile quoting, worst on Windows). Jira has two because work laptops differ: acli reuses the login you already have; REST needs nothing installed.

## Limits

- Edits on adjacent lines make one hunk. `peers commit` takes it whole and says so.
- A line both sessions added counts for neither.
- Binary files, new files, deleted files and files with no final newline commit whole. So does a file where a peer has no line data (a session still on an older mod).
- A formatter on your own shared file still rewrites the peer's lines there. Those changes count as yours.
- `peers commit` runs `post-commit` hooks but not `pre-commit` or `commit-msg`.
- `peers view` colors a line by its text. A line the ledger does not hold (too short, or written by a non-Claude edit) shows grey.
- A Bash command sees every file that changed while it ran. Lines a peer recorded in that time stay theirs (0.3.2). A peer's own Bash edit records only when its command ends, so two long commands that edit the same file can still cross.

## License

PolyForm Shield 1.0.0. See LICENSE.md.
