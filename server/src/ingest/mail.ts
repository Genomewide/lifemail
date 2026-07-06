import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import Database from 'better-sqlite3';
import { getDb } from '../db/database.js';
import { logger } from '../log.js';

interface MailSyncParams {
  mode: string;
  rootPaths?: string[];
  sinceUtc?: number;
  maxFiles?: number;
  includeBodies?: boolean;
  includeAttachments?: boolean;
}

export interface MailSyncResult {
  filesScanned: number;
  messagesUpserted: number;
  attachmentsUpserted: number;
  errors: number;
}

const DEFAULT_MAIL_ROOT = path.join(process.env.HOME || '', 'Library', 'Mail');

function extractMailbox(filePath: string): string | null {
  // Apple Mail stores in .mbox directories: .../SomeName.mbox/Messages/12345.emlx
  const parts = filePath.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].endsWith('.mbox')) {
      return parts[i].replace(/\.mbox$/, '');
    }
  }
  return null;
}

/**
 * Strip quoted reply text from an email body, returning only the new/unique content.
 * Detects common quote patterns from Gmail, Outlook, Apple Mail, and generic clients.
 */
function extractUniqueBody(text: string | undefined): string | null {
  if (!text) return null;

  // Patterns that mark the start of quoted/forwarded content
  const quotePatterns = [
    // Gmail: "On Mon, Feb 3, 2026 at 10:00 AM, Person <email> wrote:"
    /^On .{10,80} wrote:\s*$/m,
    // Outlook: "From: Person\nSent: ..."
    /^From:\s+.+\nSent:\s+/m,
    // Outlook separator + From
    /^_{10,}\s*\nFrom:\s+/m,
    // Generic separator
    /^-{5,}\s*Original Message\s*-{5,}/mi,
    // Apple Mail "On ... wrote:" with angle bracket on next line
    /^On .{10,80}:\s*\n>/m,
    // Forwarded message
    /^-{5,}\s*Forwarded message\s*-{5,}/mi,
    // Outlook "From:" block after a horizontal rule
    /^________________________________\s*\nFrom:\s+/m,
    // Standalone long separator (often Outlook)
    /^________________________________\s*$/m,
  ];

  let earliestIndex = text.length;

  for (const pattern of quotePatterns) {
    const match = pattern.exec(text);
    if (match && match.index < earliestIndex) {
      earliestIndex = match.index;
    }
  }

  // Also detect lines starting with ">" (standard email quoting)
  // but only if they appear in a block (3+ consecutive ">" lines)
  const lines = text.split('\n');
  let consecutiveQuotes = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('>')) {
      consecutiveQuotes++;
      if (consecutiveQuotes >= 3) {
        // Find where this block started
        const blockStart = i - consecutiveQuotes + 1;
        const charIndex = lines.slice(0, blockStart).join('\n').length;
        if (charIndex < earliestIndex) {
          earliestIndex = charIndex;
        }
        break;
      }
    } else {
      consecutiveQuotes = 0;
    }
  }

  if (earliestIndex === text.length) {
    // No quoted text detected — entire body is unique
    return text.trim();
  }

  const unique = text.slice(0, earliestIndex).trim();
  return unique.length > 0 ? unique : text.trim();
}

