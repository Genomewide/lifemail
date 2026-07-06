import { getDb } from '../db/database.js';

interface ObsidianGetInput {
  noteId: number;
  includeBody?: boolean;
  maxBodyChars?: number;
}

export function handleObsidianGet(args: ObsidianGetInput) {
  const db = getDb();
  const includeBody = args.includeBody ?? true;
  const maxBodyChars = args.maxBodyChars ?? 20000;

  const row = db.prepare(`
    SELECT id, vault, path, title, frontmatter_json, body, modified_utc
    FROM obsidian_note
    WHERE id = ?
  `).get(args.noteId) as {
    id: number;
    vault: string;
    path: string;
    title: string;
    frontmatter_json: string | null;
    body: string | null;
    modified_utc: number;
  } | undefined;

  if (!row) {
    return { error: `Note not found: ${args.noteId}` };
  }

  let body: string | null = null;
  if (includeBody && row.body) {
    body = row.body.length > maxBodyChars
      ? row.body.slice(0, maxBodyChars) + '…'
      : row.body;
  }

  return {
    noteId: row.id,
    vault: row.vault,
    path: row.path,
    title: row.title,
    frontmatterJson: row.frontmatter_json,
    modifiedUtc: row.modified_utc,
    body,
  };
}
