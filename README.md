# lifemail

Give **any instance of Claude Code on a Mac** the ability to search, read, and triage your email —
including Outlook/Exchange mail — and cross-reference it with your Obsidian notes. It works by indexing
**Apple Mail's local store** into a private on-device SQLite database and exposing it to Claude Code as MCP
tools, plus two bundled skills. Nothing leaves your machine; nothing talks to Outlook/Exchange over the
network.

> **How it reads "Outlook" mail:** you add your Outlook/Exchange account to **Apple Mail.app** (macOS Mail)
> as usual. lifemail reads whatever Mail.app has already synced to disk. So any account Apple Mail supports
> — Outlook, Gmail, iCloud, IMAP — is fair game.

## What you get

- **Email tools** (`mcp__lifemail__*`): full-text search, read a message, read a whole thread (de-duplicated),
  filter by category/mailbox/sender/date, and — optionally — LLM summarization and "log emails to Obsidian."
- **Two skills** that load in every Claude Code session:
  - `lifemail` — how to drive the email tools well (triage rules, thread handling, cross-referencing notes).
  - `obsidian` — drive your Obsidian vault via Obsidian's official CLI (search/read/write/tags/links/tasks).

## Requirements

| Requirement | Needed for | Notes |
|---|---|---|
| **macOS** | everything | Reads Apple Mail's on-disk store; macOS-only. |
| **Outlook account in Apple Mail.app** | email | Add it in Mail → Settings → Accounts and let it sync. |
| **Node.js 20+** | building the server | `brew install node@20` or nvm. |
| **Claude Code** | using it | The `claude` CLI installs and runs the server. |
| **Full Disk Access** | email | The one manual step — see Install. Without it the mail index is silently empty. |
| Obsidian 1.12.7+ w/ CLI | notes features | Optional. Settings → General → "Command line interface". |
| Ollama | 4 LLM tools | Optional. Off by default. |

## Install

The install is done **by Claude Code**. Open Claude Code on your Mac and tell it:

> Clone `https://github.com/Genomewide/lifemail` and follow its `docs/INSTALL.md`.

Claude will clone the repo, run `scripts/install.sh` (stages the server to `~/.lifemail`, builds it,
registers the MCP server at user scope, and installs the two skills), then walk you through the one manual
step. Or run it yourself:

```bash
git clone https://github.com/Genomewide/lifemail.git && cd lifemail
bash scripts/install.sh                                  # email only
bash scripts/install.sh "/Users/you/Obsidian/YourVault" # also point the obsidian-* tools at a vault
```

### The one manual step: Full Disk Access

Reading `~/Library/Mail` is protected by macOS. **Without Full Disk Access, mail indexing silently returns
zero emails** — it looks like an empty inbox, not an error.

1. **System Settings → Privacy & Security → Full Disk Access**
2. Enable it for the app that runs Claude Code — your **terminal app** (Terminal/iTerm) for the CLI, or the
   **Claude desktop app**.
3. **Quit and reopen** that app.

After the restart, the server auto-indexes your last 30 days of mail ~5 seconds after it starts.

### Verify

- `claude mcp list` → `lifemail` shows **connected**.
- Ask Claude to **run `sync-status`** → mail rows **> 0** (0 rows means Full Disk Access is missing).
- Ask Claude to **search your email** for something you know is there.

## Using it

Just talk to Claude Code — the `lifemail` skill teaches it the rules. Examples:

- "Summarize my email from the last two days." (defaults to your primary inbox, skips junk/drafts)
- "Find the thread with Dana about the budget and show me the whole conversation."
- "What did I get from anyone at example.com this week?"
- "Anything in my inbox that needs a reply or has a deadline?"
- "Log this week's project emails into my Obsidian project pages." (previews first, then writes on approval)
- "Search my notes and my email for 'Q3 launch' and pull it together."

**Note operations** (create/rename/move notes, tags, backlinks, tasks, daily notes) go through the `obsidian`
skill, which drives Obsidian's official CLI.

## How it's laid out

```
lifemail/
├── server/          # the MCP server (TypeScript; indexes Apple Mail → SQLite)
├── skills/          # lifemail + obsidian skills (copied to ~/.claude/skills/ on install)
├── scripts/install.sh
├── docs/INSTALL.md  # step-by-step runbook (what Claude Code follows)
└── README.md
```

The running server lives at `~/.lifemail`; its database at `~/.personal-index/index.sqlite`. Both stay on
your machine.

## Troubleshooting

- **`sync-status` shows 0 mail rows / "empty inbox"** → Full Disk Access isn't granted, or you didn't restart
  the host app after granting it.
- **Server won't connect right after enabling Ollama** → Ollama isn't running. Unset `LLM_PROVIDER` (email
  works without it) or start Ollama.
- **`better_sqlite3.node ... NODE_MODULE_VERSION` error** → your Node version changed. Run
  `cd ~/.lifemail && npm rebuild better-sqlite3`.
- **Notes tools error / "vault not found"** → point them at your vault by re-running the installer with your
  vault path, or use the `obsidian` skill (official CLI) instead.

## Privacy

Everything is local: Apple Mail is read from disk, indexed into a SQLite file under `~/.personal-index`, and
exposed only to your local Claude Code. No email content is sent anywhere. The optional LLM features use a
**local** Ollama instance.
