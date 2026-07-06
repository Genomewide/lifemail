/**
 * Standalone mail sync script — called by cron/launchd every 6 hours.
 * Usage: node dist/sync-daemon.js
 */
import { syncMail } from './ingest/mail.js';

const start = Date.now();
console.log(`[${new Date().toISOString()}] Starting incremental mail sync...`);

try {
  const result = await syncMail({ mode: 'incremental', maxFiles: 5000 });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[${new Date().toISOString()}] Done in ${elapsed}s — ` +
    `scanned=${result.filesScanned} upserted=${result.messagesUpserted} errors=${result.errors}`
  );
  process.exit(0);
} catch (err) {
  console.error(`[${new Date().toISOString()}] Sync failed:`, err);
  process.exit(1);
}
