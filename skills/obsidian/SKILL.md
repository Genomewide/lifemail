---
name: obsidian
description: Interact with the user's Obsidian vault from the terminal via Obsidian's official CLI (the `obsidian` command). Use whenever the user wants to search, read, create, append to, move, rename, or delete notes; manage frontmatter/properties, tags, links, backlinks, tasks, daily notes, or templates; or otherwise inspect/control their Obsidian vault. Prefer this over the personal-index `obsidian-*` MCP tools when the Obsidian app is available.
---

# Obsidian (official CLI)

Drive the user's Obsidian vault through Obsidian's first-party command-line interface — the
`obsidian` command, registered by the desktop app. This skill replaces the older
`personal-index` `obsidian-search` / `obsidian-get` / `obsidian-write` / `obsidian-sync`
MCP tools with one Bash-driven tool that exposes ~100 commands. (The `personal-index`
mail/calendar tools and `mail-to-obsidian` are NOT covered here — keep using those for
email/calendar work.)

## Preflight — run this before using the CLI

The CLI is only present on **Obsidian 1.12.7+** and must be enabled. Before relying on it:

```bash
obsidian version    # confirms the CLI exists and prints the app version
obsidian vault      # confirms a vault is selected and reachable
```

If `obsidian` is **not found** or `version` is below 1.12.7, stop and tell the user:
1. Update Obsidian to **1.12.7+**.
2. Enable **Settings → General → "Command line interface"** and follow the prompt to
   register it (creates an `obsidian` symlink on macOS; adds to PATH on Win/Linux).
3. The **Obsidian app must be running** (the CLI auto-launches it). For no-GUI use, point
   them to Obsidian's "Headless" docs.

Do not silently fall back to guessing — if the CLI is unavailable, say so and offer the
`personal-index` MCP tools as the interim path.

## Invocation conventions

- **Target a note** with exactly one of:
  - `file="Note Name"` — resolved wikilink-style by name (Obsidian finds it anywhere in the vault).
  - `path="01_Notes/Note.md"` — exact path from the vault root.
- **Pick a vault** with `vault="<name|id>"` **as the first argument** (omit to use the default vault). Discover names with `obsidian vaults`.
- **Machine-readable output**: add `format=json` (also `tsv|csv|md` on many commands) and parse that — prefer JSON over scraping text.
- **Clipboard**: append `--copy` to copy a command's output.
- Always **quote** any value containing spaces. Multi-line `content=` is fine in quotes.

## Safety rules (do not skip)

- **Confirm before any destructive or outward-facing action**, showing the exact target first:
  `delete`, `move`, `rename`, `property:remove`, `plugin:uninstall`, `theme:uninstall`,
  `history:restore`, `sync:restore`, `publish:add`/`publish:remove`.
- `delete` sends to trash and is recoverable; **never pass `permanent`** unless the user
  explicitly asks for permanent deletion.
- `eval`, `dev:cdp`, `dev:dom`, `dev:console`, `devtools` run/inspect arbitrary code in the
  app — use **only** with explicit user permission for that specific call.
- Before editing or overwriting a note, **verify it exists** first (`search` or `read`) so you
  don't clobber the wrong file or create an accidental duplicate.
- Treat the vault as the user's real notes: prefer `append`/`prepend` over `overwrite`.

## Common recipes

### Find and read
```bash
obsidian search query="ARPA-H IGoR" format=json limit=20      # titles + matches
obsidian search:context query="human subjects" format=json    # with surrounding lines
obsidian read file="ARPA-H IGoR"                               # full note body
obsidian read path="01_Notes/ARPA-H IGoR.md"
```

### Create / append / prepend
```bash
obsidian create path="00_Inbox/New Idea.md" content="# New Idea\n\n..."   # errors if exists w/o overwrite
obsidian create path="00_Inbox/New Idea.md" content="..." template="Daily" open
obsidian append  path="01_Notes/Log.md" content="- $(date) decision ..."  # to END of file
obsidian prepend path="01_Notes/Log.md" content="..."                     # inserted AFTER frontmatter
```

