import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import { logger } from './log.js';
import { getDb, closeDb } from './db/database.js';
import { syncMail } from './ingest/mail.js';
import { syncObsidian } from './ingest/obsidian.js';
import { usageTracker } from './usage-tracker.js';

// Tool handlers
import { handleSyncStatus } from './tools/sync-status.js';
import { handleObsidianSync } from './tools/obsidian-sync.js';
import { handleObsidianSearch } from './tools/obsidian-search.js';
import { handleObsidianGet } from './tools/obsidian-get.js';
import { handleObsidianWrite } from './tools/obsidian-write.js';
import { handleMailSync } from './tools/mail-sync.js';
import { handleMailSearch } from './tools/mail-search.js';
import { handleMailGet } from './tools/mail-get.js';
import { handleMailGetThread } from './tools/mail-get-thread.js';
import { handleCalendarSync } from './tools/calendar-sync.js';
import { handleCalendarSearch } from './tools/calendar-search.js';
import { handleCalendarGet } from './tools/calendar-get.js';
import { handleUsageStats } from './tools/usage-stats.js';

// ---------- Tool definitions ----------

const TOOLS = [
  {
    name: 'sync-status',
    description: 'Returns indexing state for each source (mail, calendar, obsidian).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'mail-sync',
    description: 'Indexes Apple Mail storage (.emlx files) into the local SQLite database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['incremental', 'full'], description: 'Sync mode', default: 'incremental' },
        rootPaths: { type: 'array', items: { type: 'string' }, description: 'Apple Mail root directories to scan' },
        sinceUtc: { type: 'number', description: 'Skip files older than this UTC epoch (best effort)' },
        maxFiles: { type: 'number', description: 'Max .emlx files to scan', default: 2000 },
        includeBodies: { type: 'boolean', description: 'Store message bodies', default: true },
        includeAttachments: { type: 'boolean', description: 'Index attachments (v1: not supported)', default: false },
      },
    },
  },
  {
    name: 'mail-search',
    description: `Search or browse indexed email messages. Query is optional — omit it to browse by filters (mailbox, category, date range, etc).

SUMMARIZATION DEFAULTS: When asked to summarize or review emails without specific instructions, use category "primary" and excludeMailboxes ["Junk Email", "Deleted Items", "Drafts"]. If the user asks for "all emails" or a specific category/folder, override these defaults.

WORKFLOW: This returns metadata and short snippets (~200 chars). After reviewing results, use mail-get to fetch full bodies for emails where: (1) the snippet indicates a direct request or action item, (2) the user is in the To: field and the snippet is short/empty, (3) the snippet mentions questions, deadlines, or approvals. Skip full reads for meeting accepts/declines, newsletters, automated notifications, and FYI-only threads.

THREAD HANDLING: Results are thread-collapsed by default — each thread shows only the latest message plus threadCount and threadParticipants. For threads with threadCount > 1 that need deep reading, use mail-get-thread (not individual mail-get calls) to fetch the full conversation with de-duplicated body text. Set threadCollapse: false only when flat per-message results are needed.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'FTS search query (optional — omit to browse by filters only)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)', default: 20 },
        cursor: { type: 'string', nullable: true, description: 'Pagination cursor' },
        threadCollapse: { type: 'boolean', description: 'Collapse threads to show only the latest message per thread with count and participants (default: true)', default: true },
        filters: {
          type: 'object',
          properties: {
            startUtc: { type: 'number', description: 'Filter: messages on or after this UTC epoch' },
            endUtc: { type: 'number', description: 'Filter: messages on or before this UTC epoch' },
            fromEmail: { type: 'string', description: 'Filter: from address contains this string' },
            mailbox: { type: 'string', description: 'Filter: exact mailbox name' },
            hasAttachments: { type: 'boolean', description: 'Filter: messages with attachments (true) or without (false)' },
            isRead: { type: 'boolean', description: 'Filter: read (true) or unread (false) messages' },
            category: { type: 'string', enum: ['primary', 'transactions', 'updates', 'promotions'], description: 'Filter: Apple Mail category' },
            excludeMailboxes: { type: 'array', items: { type: 'string' }, description: 'Exclude messages from these mailboxes (e.g. ["Junk Email", "Deleted Items"])' },
            excludeCategories: { type: 'array', items: { type: 'string' }, description: 'Exclude messages in these categories (e.g. ["promotions"])' },
          },
        },
      },
    },
  },
  {
    name: 'mail-get',
    description: 'Fetch a single email message by ID. Use this after mail-search to read the full body of emails that appear to contain requests, action items, or important details not captured in the snippet. Batch multiple mail-get calls in parallel when fetching several emails. For multi-message threads (threadCount > 1), prefer mail-get-thread instead — it returns the full conversation with de-duplicated bodies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mailId: { type: 'number', description: 'Message ID from mail-search results' },
        includeBody: { type: 'boolean', description: 'Include message body text', default: true },
        maxBodyChars: { type: 'number', description: 'Truncate body to this many chars', default: 20000 },
        includeHtml: { type: 'boolean', description: 'Include HTML body', default: false },
        includeAttachments: { type: 'boolean', description: 'Include attachment metadata (filename, size, contentType)', default: false },
      },
      required: ['mailId'],
    },
  },
  {
    name: 'mail-get-thread',
    description: 'Fetch all messages in an email thread, ordered chronologically. Returns de-duplicated body text (quoted replies stripped) for each message, plus thread metadata. Use this instead of multiple mail-get calls when threadCount > 1 in mail-search results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        threadKey: { type: 'string', description: 'Thread key from mail-search results' },
        maxBodyChars: { type: 'number', description: 'Truncate each message body to this many chars', default: 20000 },
      },
      required: ['threadKey'],
    },
  },
  {
    name: 'calendar-sync',
    description: 'Indexes calendar events via the Swift EventKit helper into the local SQLite database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        startUtc: { type: 'number', description: 'Start of time range (UTC epoch seconds)' },
        endUtc: { type: 'number', description: 'End of time range (UTC epoch seconds)' },
        mode: { type: 'string', enum: ['incremental', 'full'], default: 'incremental' },
        calendarIds: { type: 'array', items: { type: 'string' }, description: 'Limit to these calendar IDs' },
        includeNotes: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'calendar-search',
    description: 'Full-text search across indexed calendar events.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'FTS search query' },
        startUtc: { type: 'number', description: 'Filter: events starting on or after this UTC epoch' },
        endUtc: { type: 'number', description: 'Filter: events starting on or before this UTC epoch' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)', default: 20 },
        cursor: { type: 'string', nullable: true, description: 'Pagination cursor' },
      },
      required: ['query'],
    },
  },
  {
    name: 'calendar-get',
    description: 'Fetch a single calendar event by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: { type: 'number', description: 'Event ID from calendar-search results' },
        includeNotes: { type: 'boolean', description: 'Include event notes', default: true },
        maxNotesChars: { type: 'number', description: 'Truncate notes to this many chars', default: 20000 },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'obsidian-sync',
    description: 'Indexes markdown notes from Obsidian vault directories into the local SQLite database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['incremental', 'full'], default: 'incremental' },
        vaultRoots: { type: 'array', items: { type: 'string' }, description: 'Obsidian vault root directories' },
        excludeGlobs: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to exclude', default: ['**/.obsidian/**', '**/node_modules/**'] },
        maxFiles: { type: 'number', description: 'Max files to scan', default: 20000 },
        includeBody: { type: 'boolean', description: 'Store note body text', default: true },
        maxBodyChars: { type: 'number', description: 'Truncate body to this many chars', default: 20000 },
      },
      required: ['vaultRoots'],
    },
  },
  {
    name: 'obsidian-search',
    description: `Search or browse indexed Obsidian notes. Query is optional — omit it to browse by filters (path, vault, date range, etc).

WORKFLOW: This returns metadata and short snippets (~200 chars). After reviewing results, use obsidian-get to fetch full note bodies for notes where the title or snippet looks relevant.

CROSS-REFERENCE: When working with email on a topic, also check Obsidian for related notes (and vice versa). For example, after finding emails about a project, search notes for the same project name.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'FTS search query (optional — omit to browse by filters only)' },
        vault: { type: 'string', description: 'Filter to a specific vault name' },
        pathPrefix: { type: 'string', description: 'Filter to notes whose path starts with this prefix' },
        startModifiedUtc: { type: 'number', description: 'Filter: notes modified on or after this UTC epoch' },
        endModifiedUtc: { type: 'number', description: 'Filter: notes modified on or before this UTC epoch' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)', default: 20 },
        cursor: { type: 'string', nullable: true, description: 'Pagination cursor' },
      },
    },
  },
  {
    name: 'obsidian-get',
    description: 'Fetch a single Obsidian note by ID. Use this after obsidian-search to read the full body of notes with relevant titles or snippets. For notes about projects or people, offer to search email for related threads.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        noteId: { type: 'number', description: 'Note ID from obsidian-search results' },
        includeBody: { type: 'boolean', description: 'Include note body', default: true },
        maxBodyChars: { type: 'number', description: 'Truncate body to this many chars', default: 20000 },
      },
      required: ['noteId'],
    },
  },
  {
    name: 'obsidian-write',
    description: `Create or append to an Obsidian markdown note. Low-level primitive — use this directly when you want to write a single note.

PATH: vault-relative (e.g. "01_Notes/AIM+HI.md" or "00_Inbox/New Idea.md"). Absolute paths are rejected. Path traversal (../) is rejected. The .md extension is added if missing.

MODES:
- "create" — error if the file exists
- "append" — error if the file does not exist
- "upsert" (default) — create if missing, append otherwise

APPEND BEHAVIOR: when appending, by default the body is concatenated at the end. Pass appendUnderHeading to insert under a specific "## Heading" section (the heading is created if absent). New content is added to the END of the section so the history accumulates chronologically.

FRONTMATTER: merged with any existing frontmatter. To dedup emails-already-processed, pass processedMessageIds: ["123", "456"] — these are merged into the file's frontmatter.processed_mail_ids set. If every passed ID is already there, the call is a no-op (action: "skipped_duplicate").

After write, the file is immediately re-indexed into SQLite so obsidian-search returns the new content.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        vault: { type: 'string', description: 'Vault name or absolute path (defaults to first OBSIDIAN_VAULT_ROOTS entry)' },
        path: { type: 'string', description: 'Vault-relative path (e.g. "01_Notes/Project.md")' },
        mode: { type: 'string', enum: ['create', 'append', 'upsert'], description: 'Write mode (default: upsert)', default: 'upsert' },
        body: { type: 'string', description: 'Markdown body to write or append' },
        frontmatter: { type: 'object', description: 'Frontmatter keys to set/merge (e.g. {type: "project", status: "active"})' },
        appendUnderHeading: { type: 'string', description: 'Optional "## Heading" name under which to append. Created if absent.' },
        processedMessageIds: { type: 'array', items: { type: 'string' }, description: 'Stable email/message IDs to record in frontmatter.processed_mail_ids for dedup' },
      },
      required: ['path', 'body'],
    },
  },
  {
    name: 'usage-stats',
    description: 'Returns detailed token usage and estimated cost breakdown for this session. Shows per-tool stats, cumulative totals, and recent call history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'], description: 'Legacy Claude pricing tier for cost estimates (default: opus)' },
        provider: { type: 'string', enum: ['claude', 'ollama'], description: 'Optional provider label override for reporting' },
        providerModel: { type: 'string', description: 'Optional concrete model name for reporting (e.g. gpt-oss:20b)' },
        isEstimated: { type: 'boolean', description: 'Whether reported usage/cost should be treated as estimated', default: true },
      },
    },
  },
];

// ---------- Main ----------

async function main() {
  logger.info('Starting Personal Index MCP server');

  // Initialize database eagerly
  getDb();

  const server = new Server(
    { name: 'personal-index', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    logger.info(`Tool called: ${name}`);

    try {
      let result: unknown;

      switch (name) {
        case 'sync-status':
          result = handleSyncStatus();
          break;
        case 'mail-sync':
          result = await handleMailSync(a);
          break;
        case 'mail-search':
          result = handleMailSearch(a);
          break;
        case 'mail-get':
          result = handleMailGet(a);
          break;
        case 'mail-get-thread':
          result = handleMailGetThread(a);
          break;
        case 'calendar-sync':
          result = await handleCalendarSync(a);
          break;
        case 'calendar-search':
          result = handleCalendarSearch(a);
          break;
        case 'calendar-get':
          result = handleCalendarGet(a);
          break;
        case 'obsidian-sync':
          result = await handleObsidianSync(a);
          break;
        case 'obsidian-search':
          result = handleObsidianSearch(a);
          break;
        case 'obsidian-get':
          result = handleObsidianGet(a);
          break;
        case 'obsidian-write':
          result = handleObsidianWrite(a);
          break;
        case 'usage-stats':
          if (a.model) usageTracker.setModel(a.model);
          if (a.provider && a.providerModel) {
            usageTracker.setRuntimeModel(a.provider, a.providerModel, a.isEstimated ?? true);
          }
          result = handleUsageStats();
          break;
        default:
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }

      // Check if result has an error field (tool-level error)
      if (result && typeof result === 'object' && 'error' in result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: true,
        };
      }

      // Track usage and inject _usage metadata into the response
      const resultText = JSON.stringify(result, null, 2);
      const usage = usageTracker.record(name, resultText);
      const augmented = typeof result === 'object' && result !== null
        ? { ...(result as Record<string, unknown>), _usage: usage }
        : { data: result, _usage: usage };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(augmented, null, 2) }],
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Tool error in ${name}: ${errorMsg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMsg }) }],
        isError: true,
      };
    }
  });

  // Connect via STDIO
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server connected via STDIO');

  // ---------- Daily auto-sync ----------
  const DAILY_MS = 24 * 60 * 60 * 1000;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  async function runDailySync() {
    try {
      const db = getDb();
      const syncState = db.prepare(
        "SELECT last_ok_utc, items_indexed FROM sync_state WHERE source = 'mail'"
      ).get() as { last_ok_utc: number | null; items_indexed: number } | undefined;

      const now = Math.floor(Date.now() / 1000);
      const lastSync = syncState?.last_ok_utc ?? 0;
      const daysBehind = lastSync > 0 ? Math.floor((now - lastSync) / 86400) : -1;
      const isInitial = daysBehind < 0;

      if (isInitial) {
        logger.info('Mail index: no previous sync found, running initial sync (last 30 days, no file cap)');
      } else if (daysBehind === 0) {
        logger.info(`Mail index: up to date (${syncState?.items_indexed ?? 0} messages indexed)`);
        return; // Already synced today
      } else {
        logger.info(`Mail index: ${daysBehind} day(s) behind, catching up (${syncState?.items_indexed ?? 0} messages currently indexed)`);
      }

      if (isInitial) {
        // Initial sync: last 30 days with no file cap to get the most coverage
        const thirtyDaysAgo = now - (30 * 86400);
        const result = await syncMail({ mode: 'full', sinceUtc: thirtyDaysAgo, maxFiles: 999999 });
        logger.info(`Initial sync complete: scanned ${result.filesScanned}, upserted ${result.messagesUpserted}, errors ${result.errors}`);
      } else {
        // Daily catch-up: incremental, capped at 5,000
        const result = await syncMail({ mode: 'incremental', maxFiles: 5000 });
        logger.info(`Daily sync complete: scanned ${result.filesScanned}, upserted ${result.messagesUpserted}, errors ${result.errors}`);
      }
      // ---------- Obsidian auto-sync ----------
      const vaultRootsEnv = process.env.OBSIDIAN_VAULT_ROOTS;
      const obsidianVaults = vaultRootsEnv
        ? vaultRootsEnv.split(',').map(s => s.trim()).filter(Boolean)
        : [path.join(process.env.HOME || '/tmp', 'Obsidian')];

      try {
        const obsResult = await syncObsidian({ mode: 'incremental', vaultRoots: obsidianVaults });
        logger.info(`Obsidian sync complete: scanned ${obsResult.filesScanned}, upserted ${obsResult.notesUpserted}, errors ${obsResult.errors}`);
      } catch (obsErr) {
        logger.error('Obsidian auto-sync failed', obsErr);
      }
    } catch (err) {
      logger.error('Daily auto-sync failed', err);
    }
  }

  // Run initial catch-up sync shortly after startup (5 second delay to let things settle)
  setTimeout(() => {
    runDailySync();
    // Then schedule daily
    syncTimer = setInterval(runDailySync, DAILY_MS);
  }, 5000);

  // ---------- Graceful shutdown ----------
  function shutdown() {
    logger.info('Shutting down');
    if (syncTimer) clearInterval(syncTimer);
    closeDb();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
