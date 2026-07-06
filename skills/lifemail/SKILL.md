---
name: lifemail
description: Search, read, summarize, and triage the user's email (indexed from Apple Mail into a local database), and cross-reference it with their Obsidian notes and calendar. Use whenever the user asks about their inbox/email/threads, wants a summary or triage of recent mail, wants to find a message or conversation, or wants to log emails into Obsidian project pages. Drives the lifemail MCP server tools (mcp__lifemail__*). For creating/editing notes, defer to the `obsidian` skill.
---

# lifemail

Drive the **lifemail** MCP server — a local index of the user's Apple Mail (and optionally macOS
Calendar and an Obsidian vault) exposed as `mcp__lifemail__*` tools. Everything is read from a local
SQLite index of Apple Mail's on-disk store; nothing talks to Outlook/Exchange over the network.

## Preflight

If the `mcp__lifemail__*` tools aren't present, the server isn't installed/registered — see the repo's
`docs/INSTALL.md`. To confirm it's live and populated, call **`sync-status`**: it reports rows per source.
**Mail rows == 0 almost always means Full Disk Access was never granted** (mail-sync fails silently) — tell
the user to grant it (repo README → Full Disk Access) rather than assuming the inbox is empty.

## Mental model

One SQLite index, three domains, one meta group:

- **Mail** — `mail-search`, `mail-get`, `mail-get-thread`, `mail-summary`*, `mail-to-obsidian`*, `mail-sync`
- **Calendar** — `calendar-search`, `calendar-get`, `calendar-sync` (needs the optional Swift helper running)
- **Obsidian** — `obsidian-search`, `obsidian-get`, `obsidian-write`, `obsidian-sync`
- **Meta** — `sync-status`, `usage-stats`, and the LLM helpers `llm-summarize`*, `nl-tool-plan`*

`*` = **requires Ollama** (`LLM_PROVIDER=ollama`). If Ollama isn't set up these return a clean error; use the
non-LLM path instead (search + read, and summarize the results yourself). All mail/calendar/obsidian
**search/read/write works with no LLM.**

## Operational rules for mail

- **Default scope for "summarize my email" / "what's new" (no filters given):** restrict to
  `category: "primary"` and exclude the noise mailboxes (`Junk Email`, `Deleted Items`, `Drafts`). Only widen
  when the user explicitly asks for a folder/category.
- **Category is a fixed 4-value Apple Mail enum:** `primary | transactions | updates | promotions`. Map
  natural language onto it — receipts/orders → `transactions`, newsletters → `updates`, deals → `promotions`,
  important → `primary`. "Junk"/"Drafts"/"Sent" are *mailboxes* (the `mailbox` filter, exact-match), not
  categories.
- **Threads:** `mail-search` collapses threads by default (latest message + `threadCount`). When a thread has
  `threadCount > 1` and is worth reading, call **`mail-get-thread`** once (it returns the whole conversation,
  chronological, with quoted text stripped). **Never loop `mail-get` over a thread** — that re-reads duplicated
  quotes. For `threadCount == 1`, `mail-get` is fine.
- **Escalate a search hit to a full read** when the snippet shows a direct request ("can you", "please",
  "need your input"), an action item, a question aimed at the user, a deadline/approval/decision, or is very
  short while the user is in To: (content is below the fold). **Skip full reads** for meeting accept/decline,
  newsletters/FYI/announcements, automated notifications, and CC-only mail where the snippet is enough.
- **Summaries: most-actionable first.** Lead with action items / requests / deadlines / decisions, then
  informational items. Never invent facts not in the mail.

## Mail → Obsidian

Two tools write notes — choose deliberately:

- **`mail-to-obsidian`** (needs Ollama): cluster recent emails by project and append dated summaries to
  matching Obsidian project pages. **Always run `dryRun: true` first** (the default), show the proposed
  clusters + target paths, get approval, then re-run with `dryRun: false`. It matches existing project pages as
  anchors, drops new/low-confidence clusters into an inbox folder as drafts, appends (never replaces), and
  dedups by message id so re-runs are no-ops.
- **`obsidian-write`** (no Ollama): the low-level primitive — use it when the user dictates a single note or
  wants context attached to a specific page. Paths are vault-relative; modes `create` / `append` / `upsert`.
- **Just summarize, don't write?** Use `mail-summary` (or search+read and summarize yourself).

For richer note operations (rename, move, tags, backlinks, tasks, daily notes, templates), use the **`obsidian`
skill** (Obsidian's official CLI) rather than the obsidian-* MCP tools.

## Cross-tool orchestration

When the user is working a **project or person**, search *both* sources and stitch them together: find a
project/person name in email → `obsidian-search` for related notes (and vice versa) → optionally fold the
result back into Obsidian via `mail-to-obsidian` (project pages) or `obsidian-write` (a single note). Pull
meeting context with `calendar-search`/`calendar-get` when timing matters. There is no automatic linker — the
cross-referencing is your job.