### Append under a specific "## Heading" (CLI has no native flag)
The CLI's `append` only writes to the end of the file. To insert under a heading, do it in
code: `read` the note, splice the new lines in after the target heading, then rewrite with
`create ... overwrite`. Confirm with the user since this rewrites the file.

### Frontmatter / properties
```bash
obsidian properties path="01_Notes/Note.md" format=json
obsidian property:set name="status" value="active" type="text" path="01_Notes/Note.md"
obsidian property:read name="status" file="Note"
obsidian property:remove name="status" path="01_Notes/Note.md"   # confirm first
```
`type` ∈ text | list | number | checkbox | date | datetime.

### Tasks, tags, links
```bash
obsidian tasks todo format=json                  # open tasks across the vault
obsidian task ref="01_Notes/Note.md:42" toggle   # toggle a task by path:line
obsidian tags format=json                         # tag counts
obsidian backlinks file="Note" format=json        # who links here
obsidian links file="Note"                        # outgoing links
obsidian unresolved format=json                   # broken links
obsidian orphans                                  # notes with no incoming links
```

### Daily notes
```bash
obsidian daily:read
obsidian daily:append content="- meeting notes ..."
```

### Move / rename / delete (confirm first)
```bash
obsidian move   file="Old Note" to="Archive/Old Note.md"   # updates wikilinks
obsidian rename path="01_Notes/Old.md" name="New Title"
obsidian delete path="00_Inbox/scratch.md"                 # trash; recoverable
```

### Run any Obsidian command / manage plugins & themes
```bash
obsidian commands filter="daily" format=json   # discover command IDs
obsidian command id="daily-notes:goto-today"   # execute one
obsidian plugins:enabled format=json
obsidian plugin:install id="<community-plugin-id>" enable   # confirm first
```

### History & recovery
```bash
obsidian history file="Note"                          # local versions
obsidian history:restore path="01_Notes/Note.md" version="<v>"   # confirm first
obsidian diff file="Note" from="<v1>" to="<v2>"
```

## Full command map (categories)

Files/folders: `file files folder folders open create read append prepend move rename delete` ·
Search: `search search:context search:open` ·
Properties: `properties property:set property:remove property:read aliases` ·
Tags: `tags tag` · Links: `links backlinks unresolved orphans deadends` ·
Tasks: `tasks task` · Daily: `daily daily:path daily:read daily:append daily:prepend` ·
Outline/count: `outline wordcount` · Templates: `templates template:read template:insert` ·
Bases: `bases base:views base:create base:query` · Bookmarks: `bookmarks bookmark` ·
Random/unique: `random random:read unique` ·
History: `history history:list history:read history:restore history:open diff` ·
Sync: `sync sync:status sync:history sync:read sync:restore sync:open sync:deleted` ·
Publish: `publish:site publish:list publish:status publish:add publish:remove publish:open` ·
Plugins: `plugins plugins:enabled plugin plugin:enable plugin:disable plugin:install plugin:uninstall plugin:reload plugins:restrict` ·
Themes/snippets: `themes theme theme:set theme:install theme:uninstall snippets snippets:enabled snippet:enable snippet:disable` ·
Commands/hotkeys: `commands command hotkeys hotkey` ·
Workspace/tabs: `workspace workspaces workspace:save workspace:load workspace:delete tabs tab:open recents` ·
Vault: `vault vaults vault:open` · App: `help version reload restart web` ·
Developer (gated): `eval dev:cdp dev:dom dev:css dev:console dev:errors dev:screenshot devtools dev:debug dev:mobile`

Run `obsidian help <command>` for the exact flags of any command.

## Reference
- Official CLI help: https://obsidian.md/help/cli
- Announcement: https://obsidian.md/cli
- Headless / community alternative (works without the GUI): https://github.com/Yakitrak/notesmd-cli