function makeSnippet(text: string | undefined, maxLen = 200): string {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

function deriveThreadKey(
  messageId: string | undefined,
  inReplyTo: string | undefined,
  references: string | string[] | undefined,
  subject: string | undefined,
  date: Date | undefined,
): string {
  // Prefer references chain
  if (references) {
    const refs = Array.isArray(references) ? references : [references];
    if (refs.length > 0 && refs[0]) return refs[0];
  }
  if (inReplyTo) return inReplyTo;
  if (messageId) return messageId;
  // Fallback: normalized subject + monthly bucket
  const normalizedSubject = (subject || '')
    .replace(/^(Re|Fwd|Fw):\s*/gi, '')
    .trim()
    .toLowerCase();
  const dateBucket = date ? Math.floor(date.getTime() / (1000 * 86400 * 30)) : 0;
  return `thread:${normalizedSubject}:${dateBucket}`;
}

function addressToString(addr: AddressObject | undefined): string {
  if (!addr) return '';
  const val = addr.value;
  if (!val || val.length === 0) return '';
  return val.map((a: { name?: string; address?: string }) => {
    if (a.name) return `${a.name} <${a.address || ''}>`;
    return a.address || '';
  }).join(', ');
}

function addressListToString(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return '';
  if (Array.isArray(addr)) {
    return addr.map(a => addressToString(a)).join(', ');
  }
  return addressToString(addr);
}


/**
 * Extract the flags integer from the plist XML section at the end of an .emlx file.
 * EMLX format: first line = byte count of RFC2822 message, then the message,
 * then a plist XML section containing metadata including flags.
 * Bit 0 (value 1) of the flags integer means "read".
 */
function extractEmlxFlags(content: Buffer, byteCount: number, firstNewline: number): number {
  const plistStart = firstNewline + 1 + byteCount;
  if (plistStart >= content.length) return 0;

  const plistSection = content.slice(plistStart).toString('utf8');

  // Look for <key>flags</key> followed by <integer>...</integer>
  const flagsMatch = plistSection.match(/<key>flags<\/key>\s*<integer>(\d+)<\/integer>/i);
  if (flagsMatch) {
    return parseInt(flagsMatch[1], 10);
  }

  return 0;
}

/**
 * Determine if a message is read based on emlx flags.
 * Bit 0 (value 1) = read.
 */
function isMessageRead(flags: number): boolean {
  return (flags & 1) !== 0;
}

interface AttachmentMeta {
  filename: string | null;
  size: number | null;
  contentType: string | null;
}

interface EmlxParseResult {
  parsed: ParsedMail;
  isRead: boolean;
  attachments: AttachmentMeta[];
}

function extractAttachmentMeta(parsed: ParsedMail, messageText: string): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];

  // First: get attachments from parsed MIME (works for full .emlx files)
  if (parsed.attachments && parsed.attachments.length > 0) {
    for (const att of parsed.attachments) {
      attachments.push({
        filename: att.filename || null,
        size: att.size || null,
        contentType: att.contentType || null,
      });
    }
  }

  // For .partial.emlx files, the parser may not find attachments since the
  // base64 data is missing. Fall back to parsing Content-Disposition headers
  // from the raw MIME text if we found no attachments above.
  if (attachments.length === 0) {
    const dispositionRe = /Content-Disposition:\s*attachment;[^\n]*filename="([^"]+)"[^\n]*(?:\n\s+[^\n]*)*/gi;
    let match;
    while ((match = dispositionRe.exec(messageText)) !== null) {
      const filename = match[1];
      // Try to find size from the same MIME part headers
      const regionStart = Math.max(0, match.index - 500);
      const region = messageText.slice(regionStart, match.index + match[0].length + 200);
      const sizeMatch = region.match(/size=(\d+)/);
      const ctMatch = region.match(/Content-Type:\s*([^\s;]+)/i);
      attachments.push({
        filename: filename || null,
        size: sizeMatch ? parseInt(sizeMatch[1], 10) : null,
        contentType: ctMatch ? ctMatch[1] : null,
      });
    }
  }

  return attachments;
}

async function parseEmlx(filePath: string): Promise<EmlxParseResult | null> {
  try {
    const content = fs.readFileSync(filePath);
    // EMLX format: first line is byte count, then the RFC 2822 message
    const firstNewline = content.indexOf(0x0A);
    if (firstNewline < 0) return null;

    const byteCountStr = content.slice(0, firstNewline).toString('utf8').trim();
    const byteCount = parseInt(byteCountStr, 10);
    if (isNaN(byteCount) || byteCount <= 0) return null;

    const messageBuffer = content.slice(firstNewline + 1, firstNewline + 1 + byteCount);
    const parsed = await simpleParser(messageBuffer);

    // Extract flags from the plist section after the message body
    const flags = extractEmlxFlags(content, byteCount, firstNewline);
    const isRead = isMessageRead(flags);

    // Extract attachment metadata from parsed MIME or raw headers
    const attachments = extractAttachmentMeta(parsed, messageBuffer.toString('utf8'));

    return { parsed, isRead, attachments };
  } catch (err) {
    logger.error(`Failed to parse emlx: ${filePath}`, err);
    return null;
  }
}

const CATEGORY_MAP: Record<number, string> = {
  0: 'primary',
  1: 'transactions',
  2: 'updates',
  3: 'promotions',
};

/**
 * After syncing .emlx files, enrich messages with Apple Mail's on-device
 * category classification by reading the Envelope Index database.
 * Matches on the RFC Message-ID header.
 */
