-- Canonical SQLite schema v1 (SQLite + FTS5)
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,              -- 'mail' | 'calendar' | 'obsidian'
  last_run_utc INTEGER,
  last_ok_utc INTEGER,
  last_error TEXT,
  items_indexed INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_state(source) VALUES ('mail'), ('calendar'), ('obsidian');

-- =========================
-- MAIL
-- =========================
CREATE TABLE IF NOT EXISTS mail_message (
  id INTEGER PRIMARY KEY,
  source_path TEXT NOT NULL UNIQUE,     -- stable key for ingest (file path)
  mailbox TEXT,
  date_utc INTEGER,
  subject TEXT,
  from_email TEXT,
  to_text TEXT,
  cc_text TEXT,
  thread_key TEXT,
  snippet TEXT,
  body_text TEXT,
  body_unique TEXT,                    -- body text with quoted replies stripped
  body_html TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_info TEXT,                 -- JSON array of {filename, size, contentType}
  category TEXT,                        -- Apple Mail category: primary, transactions, updates, promotions
  created_utc INTEGER,
  updated_utc INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mail_message_date ON mail_message(date_utc);
CREATE INDEX IF NOT EXISTS idx_mail_message_mailbox ON mail_message(mailbox);
CREATE INDEX IF NOT EXISTS idx_mail_message_from ON mail_message(from_email);
CREATE INDEX IF NOT EXISTS idx_mail_message_thread ON mail_message(thread_key);

CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
  subject,
  from_email,
  to_text,
  cc_text,
  snippet,
  body_text,
  content='mail_message',
  content_rowid='id'
);

-- Keep FTS in sync (external content)
CREATE TRIGGER IF NOT EXISTS mail_message_ai AFTER INSERT ON mail_message BEGIN
  INSERT INTO mail_fts(rowid, subject, from_email, to_text, cc_text, snippet, body_text)
  VALUES (new.id, new.subject, new.from_email, new.to_text, new.cc_text, new.snippet, new.body_text);
END;

CREATE TRIGGER IF NOT EXISTS mail_message_ad AFTER DELETE ON mail_message BEGIN
  INSERT INTO mail_fts(mail_fts, rowid, subject, from_email, to_text, cc_text, snippet, body_text)
  VALUES ('delete', old.id, old.subject, old.from_email, old.to_text, old.cc_text, old.snippet, old.body_text);
END;

CREATE TRIGGER IF NOT EXISTS mail_message_au AFTER UPDATE ON mail_message BEGIN
  INSERT INTO mail_fts(mail_fts, rowid, subject, from_email, to_text, cc_text, snippet, body_text)
  VALUES ('delete', old.id, old.subject, old.from_email, old.to_text, old.cc_text, old.snippet, old.body_text);

  INSERT INTO mail_fts(rowid, subject, from_email, to_text, cc_text, snippet, body_text)
  VALUES (new.id, new.subject, new.from_email, new.to_text, new.cc_text, new.snippet, new.body_text);
END;

-- =========================
-- CALENDAR
-- =========================
CREATE TABLE IF NOT EXISTS cal_event (
  id INTEGER PRIMARY KEY,
  event_identifier TEXT UNIQUE,         -- EKEvent.eventIdentifier
  calendar_name TEXT,
  title TEXT,
  location TEXT,
  notes TEXT,
  url TEXT,
  start_utc INTEGER,
  end_utc INTEGER,
  updated_utc INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cal_event_start ON cal_event(start_utc);
CREATE INDEX IF NOT EXISTS idx_cal_event_calendar ON cal_event(calendar_name);

CREATE VIRTUAL TABLE IF NOT EXISTS cal_fts USING fts5(
  title,
  location,
  notes,
  content='cal_event',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS cal_event_ai AFTER INSERT ON cal_event BEGIN
  INSERT INTO cal_fts(rowid, title, location, notes)
  VALUES (new.id, new.title, new.location, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS cal_event_ad AFTER DELETE ON cal_event BEGIN
  INSERT INTO cal_fts(cal_fts, rowid, title, location, notes)
  VALUES ('delete', old.id, old.title, old.location, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS cal_event_au AFTER UPDATE ON cal_event BEGIN
  INSERT INTO cal_fts(cal_fts, rowid, title, location, notes)
  VALUES ('delete', old.id, old.title, old.location, old.notes);

  INSERT INTO cal_fts(rowid, title, location, notes)
  VALUES (new.id, new.title, new.location, new.notes);
END;

-- =========================
-- OBSIDIAN
-- =========================
CREATE TABLE IF NOT EXISTS obsidian_note (
  id INTEGER PRIMARY KEY,
  vault TEXT NOT NULL,
  path TEXT NOT NULL,                   -- path relative to vault root
  title TEXT,
  frontmatter_json TEXT,
  body TEXT,
  modified_utc INTEGER,
  updated_utc INTEGER,
  UNIQUE(vault, path)
);

CREATE INDEX IF NOT EXISTS idx_obsidian_note_vault_path ON obsidian_note(vault, path);
CREATE INDEX IF NOT EXISTS idx_obsidian_note_modified ON obsidian_note(modified_utc);

CREATE VIRTUAL TABLE IF NOT EXISTS obsidian_fts USING fts5(
  title,
  body,
  path,
  content='obsidian_note',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS obsidian_note_ai AFTER INSERT ON obsidian_note BEGIN
  INSERT INTO obsidian_fts(rowid, title, body, path)
  VALUES (new.id, new.title, new.body, new.path);
END;

CREATE TRIGGER IF NOT EXISTS obsidian_note_ad AFTER DELETE ON obsidian_note BEGIN
  INSERT INTO obsidian_fts(obsidian_fts, rowid, title, body, path)
  VALUES ('delete', old.id, old.title, old.body, old.path);
END;

CREATE TRIGGER IF NOT EXISTS obsidian_note_au AFTER UPDATE ON obsidian_note BEGIN
  INSERT INTO obsidian_fts(obsidian_fts, rowid, title, body, path)
  VALUES ('delete', old.id, old.title, old.body, old.path);

  INSERT INTO obsidian_fts(rowid, title, body, path)
  VALUES (new.id, new.title, new.body, new.path);
END;
