# INSTALL.md — runbook for Claude Code

**You are Claude Code, installing `lifemail` for your user on their Mac.** Follow these steps in order.
Most is scriptable; exactly one step (Full Disk Access) must be done by the human. Do not skip the
verification — a silent misconfiguration looks identical to "empty inbox."

## 0. Confirm prerequisites (stop early if unmet)

- **macOS** — required (lifemail reads Apple Mail's local store). `uname` must be `Darwin`.
- **Their Outlook/Exchange account is already added to Apple Mail.app** and has synced. lifemail indexes
  what Mail.app has on disk; it does not talk to Outlook directly. If Mail.app has no account, stop and
  tell them to add it first.
- **Node 20+** — `node -v`. If missing, tell them to install Node 20 LTS (`brew install node@20` or nvm),
  then continue.
- **Claude Code** — that's you. The `claude` CLI should be on PATH.

## 1. Get the repo

If not already cloned, clone it somewhere stable and `cd` in:

```bash
git clone https://github.com/Genomewide/lifemail.git ~/src/lifemail && cd ~/src/lifemail
```

## 2. Run the installer

Ask the user for their Obsidian vault path if they want the notes tools pointed at it (optional). Then:

```bash
bash scripts/install.sh                       # email only
# or, to wire the obsidian-* MCP tools to a vault:
bash scripts/install.sh "/Users/<them>/Obsidian/<Vault>"
```

This stages the server to `~/.lifemail`, runs `npm install && npm run build`, registers the MCP server at
**user scope** with an absolute node path, and copies the `lifemail` + `obsidian` skills into
`~/.claude/skills/`. Read its final output — it ends with the Full Disk Access instructions.

## 3. Full Disk Access — HAND THIS TO THE HUMAN (you cannot do it)

Reading `~/Library/Mail` is protected by macOS. **Without Full Disk Access, mail indexing silently returns
zero emails** — no error, just an empty index. Tell the user, verbatim:

> 1. Open **System Settings → Privacy & Security → Full Disk Access**.
> 2. Turn it **on** for the app that runs Claude Code — your **terminal app** (Terminal/iTerm) if you use
>    the CLI, or the **Claude desktop app** if you use that.
> 3. **Quit and reopen** that app. The permission only takes effect after a restart.

Wait for them to confirm they've done it and restarted.

## 4. Reload and let it index

After the restart, reconnect the server (`/mcp` reconnect, or it loads on the next launch). The server
**auto-indexes the last 30 days of mail ~5 seconds after it starts** — no manual sync needed. Give it a
moment.

## 5. Verify (do all three)

1. `claude mcp list` → `lifemail` is **connected**.
2. Run **`sync-status`** (call `mcp__lifemail__sync-status`). **Mail rows must be > 0.**
   - **0 rows ⇒ Full Disk Access is missing or the app wasn't restarted.** Go back to step 3. Do not
     report success.
3. Run a real query, e.g. `mcp__lifemail__mail-search` for a term you'd expect — confirm it returns threads.

## 6. Optional extras (only if the user wants them)

- **Obsidian notes tools / `obsidian` skill:** needs Obsidian **1.12.7+** with the CLI enabled
  (Settings → General → "Command line interface") and the app running. Verify with `obsidian version` and
  `obsidian vault`.
- **Calendar:** build the Swift helper (`cd ~/.lifemail && npm run build:calendar-helper`), grant EventKit
  access (`calendar-helper/.build/release/calendar-helper --request-access`), and run it with `--serve`.

## Troubleshooting

- **Empty inbox / `sync-status` shows 0 mail rows** → Full Disk Access (step 3) not granted, or the host
  app wasn't restarted.
- **`Error: better_sqlite3.node ... NODE_MODULE_VERSION`** → Node version changed since install; run
  `cd ~/.lifemail && npm rebuild better-sqlite3`.
- **`node: command not found` when the server launches** → the registration used a bare `node`. Re-run
  `scripts/install.sh` (it bakes in the absolute node path).
