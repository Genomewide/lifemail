import { getDb } from '../db/database.js';

interface SourceStatus {
  source: string;
  lastRunUtc: number | null;
  lastOkUtc: number | null;
  lastError: string | null;
  itemsIndexed: number;
}

interface SyncStatusResult {
  schemaVersion: number;
  sources: SourceStatus[];
}

export function handleSyncStatus(): SyncStatusResult {
  const db = getDb();
  const rows = db.prepare(`
    SELECT source, last_run_utc, last_ok_utc, last_error, items_indexed
    FROM sync_state
    ORDER BY source
  `).all() as Array<{
    source: string;
    last_run_utc: number | null;
    last_ok_utc: number | null;
    last_error: string | null;
    items_indexed: number;
  }>;

  return {
    schemaVersion: 1,
    sources: rows.map(r => ({
      source: r.source,
      lastRunUtc: r.last_run_utc,
      lastOkUtc: r.last_ok_utc,
      lastError: r.last_error,
      itemsIndexed: r.items_indexed,
    })),
  };
}
