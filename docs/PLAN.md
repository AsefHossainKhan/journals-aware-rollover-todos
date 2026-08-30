# Journals Aware Rollover Todos — Plan & Design Notes

Working document for this plugin. It captures the problem, the diagnosis, the
design, and what's left to do, so any future session can pick up from here.

## 1. Problem statement

The user keeps a daily journal using the **Journals** plugin (`journals`, by
Sergii Kostyrko) with the calendar. They previously relied on **Rollover Daily
Todos** to carry unfinished `- [ ]` items from the previous day into the new
day's note. After switching to Journals, rollover stopped working.

Secondary (low priority, tracked separately, not in scope for v1): clicking the
core **Daily Notes** ribbon/button creates a fresh note at the wrong location
instead of opening the note Journals creates.

## 2. Diagnosis (why the old plugin broke)

Rollover Daily Todos locates notes purely from the **core Daily Notes** (or
**Periodic Notes**) settings: a single static folder + a date format. It
reconstructs today's expected path and compares it to the file on disk:

```js
// obsidian-rollover-daily-todos/main.js (~line 1270)
const filePathConstructed = `${folder}${folder=="" ? "" : "/"}${todayFormatted}.${file.extension}`;
if (filePathConstructed !== file.path) return;   // ← always bails out
```

Journals stores notes in nested, date-templated folders that the core setting
cannot express:

- Config: `folder: "Daily Notes/{{date:YYYY}}/{{date:MM-YYYY}}"`,
  `dateFormat: "DD-MMM-YYYY"`
- Result: `Daily Notes/2026/08-2026/28-Aug-2026.md`
- User's core Daily Notes `folder` is `""` (root), so the reconstructed path is
  `28-Aug-2026.md` → never equals the real nested path → rollover returns early
  on **every** trigger (create *and* the manual command).

Secondary break: the user's rollover `templateHeading` was stored as a raw
Templater snippet (`## <% tp... %> TODOS`), which can never literally match the
rendered heading (`## FRIDAY TODOS`).

**Conclusion:** No configuration workaround exists — the core Daily Notes plugin
can't represent Journals' nested path, and rollover fundamentally depends on
reconstructing that path. A Journals-aware replacement is the clean fix.

## 3. Key insight — the reliable anchor

Every Journals note carries frontmatter (verified 173/173 notes in the user's
2026 folder):

```yaml
journal: DailyNote
journal-date: 2026-08-28
```

The user's TODOS heading is always `## <WEEKDAY> TODOS` (matchable by the suffix
`TODOS`). These two facts let us avoid path/format guessing entirely.

## 4. Design

- **Identify a journal note** by reading `journal` + `journal-date` frontmatter
  (raw-parse the new note to dodge metadata-cache lag; cache fallback).
- **Find the previous note** = the note with the greatest `journal-date` strictly
  before the current note's date, in the same `journal` (scanned via the metadata
  cache). Journal-agnostic: works for daily, weekly, etc.
- **Extract todos** with a faithful port of Rollover Daily Todos' parser
  (single-grapheme checkbox marker, done-marker set, optional children, optional
  skip-empty), so behaviour is familiar to migrants.
- **Insert** beneath the first heading matching a configurable case-insensitive
  regex (default `^#{1,6}\s+.*TODOS\s*$`); fallback to bottom / top / skip.
- **Timing:** on auto-create, poll (≤ ~6s) until the note has `journal-date` and
  the target heading has rendered, so we never insert before Journals' template
  writes it.
- **Safety:** in-memory debounce to avoid double-processing a single create;
  optional skip-duplicates; delete-from-previous is opt-in.

Everything the user asked to be configurable **is** configurable via the settings
tab (auto vs manual, delete vs copy, and more).

## 5. File map

```
manifest.json          # Obsidian plugin manifest (id: journals-aware-rollover-todos)
versions.json          # minAppVersion history
package.json           # npm scripts + dev deps (esbuild, typescript, obsidian)
tsconfig.json          # TS config
esbuild.config.mjs     # bundles src/main.ts -> main.js
version-bump.mjs       # `npm version` helper (updates manifest + versions.json)
src/
  main.ts              # plugin entry: events, command, rollover flow, settings UI
  journal.ts           # frontmatter parsing + previous-note lookup
  todoParser.ts        # unfinished-todo extraction (ported semantics)
  settings.ts          # settings interface + defaults
docs/PLAN.md           # this file
README.md              # user-facing docs
```

## 6. Status

- [x] Diagnose root cause
- [x] Confirm frontmatter anchor is reliable (173/173 notes)
- [x] Scaffold publishable plugin project (TS + esbuild + git-ready)
- [x] Implement todo parser, journal lookup, rollover flow, settings UI
- [x] `npm install` + build `main.js`
- [x] Unit-test pure logic (parser, frontmatter, previous-note selection) — 10/10 green
- [ ] Enable in Obsidian + live test (create a note / run the command; verify insertion)
- [ ] Disable the old `obsidian-rollover-daily-todos`
- [ ] Push to GitHub

## 7. Roadmap / ideas (post-v1)

- Optional "roll over into today's note" command (resolve today's Journals note
  even when it isn't the active file).
- Support rolling from more than one prior note (e.g. skip weekends / accumulate).
- Section-aware insertion (match the same heading the todos came from).
- Undo, mirroring the original plugin's 2-minute undo modal.
- Weekly/monthly journal support surfaced explicitly in settings.
- Fix the secondary Daily Notes button issue (config-level: enable Journals'
  "Open today's note" in the ribbon; stop using the core Daily Notes ribbon).

## 8. Environment notes

- Vault: `D:\Obsidian Plugin Fix` (Windows). Not itself a git repo.
- Plugin dev happens in-place at
  `<vault>/.obsidian/plugins/journals-aware-rollover-todos/`, which is the repo
  root to push to GitHub. Obsidian loads the built `main.js` from here.
- The old `obsidian-rollover-daily-todos` plugin is still installed; disable it
  once this plugin is verified to avoid confusion.