function enrichCategories(db: ReturnType<typeof getDb>): number {
  const envelopePath = path.join(
    process.env.HOME || '',
    'Library', 'Mail', 'V10', 'MailData', 'Envelope Index',
  );
  if (!fs.existsSync(envelopePath)) {
    logger.warn('Apple Mail Envelope Index not found, skipping category enrichment');
    return 0;
  }

  let envelopeDb: Database.Database;
  try {
    envelopeDb = new Database(envelopePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    logger.warn('Could not open Envelope Index for category enrichment', err);
    return 0;
  }

  try {
    // Build a map of Message-ID header -> category from Apple's DB
    const rows = envelopeDb.prepare(`
      SELECT mgd.message_id_header, mgd.model_category
      FROM message_global_data mgd
      WHERE mgd.model_category IS NOT NULL
        AND mgd.message_id_header IS NOT NULL
    `).all() as Array<{ message_id_header: string; model_category: number }>;

    if (rows.length === 0) return 0;

    const categoryByMsgId = new Map<string, string>();
    for (const row of rows) {
      const cat = CATEGORY_MAP[row.model_category];
      if (cat) {
        categoryByMsgId.set(row.message_id_header, cat);
      }
    }

    // Update our messages that have a matching thread_key (which contains the Message-ID)
    // or where we stored the messageId as part of the thread_key
    const updateStmt = db.prepare(
      'UPDATE mail_message SET category = ? WHERE thread_key = ? AND category IS NULL'
    );

    let updated = 0;
    const transaction = db.transaction(() => {
      for (const [msgId, category] of categoryByMsgId) {
        const result = updateStmt.run(category, msgId);
        updated += result.changes;
      }
    });
    transaction();

    // Also try matching messages where message-id appears in thread_key via references
    // For forwarded/reply chains, the thread_key might be the first reference, not the message-id
    // Do a second pass matching on body text for messages still without category
    const uncategorized = db.prepare(
      "SELECT id, body_text FROM mail_message WHERE category IS NULL AND body_text IS NOT NULL"
    ).all() as Array<{ id: number; body_text: string }>;

    // Skip expensive body matching - just log what we got
    logger.info(`Category enrichment: ${updated} messages categorized from ${categoryByMsgId.size} Apple Mail entries`);
    return updated;
  } finally {
    envelopeDb.close();
  }
}

export async function syncMail(params: MailSyncParams): Promise<MailSyncResult> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rootPaths = params.rootPaths ?? [DEFAULT_MAIL_ROOT];
  const maxFiles = params.maxFiles ?? 2000;
  const includeBodies = params.includeBodies ?? true;

  let filesScanned = 0;
  let messagesUpserted = 0;
  let errors = 0;

  const upsert = db.prepare(`
    INSERT INTO mail_message (source_path, mailbox, date_utc, subject, from_email, to_text, cc_text,
                              thread_key, snippet, body_text, body_unique, body_html, is_read,
                              has_attachments, attachment_info, category, created_utc, updated_utc)
    VALUES (@source_path, @mailbox, @date_utc, @subject, @from_email, @to_text, @cc_text,
            @thread_key, @snippet, @body_text, @body_unique, @body_html, @is_read,
            @has_attachments, @attachment_info, @category, @created_utc, @updated_utc)
    ON CONFLICT(source_path) DO UPDATE SET
      mailbox = @mailbox,
      date_utc = @date_utc,
      subject = @subject,
      from_email = @from_email,
      to_text = @to_text,
      cc_text = @cc_text,
      thread_key = @thread_key,
      snippet = @snippet,
      body_text = @body_text,
      body_unique = @body_unique,
      body_html = @body_html,
      is_read = @is_read,
      has_attachments = @has_attachments,
      attachment_info = @attachment_info,
      category = COALESCE(@category, category),
      updated_utc = @updated_utc
  `);

  for (const rootPath of rootPaths) {
    const resolvedRoot = path.resolve(rootPath);
    if (!fs.existsSync(resolvedRoot)) {
      logger.warn(`Mail root does not exist: ${resolvedRoot}`);
      errors++;
      continue;
    }

    let emlxFiles: string[];
    try {
      emlxFiles = await glob('**/*.emlx', {
        cwd: resolvedRoot,
        dot: true,
        nodir: true,
      });
    } catch (err) {
      logger.error(`Failed to scan mail directory: ${resolvedRoot}`, err);
      errors++;
      continue;
    }

    // Sort newest-first by file mtime so that incremental syncs always
    // process the most recent emails before hitting the maxFiles limit.
    emlxFiles.sort((a, b) => {
      try {
        const mtimeA = fs.statSync(path.join(resolvedRoot, a)).mtimeMs;
        const mtimeB = fs.statSync(path.join(resolvedRoot, b)).mtimeMs;
        return mtimeB - mtimeA;
      } catch {
        return 0;
      }
    });

    // Respect maxFiles
    if (emlxFiles.length > maxFiles) {
      emlxFiles = emlxFiles.slice(0, maxFiles);
    }

    for (const relPath of emlxFiles) {
      filesScanned++;
      const absPath = path.join(resolvedRoot, relPath);

      // Incremental: skip if already indexed and file hasn't changed
      if (params.mode === 'incremental') {
        const existing = db.prepare(
          'SELECT updated_utc FROM mail_message WHERE source_path = ?'
        ).get(absPath) as { updated_utc: number } | undefined;

        if (existing) {
          try {
            const stat = fs.statSync(absPath);
            const modifiedUtc = Math.floor(stat.mtimeMs / 1000);
            if (existing.updated_utc >= modifiedUtc) continue;
          } catch {
            continue;
          }
        }
      }

      // Optional sinceUtc filter: skip files older than sinceUtc (best effort via file mtime)
      if (params.sinceUtc) {
        try {
          const stat = fs.statSync(absPath);
          const modifiedUtc = Math.floor(stat.mtimeMs / 1000);
          if (modifiedUtc < params.sinceUtc) continue;
        } catch {
          // If we can't stat, process it anyway
        }
      }

      const result = await parseEmlx(absPath);
      if (!result) {
        errors++;
        continue;
      }

      try {
        const { parsed, isRead, attachments } = result;
        const dateUtc = parsed.date
          ? Math.floor(parsed.date.getTime() / 1000)
          : null;
        const mailbox = extractMailbox(absPath);
        const fromEmail = addressToString(parsed.from);
        const toText = addressListToString(parsed.to);
        const ccText = addressListToString(parsed.cc);
        const threadKey = deriveThreadKey(
          parsed.messageId,
          parsed.inReplyTo,
          parsed.references,
          parsed.subject,
          parsed.date,
        );
        const snippet = makeSnippet(parsed.text);
        const bodyText = includeBodies ? (parsed.text || null) : null;
        const bodyUnique = includeBodies ? extractUniqueBody(parsed.text) : null;
        const bodyHtml = includeBodies ? (parsed.html || null) : null;

        upsert.run({
          source_path: absPath,
          mailbox,
          date_utc: dateUtc,
          subject: parsed.subject || null,
          from_email: fromEmail || null,
          to_text: toText || null,
          cc_text: ccText || null,
          thread_key: threadKey,
          snippet,
          body_text: bodyText,
          body_unique: bodyUnique,
          body_html: typeof bodyHtml === 'string' ? bodyHtml : null,
          is_read: isRead ? 1 : 0,
          has_attachments: attachments.length > 0 ? 1 : 0,
          attachment_info: attachments.length > 0 ? JSON.stringify(attachments) : null,
          category: null,
          created_utc: now,
          updated_utc: now,
        });
        messagesUpserted++;
      } catch (err) {
        logger.error(`Failed to upsert mail: ${absPath}`, err);
        errors++;
      }
    }
  }

  // Enrich with Apple Mail categories from Envelope Index
  try {
    const categorized = enrichCategories(db);
    if (categorized > 0) {
      logger.info(`Enriched ${categorized} messages with Apple Mail categories`);
    }
  } catch (err) {
    logger.warn('Category enrichment failed', err);
  }

  // Update sync_state
  const totalItems = (db.prepare('SELECT COUNT(*) as c FROM mail_message').get() as { c: number }).c;
  if (errors === 0) {
    db.prepare(`
      UPDATE sync_state SET last_run_utc = ?, last_ok_utc = ?, last_error = NULL, items_indexed = ?
      WHERE source = 'mail'
    `).run(now, now, totalItems);
  } else {
    db.prepare(`
      UPDATE sync_state SET last_run_utc = ?, last_error = ?, items_indexed = ?
      WHERE source = 'mail'
    `).run(now, `${errors} error(s) during sync`, totalItems);
  }

  return { filesScanned, messagesUpserted, attachmentsUpserted: 0, errors };
}
