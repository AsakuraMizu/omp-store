# omp-store

An [omp](https://github.com/can1357/oh-my-pi) plugin that gives each workspace a store for the agent's working material: the notes, scripts, reproductions, cloned sources, environments and scratch files it creates to get its work done. Instead of directories the agent names and lays out itself, every piece becomes a registered entry that later sessions find by search. The store tracks which entries are still used, expires the rest, and keeps what is in the trash recoverable for a while.

## Use

Run `/store init` in the workspace root to create `.store/`. Sessions started there or in any directory below it use that store; everywhere else the plugin stays inactive.

| Command | Effect |
|---|---|
| `/store`, `/store list` | Entries, most recently used first |
| `/store search <words>` | Search titles and descriptions, trash included |
| `/store trash` | Trashed entries and why they were dropped |
| `/store drop <id>`, `/store restore <id>` | Move an entry to the trash, or bring it back |
| `/store clean` | Run the daily cleanup now, after you confirm what it will trash and delete |

## Behavior

- Each entry is a directory `.store/<id>/` with a random six-character id. Its title, description and creating session are kept in `.store/store.db`. The agent organizes the inside of an entry as it likes; the write and edit tools refuse to create anything else under `.store/`.
- The agent works through the tools `store_put`, `store_search`, `store_update`, `store_drop` and `store_restore`, and a short set of rules added to its system prompt. A subagent without the write tool gets only `store_search`.
- Any tool call that mentions `.store/<id>` counts as a use of that entry. When the write or edit tool puts the path of one entry inside another, the second becomes a dependency of the first: using the first also counts as using the second, and search results show the link.
- Once a day, on the first message, entries unused in the last 20 active days move to the trash, and entries in the trash for 7 active days are deleted. An active day is a day with at least one message in the workspace, so a paused project does not age. Using a trashed entry restores it.

## Limitations

- Use is seen only through tool calls. A program that reaches an entry without its path appearing in a call, such as a script outside the store, does not count; the agent is reminded when it writes such a reference.
- Writes made through bash are not blocked. When a bash command mentions `.store`, anything it left directly under `.store/` is reported to the agent with the result; anything else is reported to you at the end of the turn.
- Dependencies written through bash are not recorded.
- The database uses a rollback journal instead of WAL, so it can be shared by several hosts over NFS as long as the server enforces POSIX byte-range locks across clients.
