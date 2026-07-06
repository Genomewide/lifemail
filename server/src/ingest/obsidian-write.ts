import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getDb } from '../db/database.js';
import { logger } from '../log.js';
import { upsertNoteIndex } from './obsidian.js';

export type WriteMode = 'create' | 'append' | 'upsert';

export interface WriteObsidianNoteOpts {
  vault?: string;                 // vault name or path; defaults to first OBSIDIAN_VAULT_ROOTS entry
  path: string;                   // vault-relative path, e.g. "01_Notes/Project.md"
  mode?: WriteMode;               // default "upsert"
  body: string;                   // markdown body to write or append
  frontmatter?: Record<string, unknown>;
  appendUnderHeading?: string;    // when appending, insert under this `## Heading` (creates it if absent)
  processedMessageIds?: string[]; // merged into frontmatter.processed_mail_ids as a deduplicated set
}

export interface WriteObsidianNoteResult {
  vault: string;
  path: string;
  absolutePath: string;
  action: 'created' | 'appended' | 'skipped_duplicate';
  bytesWritten: number;
  alreadyProcessed: string[];     // message-ids skipped because they were already in frontmatter
  newlyProcessed: string[];       // message-ids added to frontmatter by this call
}

function resolveVaultRoot(vaultArg?: string): { root: string; name: string } {
  const env = process.env.OBSIDIAN_VAULT_ROOTS;
  const roots = env
    ? env.split(',').map((s) => s.trim()).filter(Boolean)
    : [path.join(process.env.HOME || '/tmp', 'Obsidian')];

  if (!vaultArg) {
    const root = path.resolve(roots[0]);
    return { root, name: path.basename(root) };
  }

  // vaultArg may be a path or a vault name
  const asPath = path.resolve(vaultArg);
  for (const r of roots) {
    const abs = path.resolve(r);
    if (abs === asPath) return { root: abs, name: path.basename(abs) };
    if (path.basename(abs) === vaultArg) return { root: abs, name: path.basename(abs) };
  }
  // If caller passed an absolute path that isn't in the configured list, allow it
  // (useful for tests with a temp vault), but reject anything ambiguous.
  if (path.isAbsolute(vaultArg) && fs.existsSync(asPath)) {
    return { root: asPath, name: path.basename(asPath) };
  }
  throw new Error(`Unknown vault: ${vaultArg}. Configured roots: ${roots.join(', ')}`);
}

function assertInsideVault(absPath: string, vaultRoot: string): void {
  const resolved = path.resolve(absPath);
  const root = path.resolve(vaultRoot);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes vault: ${absPath} (vault: ${vaultRoot})`);
  }
}

function dedupSet(...arrays: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arr of arrays) {
    if (!arr) continue;
    for (const item of arr) {
      if (!item) continue;
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * Insert `block` under `## heading`. If the heading doesn't exist, append it
 * (with the block) at the end of `body`. New content is appended to the END of
 * the section so history accumulates chronologically.
 */
function insertUnderHeading(body: string, heading: string, block: string): string {
  const headingLine = `## ${heading}`;
  const lines = body.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === headingLine);

  if (startIdx === -1) {
    const sep = body.length > 0 && !body.endsWith('\n') ? '\n\n' : (body.endsWith('\n\n') ? '' : '\n');
    return `${body}${sep}${headingLine}\n\n${block}\n`;
  }

  // Find the next H2 (or H1) after startIdx — that's the end of this section.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  // Trim trailing blank lines inside the section before inserting.
  let insertAt = endIdx;
  while (insertAt > startIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, '', block, '', ...after].join('\n');
}

function atomicWrite(absPath: string, contents: string): number {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, absPath);
  return Buffer.byteLength(contents, 'utf8');
}

function extractTitleFromBody(content: string, fallbackPath: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return path.basename(fallbackPath, path.extname(fallbackPath));
}

