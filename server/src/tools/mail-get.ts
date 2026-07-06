import { getDb } from '../db/database.js';

interface MailGetInput {
  mailId: number;
  includeBody?: boolean;
  maxBodyChars?: number;
  includeHtml?: boolean;
  includeAttachments?: boolean;
}

function truncate(text: string | null, maxChars: number): string | null {
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

export function handleMailGet(args: MailGetInput) {
  const db = getDb();
  const includeBody = args.includeBody ?? true;
  const maxBodyChars = args.maxBodyChars ?? 20000;
  const includeHtml = args.includeHtml ?? false;

  const row = db.prepare(`
    SELECT id, date_utc, subject, from_email, to_text, cc_text,
           mailbox, thread_key, is_read, has_attachments, attachment_info, category,
           body_text, body_html
    FROM mail_message
    WHERE id = ?
  `).get(args.mailId) as {
    id: number;
    date_utc: number;
    subject: string;
    from_email: string;
    to_text: string;
    cc_text: string;
    mailbox: string;
    thread_key: string;
    is_read: number;
    has_attachments: number;
    attachment_info: string | null;
    category: string | null;
    body_text: string | null;
    body_html: string | null;
  } | undefined;

  if (!row) {
    return { error: `Message not found: ${args.mailId}` };
  }

  // Parse to/cc as arrays
  const toArr = row.to_text ? row.to_text.split(',').map(s => s.trim()).filter(Boolean) : [];
  const ccArr = row.cc_text ? row.cc_text.split(',').map(s => s.trim()).filter(Boolean) : [];

  return {
    mailId: row.id,
    dateUtc: row.date_utc,
    subject: row.subject,
    from: row.from_email,
    to: toArr,
    cc: ccArr,
    mailbox: row.mailbox,
    threadKey: row.thread_key,
    isRead: row.is_read === 1,
    hasAttachments: row.has_attachments === 1,
    category: row.category,
    bodyText: includeBody ? truncate(row.body_text, maxBodyChars) : null,
    bodyHtml: (includeBody && includeHtml) ? truncate(row.body_html, maxBodyChars) : null,
    attachments: row.attachment_info ? JSON.parse(row.attachment_info) : []
  };
}
