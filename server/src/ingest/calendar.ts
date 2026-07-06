import { getDb } from '../db/database.js';
import { logger } from '../log.js';

const HELPER_HOST = process.env.CAL_HELPER_HOST || '127.0.0.1';
const HELPER_PORT = parseInt(process.env.CAL_HELPER_PORT || '17831', 10);
const HELPER_TOKEN = process.env.CAL_HELPER_TOKEN || '';

interface CalendarSyncParams {
  startUtc: number;
  endUtc: number;
  mode?: string;
  calendarIds?: string[];
  includeNotes?: boolean;
}

export interface CalendarSyncResult {
  eventsUpserted: number;
  errors: number;
}

interface HelperEvent {
  eventIdentifier: string;
  calendarId: string;
  calendarName: string;
  title: string;
  location: string | null;
  url: string | null;
  notes: string | null;
  startUtc: number;
  endUtc: number;
  allDay: boolean;
  lastModifiedUtc: number | null;
}

async function helperFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`http://${HELPER_HOST}:${HELPER_PORT}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (HELPER_TOKEN) {
    headers['Authorization'] = `Bearer ${HELPER_TOKEN}`;
  }

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`calendar-helper responded ${resp.status}: ${text}`);
  }
  const json = await resp.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  if (!json.ok) {
    const errMsg = json.error?.message || 'Unknown helper error';
    throw new Error(`calendar-helper error: ${json.error?.code} — ${errMsg}`);
  }
  return json.data;
}

export async function checkHelperHealth(): Promise<boolean> {
  try {
    await helperFetch('/health');
    return true;
  } catch {
    return false;
  }
}

export async function syncCalendar(params: CalendarSyncParams): Promise<CalendarSyncResult> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let eventsUpserted = 0;
  let errors = 0;

  // Check helper is running
  const healthy = await checkHelperHealth();
  if (!healthy) {
    const errorMsg = 'calendar-helper is not running. Start it with: calendar-helper --serve';
    db.prepare(`
      UPDATE sync_state SET last_run_utc = ?, last_error = ? WHERE source = 'calendar'
    `).run(now, errorMsg);
    return { eventsUpserted: 0, errors: 1 };
  }

  try {
    // Fetch events from helper with pagination
    let cursor: string | null = null;
    const allEvents: HelperEvent[] = [];

    do {
      const queryParams: Record<string, string> = {
        startUtc: String(params.startUtc),
        endUtc: String(params.endUtc),
        limit: '500',
        includeNotes: String(params.includeNotes ?? true),
      };
      if (params.calendarIds && params.calendarIds.length > 0) {
        queryParams.calendarIds = params.calendarIds.join(',');
      }
      if (cursor) {
        queryParams.cursor = cursor;
      }

      const data = await helperFetch('/events', queryParams) as {
        events: HelperEvent[];
        nextCursor: string | null;
      };

      allEvents.push(...data.events);
      cursor = data.nextCursor;
    } while (cursor);

    // Upsert events into SQLite
    const upsert = db.prepare(`
      INSERT INTO cal_event (event_identifier, calendar_name, title, location, notes, url, start_utc, end_utc, updated_utc)
      VALUES (@event_identifier, @calendar_name, @title, @location, @notes, @url, @start_utc, @end_utc, @updated_utc)
      ON CONFLICT(event_identifier) DO UPDATE SET
        calendar_name = @calendar_name,
        title = @title,
        location = @location,
        notes = @notes,
        url = @url,
        start_utc = @start_utc,
        end_utc = @end_utc,
        updated_utc = @updated_utc
    `);

    const upsertAll = db.transaction(() => {
      for (const ev of allEvents) {
        try {
          upsert.run({
            event_identifier: ev.eventIdentifier,
            calendar_name: ev.calendarName,
            title: ev.title,
            location: ev.location,
            notes: ev.notes,
            url: ev.url,
            start_utc: ev.startUtc,
            end_utc: ev.endUtc,
            updated_utc: now,
          });
          eventsUpserted++;
        } catch (err) {
          logger.error(`Failed to upsert event: ${ev.eventIdentifier}`, err);
          errors++;
        }
      }
    });

    upsertAll();
  } catch (err) {
    logger.error('Calendar sync failed', err);
    errors++;
  }

  // Update sync_state
  const totalItems = (db.prepare('SELECT COUNT(*) as c FROM cal_event').get() as { c: number }).c;
  if (errors === 0) {
    db.prepare(`
      UPDATE sync_state SET last_run_utc = ?, last_ok_utc = ?, last_error = NULL, items_indexed = ?
      WHERE source = 'calendar'
    `).run(now, now, totalItems);
  } else {
    db.prepare(`
      UPDATE sync_state SET last_run_utc = ?, last_error = ?, items_indexed = ?
      WHERE source = 'calendar'
    `).run(now, `${errors} error(s) during sync`, totalItems);
  }

  return { eventsUpserted, errors };
}
