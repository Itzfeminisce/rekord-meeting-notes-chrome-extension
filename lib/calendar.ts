/** Google Calendar: today's events for the chosen calendar, the one happening now, and the next one. */
import { getMeeting, putMeeting } from './db';
import { googleFetch, SCOPES, type GoogleDeps } from './google';
import type { CalendarEvent } from './types';

const MIN = 60_000;
/** Events are listed from this long before now. */
export const LOOKBACK_MS = 15 * MIN;
/** An event counts as "now" if it started up to this long ago… */
export const STARTED_WITHIN_MS = 10 * MIN;
/** …or starts within this long. */
export const STARTS_WITHIN_MS = 5 * MIN;

/** The fields Rekord reads from a Calendar API event. */
export interface RawEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
  hangoutLink?: string;
  location?: string;
  description?: string;
  conferenceData?: { entryPoints?: { uri?: string }[]; conferenceSolution?: { name?: string } };
}

export interface CalendarInfo { id: string; name: string; primary: boolean }

/** Which app a conference link belongs to. */
export function detectApp(text: string | undefined): CalendarEvent['app'] {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t.includes('meet.google.com')) return 'meet';
  if (/(^|[./])zoom\.us\b|zoomgov\.com/.test(t)) return 'zoom';
  if (t.includes('teams.microsoft.com') || t.includes('teams.live.com')) return 'teams';
  return undefined;
}

export const APP_NAMES: Record<NonNullable<CalendarEvent['app']>, string> = { meet: 'Meet', zoom: 'Zoom', teams: 'Teams' };

/** Maps a Calendar API event; null for all-day, cancelled or untimed events. */
export function toCalendarEvent(raw: RawEvent): CalendarEvent | null {
  if (raw.status === 'cancelled' || !raw.start?.dateTime || !raw.end?.dateTime) return null;
  const start = Date.parse(raw.start.dateTime);
  const end = Date.parse(raw.end.dateTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const attendees = (raw.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({ email: a.email as string, ...(a.displayName ? { name: a.displayName } : {}), ...(a.self ? { self: true } : {}) }));
  const links = [raw.hangoutLink, ...(raw.conferenceData?.entryPoints ?? []).map((e) => e.uri), raw.location, raw.description];
  let app: CalendarEvent['app'];
  for (const l of links) {
    app = detectApp(l);
    if (app) break;
  }
  return { id: raw.id, title: raw.summary?.trim() || 'Untitled meeting', start, end, attendees, ...(app ? { app } : {}) };
}

/** The event happening now: started ≤10 min ago or starting in ≤5 min, not over. Closest start wins. */
export function currentEvent(events: CalendarEvent[], now: number): CalendarEvent | undefined {
  return events
    .filter((e) => e.end > now && e.start >= now - STARTED_WITHIN_MS && e.start <= now + STARTS_WITHIN_MS)
    .sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))[0];
}

/** The next event that hasn't started yet (excluding `except`, e.g. the current one). */
export function nextEvent(events: CalendarEvent[], now: number, except?: string): CalendarEvent | undefined {
  return events.filter((e) => e.start > now && e.id !== except).sort((a, b) => a.start - b.start)[0];
}

/** Window for listing: 15 minutes ago until the end of today (local time). */
export function listWindow(now: number): { timeMin: number; timeMax: number } {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { timeMin: now - LOOKBACK_MS, timeMax: end.getTime() };
}

/** Lists today's events (from 15 minutes ago) for the calendar. Throws GoogleError ('auth' = access lost). */
export async function listEvents(calendarId: string | undefined, now: number, deps: GoogleDeps = {}): Promise<CalendarEvent[]> {
  const { timeMin, timeMax } = listWindow(now);
  const q = new URLSearchParams({
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const id = encodeURIComponent(calendarId || 'primary');
  const res = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/${id}/events?${q}`, [SCOPES.calendar], deps);
  const body = (await res.json()) as { items?: RawEvent[] };
  return (body.items ?? [])
    .filter((e) => !e.attendees?.some((a) => a.self && a.responseStatus === 'declined'))
    .map(toCalendarEvent)
    .filter((e): e is CalendarEvent => !!e);
}

/** Calendars the user can read, primary first. */
export async function listCalendars(deps: GoogleDeps = {}): Promise<CalendarInfo[]> {
  const res = await googleFetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', [SCOPES.calendar], deps);
  const body = (await res.json()) as { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean }[] };
  return (body.items ?? [])
    .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
}

/** People invited, without rooms. */
export function peopleCount(event: CalendarEvent): number {
  return event.attendees.length;
}

/** "10:00" style local time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** First name (or the email's name part) of an attendee. */
export function attendeeName(a: CalendarEvent['attendees'][number]): string {
  if (a.name) return a.name.trim().split(/\s+/)[0] ?? a.name;
  const local = a.email.split('@')[0] ?? a.email;
  const first = local.split(/[._-]/)[0] || local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** "With Priya, Sam and Leo" from the other guests; '' when there are none. */
export function attendeeLine(event: CalendarEvent | undefined): string {
  const names = (event?.attendees ?? []).filter((a) => !a.self).map(attendeeName);
  if (names.length === 0) return '';
  if (names.length === 1) return `With ${names[0]}`;
  return `With ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Saves the matched event on a meeting that just started; fills the title if the user left it empty. */
export async function attachEvent(meetingId: string, event: CalendarEvent): Promise<void> {
  const m = await getMeeting(meetingId);
  if (!m) return;
  await putMeeting({ ...m, event, title: m.title?.trim() ? m.title : event.title });
}
