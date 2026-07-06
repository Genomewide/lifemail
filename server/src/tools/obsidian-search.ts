import { getDb } from '../db/database.js';
import { encodeCursor, decodeCursor } from '../cursor.js';

interface ObsidianSearchInput {
  query?: string;
  vault?: string;
  pathPrefix?: string;
  startModifiedUtc?: number;
  endModifiedUtc?: number;
  limit?: number;
  cursor?: string | null;
}

export function handleObsidianSearch(args: ObsidianSearchInput) {
  const db = getDb();
  const limit = Math.min(args.limit ?? 20, 100);
  const offset = decodeCursor(args.cursor);
  const hasQuery = args.query && args.query.trim().length > 0;

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (hasQuery) {
    conditions.push('obsidian_fts MATCH @query');
    params.query = args.query;
  }

  if (args.vault) {
    conditions.push('n.vault = @vault');
    params.vault = args.vault;
  }
  if (args.pathPrefix) {
    conditions.push('n.path LIKE @pathPrefix');
    params.pathPrefix = args.pathPrefix + '%';
  }
  if (args.startModifiedUtc != null) {
    conditions.push('n.modified_utc >= @startModifiedUtc');
    params.startModifiedUtc = args.startModifiedUtc;
  }
  if (args.endModifiedUtc != null) {
    conditions.push('n.modified_utc <= @endModifiedUtc');
    params.endModifiedUtc = args.endModifiedUtc;
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  params.limit = limit + 1;
  params.offset = offset;

  let sql: string;
  if (hasQuery) {
    sql = `
      SELECT n.id as noteId, n.vault, n.path, n.title, n.modified_utc as modifiedUtc,
             snippet(obsidian_fts, 1, '<b>', '</b>', '…', 48) as snippet
      FROM obsidian_fts
      JOIN obsidian_note n ON obsidian_fts.rowid = n.id
      ${whereClause}
      ORDER BY rank
      LIMIT @limit OFFSET @offset
    `;
  } else {
    // Browse mode: no FTS, generate snippet from body
    sql = `
      SELECT n.id as noteId, n.vault, n.path, n.title, n.modified_utc as modifiedUtc,
             SUBSTR(REPLACE(REPLACE(n.body, CHAR(10), ' '), CHAR(13), ' '), 1, 200) as snippet
      FROM obsidian_note n
      ${whereClause}
      ORDER BY n.modified_utc DESC
      LIMIT @limit OFFSET @offset
    `;
  }

  const rows = db.prepare(sql).all(params) as Array<{
    noteId: number;
    vault: string;
    path: string;
    title: string;
    modifiedUtc: number;
    snippet: string;
  }>;

  const hasMore = rows.length > limit;
  const results = rows.slice(0, limit);
  const nextCursor = hasMore ? encodeCursor(offset + limit) : null;

  return { results, nextCursor };
}
