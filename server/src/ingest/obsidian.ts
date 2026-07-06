import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import type Database from 'better-sqlite3';
import { getDb } from '../db/database.js';
import { logger } from '../log.js';

export interface UpsertNoteRow {
  vault: string;
  path: string;
  title: string;
  frontmatter_json: string | null;
  body: string | null;
  modified_utc: number;
  updated_utc: number;
}

export function upsertNoteIndex(db: Database.Database, row: UpsertNoteRow): void {
  db.prepare(`
    INSERT INTO obsidian_note (vault, path, title, frontmatter_json, body, modified_utc, updated_utc)
    VALUES (@vault, @path, @title, @frontmatter_json, @body, @modified_utc, @updated_utc)
    ON CONFLICT(vault, path) DO UPDATE SET
      title = @title,
      frontmatter_json = @frontmatter_json,
      body = @body,
      modified_utc = @modified_utc,
      updated_utc = @updated_utc
  `).run(row);
}

interface ObsidianSyncParams {
  mode: string;
  vaultRoots: string[];
  excludeGlobs?: string[];
  maxFiles?: number;
  includeBody?: boolean;
  maxBodyChars?: number;
}

export interface ObsidianSyncResult {
  filesScanned: number;
  notesUpserted: number;
  errors: number;
}

const DEFAULT_EXCLUDES = ['**/.obsidian/**', '**/node_modules/**', '**/.*'];

function extractTitle(content: string, filename: string): string {
  // Look for first H1
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  // Fallback: filename without extension
  return path.basename(filename, path.extname(filename));
}

function makeSnippet(body: string, maxLen = 200): string {
  const cleaned = body.replace(/^#+ .+$/gm, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

export async function syncObsidian(params: ObsidianSyncParams): Promise<ObsidianSyncResult> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const excludeGlobs = params.excludeGlobs ?? DEFAULT_EXCLUDES;
  const maxFiles = params.maxFiles ?? 20000;
  const includeBody = params.includeBody ?? true;
  const maxBodyChars = params.maxBodyChars ?? 20000;

  let filesScanned = 0;
  let notesUpserted = 0;
  let errors = 0;

  for (const vaultRoot of params.vaultRoots) {
    const resolvedRoot = path.resolve(vaultRoot);
    if (!fs.existsSync(resolvedRoot)) {
      logger.warn(`Vault root does not exist: ${resolvedRoot}`);
      errors++;
      continue;
    }

    const vaultName = path.basename(resolvedRoot);

    let mdFiles: string[];
    try {
      mdFiles = await glob('**/*.md', {
        cwd: resolvedRoot,
        ignore: excludeGlobs,
        dot: false,
        nodir: true,
      });
    } catch (err) {
      logger.error(`Failed to scan vault ${resolvedRoot}`, err);
      errors++;
      continue;
    }

    // Respect maxFiles
    if (mdFiles.length > maxFiles) {
      mdFiles = mdFiles.slice(0, maxFiles);
    }

    const isIncremental = params.mode === 'incremental';

    const syncInTransaction = db.transaction(() => {
      for (const relPath of mdFiles) {
        filesScanned++;
        const absPath = path.join(resolvedRoot, relPath);

        try {
          const stat = fs.statSync(absPath);
          const modifiedUtc = Math.floor(stat.mtimeMs / 1000);

          // Incremental: skip if not modified since last index
          if (isIncremental) {
            const existing = db.prepare(
              'SELECT modified_utc FROM obsidian_note WHERE vault = ? AND path = ?'
            ).get(vaultName, relPath) as { modified_utc: number } | undefined;

            if (existing && existing.modified_utc >= modifiedUtc) {
              continue;
            }
          }

          const raw = fs.readFileSync(absPath, 'utf8');
          let frontmatterJson: string | null = null;
          let bodyContent: string;

          try {
            const parsed = matter(raw);
            if (parsed.data && Object.keys(parsed.data).length > 0) {
              frontmatterJson = JSON.stringify(parsed.data);
            }
            bodyContent = parsed.content;
          } catch {
            // If frontmatter parsing fails, use raw content
            bodyContent = raw;
          }

          const title = extractTitle(bodyContent, relPath);
          const body = includeBody
            ? (bodyContent.length > maxBodyChars ? bodyContent.slice(0, maxBodyChars) + '…' : bodyContent)
            : null;

          upsertNoteIndex(db, {
            vault: vaultName,
            path: relPath,
            title,
            frontmatter_json: frontmatterJson,
            body,
            modified_utc: modifiedUtc,
            updated_utc: now,
          });
          notesUpserted++;
        } catch (err) {
          logger.error(`Failed to process note: ${absPath}`, err);
          errors++;
        }
      }
    });

    syncInTransaction();
  }

  // Update sync_state
  const totalItems = (db.prepare('SELECT COUNT(*) as c FROM obsidian_note').get() as { c: number }).c;
  if (errors === 0) {
    db.prepare(`
      UPDATE sync_state SET last_run_utc = ?, last_ok_utc = ?, last_error = NULL, items_indexed = ?
      WHERE source = 'obsidian'
    `).run(now, now, totalItems);
  } else {
    db.prepare(`
      UPDATE sync_state SET last_run_utc = ?, last_error = ?, items_indexed = ?
      WHERE source = 'obsidian'
    `).run(now, `${errors} error(s) during sync`, totalItems);
  }

  return { filesScanned, notesUpserted, errors };
}