function makeSnippet(body: string, maxLen = 200): string {
  const cleaned = body.replace(/^#+ .+$/gm, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

export function writeObsidianNote(opts: WriteObsidianNoteOpts): WriteObsidianNoteResult {
  const mode: WriteMode = opts.mode ?? 'upsert';
  const { root: vaultRoot, name: vaultName } = resolveVaultRoot(opts.vault);

  if (!opts.path || typeof opts.path !== 'string') {
    throw new Error('path is required');
  }
  if (opts.path.startsWith('/') || opts.path.startsWith('\\')) {
    throw new Error(`path must be vault-relative, not absolute: ${opts.path}`);
  }

  const relPath = opts.path.endsWith('.md') ? opts.path : `${opts.path}.md`;
  const absPath = path.join(vaultRoot, relPath);
  assertInsideVault(absPath, vaultRoot);

  const exists = fs.existsSync(absPath);
  if (mode === 'create' && exists) {
    throw new Error(`File already exists: ${relPath} (mode=create)`);
  }
  if (mode === 'append' && !exists) {
    throw new Error(`File does not exist: ${relPath} (mode=append)`);
  }

  // ---- Read existing (if any) ----
  let existingFrontmatter: Record<string, unknown> = {};
  let existingBody = '';
  if (exists) {
    const raw = fs.readFileSync(absPath, 'utf8');
    try {
      const parsed = matter(raw);
      existingFrontmatter = (parsed.data ?? {}) as Record<string, unknown>;
      existingBody = parsed.content;
    } catch {
      existingBody = raw;
    }
  }

  // ---- Dedup processedMessageIds against existing frontmatter ----
  const existingIds = Array.isArray(existingFrontmatter.processed_mail_ids)
    ? (existingFrontmatter.processed_mail_ids as unknown[]).map((x) => String(x))
    : [];
  const incomingIds = (opts.processedMessageIds ?? []).map((x) => String(x));
  const alreadyProcessed = incomingIds.filter((id) => existingIds.includes(id));
  const newlyProcessed = incomingIds.filter((id) => !existingIds.includes(id));

  // If every incoming Message-ID was already processed AND this is an append-style call
  // with no fresh body content, treat as a no-op.
  if (
    exists &&
    incomingIds.length > 0 &&
    newlyProcessed.length === 0 &&
    (mode === 'append' || mode === 'upsert')
  ) {
    return {
      vault: vaultName,
      path: relPath,
      absolutePath: absPath,
      action: 'skipped_duplicate',
      bytesWritten: 0,
      alreadyProcessed,
      newlyProcessed: [],
    };
  }

  // ---- Merge frontmatter ----
  const mergedFrontmatter: Record<string, unknown> = { ...existingFrontmatter };
  if (opts.frontmatter) {
    for (const [k, v] of Object.entries(opts.frontmatter)) {
      // Only overwrite if caller provides a non-null value, except processed_mail_ids
      // which is merged as a deduplicated set below.
      if (k === 'processed_mail_ids') continue;
      mergedFrontmatter[k] = v;
    }
  }
  const mergedIds = dedupSet(existingIds, incomingIds);
  if (mergedIds.length > 0) {
    mergedFrontmatter.processed_mail_ids = mergedIds;
  }

  // ---- Compose new body ----
  let newBody: string;
  if (!exists || mode === 'create') {
    newBody = opts.body;
  } else if (opts.appendUnderHeading) {
    newBody = insertUnderHeading(existingBody, opts.appendUnderHeading, opts.body);
  } else {
    const sep = existingBody.length > 0 && !existingBody.endsWith('\n') ? '\n\n' : '\n';
    newBody = `${existingBody}${sep}${opts.body}\n`;
  }

  // ---- Serialize + atomic write ----
  const hasFm = Object.keys(mergedFrontmatter).length > 0;
  const serialized = hasFm
    ? matter.stringify(newBody, mergedFrontmatter)
    : newBody.endsWith('\n')
    ? newBody
    : `${newBody}\n`;

  const bytesWritten = atomicWrite(absPath, serialized);
  logger.info(`obsidian-write: ${exists ? 'updated' : 'created'} ${relPath} (${bytesWritten}b)`);

  // ---- Reindex into SQLite ----
  try {
    const stat = fs.statSync(absPath);
    const modifiedUtc = Math.floor(stat.mtimeMs / 1000);
    const now = Math.floor(Date.now() / 1000);
    const title = extractTitleFromBody(newBody, relPath);
    const frontmatterJson = hasFm ? JSON.stringify(mergedFrontmatter) : null;
    upsertNoteIndex(getDb(), {
      vault: vaultName,
      path: relPath,
      title,
      frontmatter_json: frontmatterJson,
      body: newBody.length > 20000 ? newBody.slice(0, 20000) + '…' : newBody,
      modified_utc: modifiedUtc,
      updated_utc: now,
    });
  } catch (err) {
    logger.warn(`obsidian-write: reindex failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    vault: vaultName,
    path: relPath,
    absolutePath: absPath,
    action: exists ? 'appended' : 'created',
    bytesWritten,
    alreadyProcessed,
    newlyProcessed,
  };
}

// Re-export helper for tests
export const __test__ = { makeSnippet, resolveVaultRoot, assertInsideVault, insertUnderHeading };
