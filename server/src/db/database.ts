import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PERSONAL_INDEX_HOME = process.env.PERSONAL_INDEX_HOME
  || path.join(process.env.HOME || '/tmp', '.personal-index');

const DB_PATH = path.join(PERSONAL_INDEX_HOME, 'index.sqlite');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(PERSONAL_INDEX_HOME, { recursive: true });

  logger.info(`Opening database at ${DB_PATH}`);
  _db = new Database(DB_PATH);
  _db.pragma('foreign_keys = ON');
  _db.pragma('journal_mode = WAL');

  applySchema(_db);
  applyMigrations(_db);
  return _db;
}

function applySchema(db: Database.Database): void {
  // Read schema.sql from project root
  const schemaPath = path.resolve(__dirname, '..', '..', '..', 'schema.sql');
  let schemaSql: string;
  try {
    schemaSql = fs.readFileSync(schemaPath, 'utf8');
  } catch {
    // Fallback: try dist-relative path
    const fallback = path.resolve(__dirname, '..', '..', 'schema.sql');
    schemaSql = fs.readFileSync(fallback, 'utf8');
  }

  // Strip PRAGMA lines (already set above) and execute entire schema at once.
  // db.exec() handles multiple statements including triggers with embedded semicolons.
  const filtered = schemaSql
    .split('\n')
    .filter(line => !line.trim().startsWith('PRAGMA'))
    .join('\n');

  try {
    db.exec(filtered);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // "already exists" is expected on subsequent runs
    if (!msg.includes('already exists')) {
      logger.warn(`Schema application warning: ${msg}`);
    }
  }
  logger.info('Schema applied successfully');
}


function applyMigrations(db: Database.Database): void {
  try {
    const columns = db.prepare("PRAGMA table_info(mail_message)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map(col => col.name));

    if (!colNames.has("is_read")) {
      db.exec("ALTER TABLE mail_message ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0");
      logger.info("Migration: added is_read column to mail_message");
    }
    if (!colNames.has("has_attachments")) {
      db.exec("ALTER TABLE mail_message ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0");
      logger.info("Migration: added has_attachments column to mail_message");
    }
    if (!colNames.has("attachment_info")) {
      db.exec("ALTER TABLE mail_message ADD COLUMN attachment_info TEXT");
      logger.info("Migration: added attachment_info column to mail_message");
    }
    if (!colNames.has("category")) {
      db.exec("ALTER TABLE mail_message ADD COLUMN category TEXT");
      logger.info("Migration: added category column to mail_message");
    }
    if (!colNames.has("body_unique")) {
      db.exec("ALTER TABLE mail_message ADD COLUMN body_unique TEXT");
      logger.info("Migration: added body_unique column to mail_message");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Migration warning: " + msg);
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
