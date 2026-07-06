---
name: lifemail
description: Search, read, and triage the user's email (indexed from Apple Mail into a local database), and cross-reference it with their Obsidian notes and calendar. Use whenever the user asks about their inbox/email/threads, wants a summary or triage of recent mail, wants to find a message or conversation, or wants to save an email into an Obsidian note. Drives the lifemail MCP server tools (mcp__lifemail__*). For creating/editing notes, defer to the `obsidian` skill.
---

# lifemail

Drive the **lifemail** MCP server — a local index of the user's Apple Mail (and optionally macOS
Calendar and an Obsidian vault) exposed as `mcp__lifemail__*` tools. Everything is read from a local
SQLite index of Apple Mail's on-disk store; nothing talks to Outlook/Exchange over the network, and there
is no LLM dependency — you (the agent) do any summarizing from the search/read results.

## Preflight

If the `mcp__lifemail__*` tools aren't present, the server isn't installed/registered — see the repo's
`docs/INSTALL.md`. To confirm it's live and populated, call **`sync-status`**: it reports rows per source.
**Mail rows == 0 almost always means Full Disk Access was never granted** (mail-sync fails silently) — tell
the user to grant it (repo README → Full Disk Access) rather than assuming the inbox is empty.

## Mental model

One SQLite index, three domains, one meta group:

- **Mail** — `mail-search`, `mail-get`, `mail-get-thread`, `mail-sync`
- **Calendar** — `calendar-search`, `calendar-get`, `calendar-sync` (needs the optional Swift helper running)
- **Obsidian** — `obsidian-search`, `obsidian-get`, `obsidian-write`, `obsidian-sync`
- **Meta** — `sync-status`, `usage-stats`

All tools are read-only except `obsidian-write`.

## Operational rules for mail

- **"Summarize my email" / "what's new":** search with the right scope, read what matters, and write the
  summary yourself — there's no summarization tool. Default scope when no filters are given: restrict to
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
- **When you summarize, lead most-actionable first:** action items / requests / deadlines / decisions, then
  informational items. Never invent facts not in the mail.

## Saving email into Obsidian

Use **`obsidian-write`** — the note primitive. Reach for it when the user wants an email (or your summary of
several) captured into a note. Paths are vault-relative; modes are `create` / `append` / `upsert`; pass
`appendUnderHeading` to accumulate under a section. To dedup, pass `processedMessageIds` (the mail ids you
folded in) — already-recorded ids are skipped.

For richer note operations (rename, move, tags, backlinks, tasks, daily notes, templates), use the **`obsidian`
skill** (Obsidian's official CLI) rather than the obsidian-* MCP tools.

## Cross-tool orchestration

When the user is working a **project or person**, search *both* sources and stitch them together: find a
project/person name in email → `obsidian-search` for related notes (and vice versa) → optionally capture the
result into Obsidian via `obsidian-write`. Pull meeting context with `calendar-search`/`calendar-get` when
timing matters. There is no automatic linker — the cross-referencing is your job.
