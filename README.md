# peers

Run many Claude Code sessions in one checkout. No worktrees, no merges.

Each session gets a ledger of the files it edited. The ledger drives four things:

- **Scoped git.** `peers status`, `peers diff`, `peers commit -m "..."` see only this session's files. In a file a peer also edits, they see only this session's hunks. `peers check` runs the repo's gate on that commit in a side worktree.
- **Peer awareness.** When a peer edited the exact file this session reads or edits, the tool result carries one line: who, when, committed or not. Nothing else reaches the model.
- **A band above the prompt.** Live peers, their ticket, file counts, last edit. Zero tokens.
- **Tasks.** `peers ready` lists open work. `peers claim <id>` binds a task and sets it In Progress. Every `peers commit` appends the sha to its notes. `peers close` marks it Done and archives it; it refuses while an acceptance criterion or DoD item is unchecked (`--force` overrides). The agent never edits the task by hand. The board is [Backlog.md](https://github.com/MrLesk/Backlog.md): one Markdown file per task. Point `BACKLOG_CWD` at the board folder so every repo uses one board. Without `backlog` on PATH, the task id still lands in the commit trailer.

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

## Use

```
peers ready                 # open tasks
peers claim wa-b5f          # bind a task, set In Progress
peers status                # your dirty files, peers hidden
peers diff
peers commit -m "add thing" # your files, your hunks only, trailer Ticket: wa-b5f
peers files                 # your uncommitted files, for a formatter
peers check                 # gate on that commit in ~/worktrees/<repo>-check
peers close -r "shipped"   # Done + archived, summary carries the sha
peers ls                    # every live session in this repo
peers view                  # live page of every session's edits
```

`peers view` opens http://127.0.0.1:6421 (`PEERS_VIEW_PORT` to change). It shows the uncommitted edits in every repo with a live session, each line in its author's color; grey is a line no ledger holds. Markdown opens as a document in suggestion style: added words marked, removed words struck. Code opens as a diff. The page updates as files change. The server starts on the first call and stops 15 minutes after the last page closes.

`/peers-view` in Claude Code (`/peers` is a built-in name) opens the same view in a pane: files by repo, a number key opens one, `d` and `f` switch document and diff, `b` goes back. The band above the prompt opens it too. The pane reads the same server and starts it when it is down.

`peers view --install --host peers.example.com` keeps the server up under launchd (log in `~/Library/Logs/peers-view.log`); `--uninstall` stops it. Run `--install` again after a plugin update. Point a Cloudflare tunnel with Access at 127.0.0.1:6421 for that host. Requests for the public host see only repos that are public on GitHub; any other host gets 403. This Mac sees all repos.

Edit, then commit, in separate commands: the ledger records a Bash edit after that command ends, so `sed ... && peers commit` sees nothing to commit.

## Where the state lives

`~/.claude/peers/<encoded repo root>/<session id>.json`. One file per session. No locks. A session file older than 12 hours, or marked ended, is ignored.

## Hunks

Each edit records the lines it added and removed (`lib/lines.mjs`). Only distinctive lines count: four or more characters with a letter or digit. A `}` could be anyone's. `peers commit` splits a shared file into `git diff -U0` hunks. A hunk is the peer's when it holds their lines and none of yours. Every other hunk is yours. The commit is built in a private index from HEAD: a peer's staged files never ride along. It lands with a compare-and-swap on HEAD, and builds again if a peer committed meanwhile. `--whole` takes the file as it is.

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
