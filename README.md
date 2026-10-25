# peers

Run many Claude Code sessions in one checkout. No worktrees, no merges.

Each session gets a ledger of the files it edited. The ledger drives four things:

- **Scoped git.** `mine status`, `mine diff`, `mine commit -m "..."` see only this session's files. `mine check` runs the repo's gate on that commit in a side worktree.
- **Peer awareness.** When a peer edited the exact file this session reads or edits, the tool result carries one line: who, when, committed or not. Nothing else reaches the model.
- **A band above the prompt.** Live peers, their ticket, file counts, last edit. Zero tokens.
- **Tickets.** `mine claim <id>` binds a ticket. Every `mine commit` appends the sha to it. `mine close` closes it. The agent never edits the ticket by hand. The store is [beads](https://github.com/steveyegge/beads) when `bd` is on PATH; without it, the ticket id still lands in the commit trailer.

A guard denies `git add -A`, `git add .` and `git commit -a` while a peer has uncommitted work. The system prompt gets one short rule: peers' changes in files you did not touch are theirs, never mention, revert or commit them.

Bash edits count too. The mod snapshots dirty files before a Bash call and attributes the ones whose mtime changed.

## Install

At the prompt of a Claude Code session:

```
/plugin install peers --marketplace wrenautomation/peers
```

From a shell:

```
claude plugin install peers --marketplace wrenautomation/peers
```

Answer `y` to add the marketplace, then pick the user scope. The next session links `mine` into `~/.local/bin`. Needs Claude Code 2.1.287 or newer.

## Use

```
mine claim wa-b5f          # bind a ticket (optional)
mine status                # your dirty files, peers hidden
mine diff
mine commit -m "add thing" # commits your files only, trailer Ticket: wa-b5f
mine check                 # gate on that commit in ~/worktrees/<repo>-check
mine close -r "shipped"
mine ls                    # every live session in this repo
```

Edit, then commit, in separate commands: the ledger records a Bash edit after that command ends, so `sed ... && mine commit` sees nothing to commit.

## Where the state lives

`~/.claude/peers/<encoded repo root>/<session id>.json`. One file per session. No locks. A session file older than 12 hours, or marked ended, is ignored.

## Limits

Attribution is per file. When two sessions edit the same file, `mine commit` carries the peer's uncommitted lines too and says so. The band shows shared files in yellow. If that happens often, split the work by file.

## License

PolyForm Shield 1.0.0. See LICENSE.md.
