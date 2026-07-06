# CLAUDE.md — lifemail server (developer/maintenance notes)

This is the MCP server that powers **lifemail**. It indexes Apple Mail (and, optionally, macOS
Calendar and an Obsidian vault) into a local SQLite database and exposes read/search/write tools
over stdio. For **how to use the tools day-to-day**, see the `lifemail` skill
(`skills/lifemail/SKILL.md` in the distribution repo) — this file is only about building and
maintaining the server.

## Build, run, test

```bash
npm install                    # deps (better-sqlite3 is a NATIVE addon — needs Node 20+)
npm run build                  # tsc → dist/
npm start                      # node dist/index.js (MCP server over stdio)

# Optional calendar sidecar (Swift/EventKit — only if you want calendar tools):
npm run build:calendar-helper  # swift build -c release in calendar-helper/
calendar-helper/.build/release/calendar-helper --request-access     # macOS Calendar prompt
calendar-helper/.build/release/calendar-helper --serve              # binds 127.0.0.1:17831

npm run test:tools             # node dist/test-harness.js (smoke against the live index)
```

## Architecture

- **Entry:** `src/index.ts` — registers the tool schemas, dispatches calls, and on boot schedules an
  auto-sync (~5s after start; initial run indexes the last 30 days of mail with no cap, then every 24h).
- **DB:** `src/db/database.ts` — opens `$PERSONAL_INDEX_HOME/index.sqlite` (WAL, foreign keys),
  applies `schema.sql`, then ad-hoc migrations. **`schema.sql` is read from disk at runtime** and must
  sit at the parent of `dist/` (i.e. the server root). First run creates an empty DB; it only populates
  after a sync.
- **Ingest:** `src/ingest/mail.ts` reads Apple Mail's on-disk store directly (`~/Library/Mail`, globbing
  `**/*.emlx` / `.partial.emlx`; category enrichment joins Apple's read-only `Envelope Index`). No IMAP,
  no EventKit for mail. `src/ingest/obsidian.ts` indexes markdown vaults. Calendar ingest talks to the
  Swift helper over HTTP.
- **Tools:** one handler per file in `src/tools/`. All are read-only **except** `obsidian-write`.
- **Usage:** every response is wrapped with a `_usage` block by `src/usage-tracker.ts`.

## Configuration (environment variables)

| Var | Default | Notes |
|-----|---------|-------|
| `PERSONAL_INDEX_HOME` | `$HOME/.personal-index` | DB home. **Do not pass a literal `~`** — Node does not expand it. Omit the var to get the correct default. |
| `OBSIDIAN_VAULT_ROOTS` | `$HOME/Obsidian` | Comma-separated vault paths for the obsidian-* MCP tools. Set to your vault, or leave unset if you drive notes via the Obsidian CLI skill instead. |
| `CAL_HELPER_HOST` / `CAL_HELPER_PORT` | `127.0.0.1` / `17831` | Calendar sidecar address. |

## Technical notes

- **Node 20+ required.** `better-sqlite3` is native — after any Node version change run
  `npm rebuild better-sqlite3`.
- **Apple Mail requires Full Disk Access** for the *host process* (the terminal app or the Claude
  desktop app running the server). Without it, `mail-sync` returns **zero rows silently** — it does not
  error. This is the first thing to check if the index is empty.
- After source changes: `npm run build`, then reload the MCP server in your client.
