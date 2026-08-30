# Journals Aware Rollover Todos

An [Obsidian](https://obsidian.md) plugin that rolls **unfinished todos** forward
from your previous note into a newly created one — built to work with the
[Journals](https://github.com/srg-kostyrko/obsidian-journal) plugin.

It is a spiritual successor to
[Rollover Daily Todos](https://github.com/lumoe/obsidian-rollover-daily-todos),
rewritten so it no longer depends on the core **Daily Notes** / **Periodic Notes**
settings. Instead of reconstructing a note path from a single static folder + date
format (which Journals' nested, date-templated folders break), it finds the
previous note using the `journal-date` frontmatter that Journals writes into every
note.

## Why this exists

The original Rollover Daily Todos locates daily notes by rebuilding the expected
path as `<dailyNotesFolder>/<DD-MMM-YYYY>.md` and comparing it to the file on disk.
Journals stores notes at paths like:

```
Daily Notes/2026/08-2026/28-Aug-2026.md
```

The core Daily Notes plugin can only hold **one** static folder, so that path can
never be reconstructed and the comparison always fails — the rollover silently
bails out. This plugin sidesteps path reconstruction entirely and keys off
frontmatter, which Journals maintains reliably:

```yaml
---
journal: DailyNote
journal-date: 2026-08-28
---
```

## How it works

1. When a new markdown note is created (or when you run the manual command), the
   plugin reads the note's `journal` and `journal-date` frontmatter.
2. It scans the vault (via Obsidian's metadata cache) for the **most recent note
   with an earlier `journal-date`** in the same journal — that's your "previous"
   note.
3. It extracts the unfinished todos from that previous note (optionally including
   nested child lines).
4. It inserts them into the new note beneath the first heading matching a
   configurable pattern (default: any heading ending in `TODOS`, e.g.
   `## FRIDAY TODOS`). If no heading matches, it falls back to the bottom of the
   note (configurable).
5. Optionally deletes the rolled todos from the previous note.

On automatic runs the plugin waits for the Journals template to finish rendering
(polling up to a few seconds) before inserting, so it never races the template.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Automatic rollover on new note | on | Roll over when Journals creates a note. The manual command is always available too. |
| Delete todos from the previous note | off | Move instead of copy. Destructive. |
| Roll over child items | on | Carry indented lines nested under a todo. |
| Skip empty todos | on | Ignore bare `- [ ]` items. |
| Skip todos already in the new note | on | Avoid duplicate inserts. |
| Target heading pattern | `^#{1,6}\s+.*TODOS\s*$` | Case-insensitive regex for the insertion heading. |
| If the heading is not found | Append to bottom | `bottom` / `top` / `skip`. |
| Done status markers | `xX-` | Characters inside `[ ]` that mean done. |
| Limit to journals | (empty = all) | Comma-separated Journals names to act on. |
| Show notice after rollover | on | Summary notice per rollover. |

## Commands

- **Roll over todos into the current note** — manually roll the previous note's
  unfinished todos into the currently active note.

## Development

```bash
npm install
npm run dev     # watch + rebuild main.js
npm run build   # type-check + production bundle
```

The repo root is also the installed plugin folder inside a test vault
(`<vault>/.obsidian/plugins/journals-aware-rollover-todos/`), so a build updates
the running plugin in place — just reload the plugin in Obsidian.

See [docs/PLAN.md](docs/PLAN.md) for the design notes and roadmap.

## License

[MIT](LICENSE)
