import { syncCalendar, type CalendarSyncResult } from '../ingest/calendar.js';

interface CalendarSyncInput {
  startUtc?: number;
  endUtc?: number;
  mode?: string;
  calendarIds?: string[];
  includeNotes?: boolean;
}

export async function handleCalendarSync(args: CalendarSyncInput): Promise<CalendarSyncResult> {
  const now = Math.floor(Date.now() / 1000);
  // Default: sync next 30 days
  const startUtc = args.startUtc ?? now;
  const endUtc = args.endUtc ?? (now + 30 * 86400);

  return syncCalendar({
    startUtc,
    endUtc,
    mode: args.mode ?? 'incremental',
    calendarIds: args.calendarIds,
    includeNotes: args.includeNotes,
  });
}
