#!/usr/bin/env bash
#
# lifemail installer — scriptable steps only.
#
# What this does (safe to re-run):
#   1. Preflight: macOS + Node 20+ (captures the ABSOLUTE node path).
#   2. Stages the server to ~/.lifemail, runs npm install + build.
#   3. Registers the MCP server with Claude Code at USER scope (works in every project).
#   4. Copies the bundled skills into ~/.claude/skills/.
#   5. Prints the ONE manual step it cannot do for you (Full Disk Access) + verification.
#
# Optional: pass your Obsidian vault path so the obsidian-* MCP tools point at it:
#   bash scripts/install.sh "/Users/you/Obsidian/MyVault"
#   (or set LIFEMAIL_VAULT=/path before running). Omit if you only use email, or if you
#   drive notes through the Obsidian CLI skill.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIFEMAIL_HOME="$HOME/.lifemail"
SKILLS_DIR="$HOME/.claude/skills"
VAULT="${1:-${LIFEMAIL_VAULT:-}}"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
say "Preflight checks"
[ "$(uname)" = "Darwin" ] || die "lifemail is macOS-only (it reads Apple Mail's local store)."

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 20 LTS (e.g. 'brew install node@20' or nvm) and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ required (found $(node -v)). Install Node 20 LTS and re-run."
ABS_NODE="$(command -v node)"
echo "    node $(node -v) at $ABS_NODE"

command -v claude >/dev/null 2>&1 || warn "The 'claude' CLI isn't on PATH; step 3 will print a command for you to run manually."

# ---------------------------------------------------------------------------
# 2. Stage + build the server at a stable path
# ---------------------------------------------------------------------------
say "Staging server to $LIFEMAIL_HOME"
mkdir -p "$LIFEMAIL_HOME"
# Sync source but keep any existing node_modules/dist to speed re-runs.
rsync -a --delete --exclude node_modules --exclude dist "$REPO_ROOT/server/" "$LIFEMAIL_HOME/"

say "Installing dependencies (compiles the native better-sqlite3 addon)…"
( cd "$LIFEMAIL_HOME" && npm install )

say "Building (tsc → dist/)…"
( cd "$LIFEMAIL_HOME" && npm run build )

[ -f "$LIFEMAIL_HOME/dist/index.js" ] || die "Build did not produce dist/index.js."
[ -f "$LIFEMAIL_HOME/schema.sql" ]   || die "schema.sql missing next to dist/ — the server can't create its DB."
echo "    ok: dist/index.js and schema.sql present"

# ---------------------------------------------------------------------------
# 3. Register the MCP server (user scope, absolute node path)
# ---------------------------------------------------------------------------
say "Registering MCP server 'lifemail' at user scope"
ENV_ARGS=()
if [ -n "$VAULT" ]; then
  ENV_ARGS=(-e "OBSIDIAN_VAULT_ROOTS=$VAULT")
  echo "    obsidian vault: $VAULT"
fi

if command -v claude >/dev/null 2>&1; then
  # Idempotent: drop any prior registration first.
  claude mcp remove lifemail -s user >/dev/null 2>&1 || true
  claude mcp add lifemail -s user "${ENV_ARGS[@]}" -- "$ABS_NODE" "$LIFEMAIL_HOME/dist/index.js"
  echo "    registered."
else
  warn "Run this yourself to register the server:"
  printf '    claude mcp add lifemail -s user'
  [ -n "$VAULT" ] && printf ' -e OBSIDIAN_VAULT_ROOTS=%q' "$VAULT"
  printf ' -- %q %q\n' "$ABS_NODE" "$LIFEMAIL_HOME/dist/index.js"
fi

# ---------------------------------------------------------------------------
# 4. Install the bundled skills (user scope → available in every Claude Code instance)
# ---------------------------------------------------------------------------
say "Installing skills into $SKILLS_DIR"
mkdir -p "$SKILLS_DIR"
rsync -a --delete "$REPO_ROOT/skills/lifemail/" "$SKILLS_DIR/lifemail/"
echo "    installed skill: lifemail"
if [ -d "$SKILLS_DIR/obsidian" ]; then
  echo "    skipped skill: obsidian (you already have one — not overwriting)"
else
  rsync -a "$REPO_ROOT/skills/obsidian/" "$SKILLS_DIR/obsidian/"
  echo "    installed skill: obsidian"
fi

# ---------------------------------------------------------------------------
# 5. The one manual step + verification
# ---------------------------------------------------------------------------
cat <<'EOF'

============================================================================
 ALMOST DONE — one step only you can do: grant FULL DISK ACCESS
============================================================================
lifemail reads Apple Mail's local store (~/Library/Mail), which macOS protects.
WITHOUT this, mail indexing SILENTLY returns zero emails (it looks like an empty
inbox, not an error).

  1. System Settings → Privacy & Security → Full Disk Access
  2. Enable it for the app that RUNS Claude Code:
       • terminal app (Terminal / iTerm) if you use the Claude Code CLI, OR
       • the Claude desktop app if you use that.
  3. QUIT and REOPEN that app (the permission only applies after a restart).

After restarting, the server auto-indexes your last 30 days of mail ~5s after it
starts. Then verify:

  • claude mcp list            → 'lifemail' shows connected
  • ask Claude: "run sync-status"   → mail rows > 0   (0 rows = Full Disk Access missing)
  • ask Claude: "search my email for <something>"

For Obsidian NOTES features, also enable Obsidian's CLI: Obsidian 1.12.7+ →
Settings → General → "Command line interface", and keep the app running.
============================================================================
EOF

say "Local install steps complete."
