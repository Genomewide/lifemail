import { getDb } from '../db/database.js';

interface MailGetThreadInput {
  threadKey: string;
  maxBodyChars?: number;
}

function truncate(text: string | null, maxChars: number): string | null {
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

export function handleMailGetThread(args: MailGetThreadInput) {
  const db = getDb();
  const maxBodyChars = args.maxBodyChars ?? 20000;

  const rows = db.prepare(`
    SELECT id, date_utc, subject, from_email, to_text, cc_text,
           mailbox, thread_key, is_read, has_attachments, attachment_info,
           category, body_unique, body_text
    FROM mail_message
    WHERE thread_key = ?
    ORDER BY date_utc ASC
  `).all(args.threadKey) as Array<{
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
    body_unique: string | null;
    body_text: string | null;
  }>;

  if (rows.length === 0) {
    return { error: `No messages found for thread: ${args.threadKey}` };
  }

  // Collect all unique participants
  const participants = new Set<string>();
  for (const row of rows) {
    if (row.from_email) participants.add(row.from_email);
  }

  const messages = rows.map(row => ({
    mailId: row.id,
    dateUtc: row.date_utc,
    subject: row.subject,
    from: row.from_email,
    to: row.to_text ? row.to_text.split(',').map(s => s.trim()).filter(Boolean) : [],
    cc: row.cc_text ? row.cc_text.split(',').map(s => s.trim()).filter(Boolean) : [],
    isRead: row.is_read === 1,
    hasAttachments: row.has_attachments === 1,
    // Prefer body_unique (stripped of quotes), fall back to body_text
    bodyText: truncate(row.body_unique || row.body_text, maxBodyChars),
  }));

  return {
    threadKey: args.threadKey,
    subject: rows[rows.length - 1].subject,
    messageCount: rows.length,
    participants: Array.from(participants),
    messages,
  };
}
