import { getDb } from '../db/database.js';

interface CalendarGetInput {
  eventId: number;
  includeNotes?: boolean;
  maxNotesChars?: number;
}

export function handleCalendarGet(args: CalendarGetInput) {
  const db = getDb();
  const includeNotes = args.includeNotes ?? true;
  const maxNotesChars = args.maxNotesChars ?? 20000;

  const row = db.prepare(`
    SELECT id, title, start_utc, end_utc, location, notes, url, calendar_name
    FROM cal_event
    WHERE id = ?
  `).get(args.eventId) as {
    id: number;
    title: string;
    start_utc: number;
    end_utc: number;
    location: string | null;
    notes: string | null;
    url: string | null;
    calendar_name: string;
  } | undefined;

  if (!row) {
    return { error: `Event not found: ${args.eventId}` };
  }

  let notes: string | null = null;
  if (includeNotes && row.notes) {
    notes = row.notes.length > maxNotesChars
      ? row.notes.slice(0, maxNotesChars) + '…'
      : row.notes;
  }

  return {
    eventId: row.id,
    title: row.title,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    location: row.location,
    notes,
    url: row.url,
    calendarName: row.calendar_name,
  };
}
