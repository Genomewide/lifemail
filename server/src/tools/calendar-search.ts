import { getDb } from '../db/database.js';
import { encodeCursor, decodeCursor } from '../cursor.js';

interface CalendarSearchInput {
  query: string;
  startUtc?: number;
  endUtc?: number;
  limit?: number;
  cursor?: string | null;
}

function makeSnippet(notes: string | null, maxLen = 200): string {
  if (!notes) return '';
  const cleaned = notes.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

export function handleCalendarSearch(args: CalendarSearchInput) {
  const db = getDb();
  const limit = Math.min(args.limit ?? 20, 100);
  const offset = decodeCursor(args.cursor);

  const conditions: string[] = ['cal_fts MATCH @query'];
  const params: Record<string, unknown> = { query: args.query };

  if (args.startUtc != null) {
    conditions.push('e.start_utc >= @startUtc');
    params.startUtc = args.startUtc;
  }
  if (args.endUtc != null) {
    conditions.push('e.start_utc <= @endUtc');
    params.endUtc = args.endUtc;
  }

  const whereClause = conditions.join(' AND ');

  const sql = `
    SELECT e.id as eventId, e.title, e.start_utc as startUtc, e.end_utc as endUtc,
           e.location, e.calendar_name as calendarName, e.notes
    FROM cal_fts
    JOIN cal_event e ON cal_fts.rowid = e.id
    WHERE ${whereClause}
    ORDER BY e.start_utc ASC
    LIMIT @limit OFFSET @offset
  `;

  params.limit = limit + 1;
  params.offset = offset;

  const rows = db.prepare(sql).all(params) as Array<{
    eventId: number;
    title: string;
    startUtc: number;
    endUtc: number;
    location: string | null;
    calendarName: string;
    notes: string | null;
  }>;

  const hasMore = rows.length > limit;
  const results = rows.slice(0, limit).map(r => ({
    eventId: r.eventId,
    title: r.title,
    startUtc: r.startUtc,
    endUtc: r.endUtc,
    location: r.location,
    calendarName: r.calendarName,
    snippet: makeSnippet(r.notes),
  }));
  const nextCursor = hasMore ? encodeCursor(offset + limit) : null;

  return { results, nextCursor };
}
