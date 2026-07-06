import { getDb } from '../db/database.js';
import { encodeCursor, decodeCursor } from '../cursor.js';

interface MailSearchInput {
  query?: string;
  limit?: number;
  cursor?: string | null;
  threadCollapse?: boolean;
  filters?: {
    startUtc?: number;
    endUtc?: number;
    fromEmail?: string;
    mailbox?: string;
    hasAttachments?: boolean;
    isRead?: boolean;
    category?: string;
    excludeMailboxes?: string[];
    excludeCategories?: string[];
  };
}

interface SearchResult {
  mailId: number;
  dateUtc: number;
  subject: string;
  from: string;
  mailbox: string;
  threadKey: string;
  snippet: string;
  isRead: number;
  category: string | null;
}

interface ThreadCollapsedResult {
  mailId: number;
  dateUtc: number;
  subject: string;
  from: string;
  mailbox: string;
  threadKey: string;
  snippet: string;
  isRead: number;
  category: string | null;
  threadCount: number;
  threadParticipants: string[];
}

export function handleMailSearch(args: MailSearchInput) {
  const db = getDb();
  const limit = Math.min(args.limit ?? 20, 100);
  const offset = decodeCursor(args.cursor);
  const filters = args.filters ?? {};
  const hasQuery = args.query && args.query.trim().length > 0;
  const threadCollapse = args.threadCollapse ?? true; // ON by default

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (hasQuery) {
    conditions.push('mail_fts MATCH @query');
    params.query = args.query;
  }

  if (filters.startUtc != null) {
    conditions.push('m.date_utc >= @startUtc');
    params.startUtc = filters.startUtc;
  }
  if (filters.endUtc != null) {
    conditions.push('m.date_utc <= @endUtc');
    params.endUtc = filters.endUtc;
  }
  if (filters.fromEmail) {
    conditions.push("m.from_email LIKE '%' || @fromEmail || '%'");
    params.fromEmail = filters.fromEmail;
  }
  if (filters.mailbox) {
    conditions.push('m.mailbox = @mailbox');
    params.mailbox = filters.mailbox;
  }
  if (filters.hasAttachments != null) {
    conditions.push('m.has_attachments = @hasAttachments');
    params.hasAttachments = filters.hasAttachments ? 1 : 0;
  }

  if (filters.isRead != null) {
    conditions.push('m.is_read = @isRead');
    params.isRead = filters.isRead ? 1 : 0;
  }
  if (filters.category) {
    conditions.push('m.category = @category');
    params.category = filters.category;
  }
  if (filters.excludeMailboxes && filters.excludeMailboxes.length > 0) {
    const placeholders = filters.excludeMailboxes.map((_, i) => `@exMb${i}`);
    conditions.push(`m.mailbox NOT IN (${placeholders.join(', ')})`);
    filters.excludeMailboxes.forEach((mb, i) => { params[`exMb${i}`] = mb; });
  }
  if (filters.excludeCategories && filters.excludeCategories.length > 0) {
    const placeholders = filters.excludeCategories.map((_, i) => `@exCat${i}`);
    conditions.push(`(m.category IS NULL OR m.category NOT IN (${placeholders.join(', ')}))`);
    filters.excludeCategories.forEach((cat, i) => { params[`exCat${i}`] = cat; });
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Fetch more rows than needed for thread collapsing
  const fetchLimit = threadCollapse ? (limit + 1) * 5 : limit + 1;
  params.limit = fetchLimit;
  params.offset = offset;

  let sql: string;
  if (hasQuery) {
    sql = `
      SELECT m.id as mailId, m.date_utc as dateUtc, m.subject,
             m.from_email as "from", m.mailbox, m.thread_key as threadKey, m.snippet,
             m.is_read as isRead, m.category
      FROM mail_fts
      JOIN mail_message m ON mail_fts.rowid = m.id
      ${whereClause}
      ORDER BY m.date_utc DESC
      LIMIT @limit OFFSET @offset
    `;
  } else {
    sql = `
      SELECT m.id as mailId, m.date_utc as dateUtc, m.subject,
             m.from_email as "from", m.mailbox, m.thread_key as threadKey, m.snippet,
             m.is_read as isRead, m.category
      FROM mail_message m
      ${whereClause}
      ORDER BY m.date_utc DESC
      LIMIT @limit OFFSET @offset
    `;
  }

  const rows = db.prepare(sql).all(params) as SearchResult[];

  if (!threadCollapse) {
    // Original flat behavior
    const hasMore = rows.length > limit;
    const results = rows.slice(0, limit);
    const nextCursor = hasMore ? encodeCursor(offset + limit) : null;
    return { results, nextCursor };
  }

  // Thread collapsing: group by threadKey, keep latest per thread
  const threadMap = new Map<string, {
    latest: SearchResult;
    count: number;
    participants: Set<string>;
  }>();

  for (const row of rows) {
    const existing = threadMap.get(row.threadKey);
    if (existing) {
      existing.count++;
      if (row.from) existing.participants.add(row.from);
      // Keep the one with latest date
      if (row.dateUtc > existing.latest.dateUtc) {
        existing.latest = row;
      }
    } else {
      const participants = new Set<string>();
      if (row.from) participants.add(row.from);
      threadMap.set(row.threadKey, { latest: row, count: 1, participants });
    }
  }

  // Also query thread counts/participants for threads that have messages outside the current result set
  const threadKeys = Array.from(threadMap.keys());
  if (threadKeys.length > 0) {
    const placeholders = threadKeys.map((_, i) => `@tk${i}`);
    const threadParams: Record<string, string> = {};
    threadKeys.forEach((tk, i) => { threadParams[`tk${i}`] = tk; });

    const threadStats = db.prepare(`
      SELECT thread_key, COUNT(*) as total_count, GROUP_CONCAT(DISTINCT from_email) as all_participants
      FROM mail_message
      WHERE thread_key IN (${placeholders.join(', ')})
      GROUP BY thread_key
    `).all(threadParams) as Array<{ thread_key: string; total_count: number; all_participants: string | null }>;

    for (const stat of threadStats) {
      const entry = threadMap.get(stat.thread_key);
      if (entry) {
        entry.count = stat.total_count;
        if (stat.all_participants) {
          for (const p of stat.all_participants.split(',')) {
            if (p.trim()) entry.participants.add(p.trim());
          }
        }
      }
    }
  }

  // Sort collapsed results by latest message date descending
  const collapsed: ThreadCollapsedResult[] = Array.from(threadMap.values())
    .sort((a, b) => b.latest.dateUtc - a.latest.dateUtc)
    .map(entry => ({
      ...entry.latest,
      threadCount: entry.count,
      threadParticipants: Array.from(entry.participants),
    }));

  const hasMore = collapsed.length > limit;
  const results = collapsed.slice(0, limit);
  const nextCursor = hasMore ? encodeCursor(offset + fetchLimit) : null;

  return { results, nextCursor };
}
