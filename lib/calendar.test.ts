import { describe, expect, it, vi } from 'vitest';
import { attendeeLine, currentEvent, detectApp, listEvents, listWindow, nextEvent, toCalendarEvent, type RawEvent } from './calendar';
import type { IdentityApi } from './google';
import type { CalendarEvent } from './types';

const MIN = 60_000;
const NOW = new Date(2026, 9, 28, 10, 0).getTime();
const ev = (id: string, startMin: number, lenMin = 30): CalendarEvent => ({
  id, title: id, start: NOW + startMin * MIN, end: NOW + (startMin + lenMin) * MIN, attendees: [],
});

describe('currentEvent', () => {
  it('matches events that started up to 10 min ago or start within 5 min', () => {
    expect(currentEvent([ev('a', -10)], NOW)?.id).toBe('a');
    expect(currentEvent([ev('a', 5)], NOW)?.id).toBe('a');
    expect(currentEvent([ev('a', -11)], NOW)).toBeUndefined();
    expect(currentEvent([ev('a', 6)], NOW)).toBeUndefined();
  });
  it('ignores events that are over and picks the closest start', () => {
    expect(currentEvent([ev('short', -8, 5)], NOW)).toBeUndefined();
    expect(currentEvent([ev('early', -9), ev('soon', 2)], NOW)?.id).toBe('soon');
  });
});

describe('nextEvent', () => {
  it('returns the next event that has not started, skipping the current one', () => {
    expect(nextEvent([ev('now', 3), ev('later', 240), ev('past', -30)], NOW, 'now')?.id).toBe('later');
    expect(nextEvent([ev('past', -30)], NOW)).toBeUndefined();
  });
});

describe('listWindow', () => {
  it('runs from 15 minutes ago to the end of today', () => {
    const w = listWindow(NOW);
    expect(w.timeMin).toBe(NOW - 15 * MIN);
    expect(new Date(w.timeMax).getHours()).toBe(23);
    expect(new Date(w.timeMax).getDate()).toBe(28);
  });
});

describe('detectApp', () => {
  it('finds the app from the conference link', () => {
    expect(detectApp('https://meet.google.com/abc-defg-hij')).toBe('meet');
    expect(detectApp('Join: https://us02web.zoom.us/j/123')).toBe('zoom');
    expect(detectApp('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(detectApp('Room 4B')).toBeUndefined();
  });
});

describe('toCalendarEvent', () => {
  const raw: RawEvent = {
    id: 'e1', summary: 'Weekly product sync',
    start: { dateTime: '2026-10-28T10:00:00Z' }, end: { dateTime: '2026-10-28T10:30:00Z' },
    attendees: [
      { email: 'you@example.com', self: true },
      { email: 'priya@example.com', displayName: 'Priya Shah' },
      { email: 'sam.lee@example.com' },
      { email: 'room-4b@resource.calendar.google.com', resource: true },
    ],
    conferenceData: { entryPoints: [{ uri: 'https://zoom.us/j/1' }] },
  };
  it('maps attendees without rooms and keeps self', () => {
    const e = toCalendarEvent(raw)!;
    expect(e.attendees).toEqual([
      { email: 'you@example.com', self: true },
      { email: 'priya@example.com', name: 'Priya Shah' },
      { email: 'sam.lee@example.com' },
    ]);
    expect(e.app).toBe('zoom');
    expect(e.start).toBe(Date.parse('2026-10-28T10:00:00Z'));
  });
  it('skips all-day and cancelled events', () => {
    expect(toCalendarEvent({ id: 'x', start: { date: '2026-10-28' }, end: { date: '2026-10-29' } })).toBeNull();
    expect(toCalendarEvent({ ...raw, status: 'cancelled' })).toBeNull();
  });
  it('builds the "With" line from the other guests', () => {
    expect(attendeeLine(toCalendarEvent(raw)!)).toBe('With Priya and Sam');
    expect(attendeeLine(undefined)).toBe('');
  });
});

describe('listEvents', () => {
  it('lists the chosen calendar and drops declined events', async () => {
    const identity: IdentityApi = { getAuthToken: async () => ({ token: 'ya29.test' }), removeCachedAuthToken: async () => undefined };
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ items: [
      { id: 'a', summary: 'A', start: { dateTime: '2026-10-28T10:00:00Z' }, end: { dateTime: '2026-10-28T11:00:00Z' } },
      { id: 'b', summary: 'B', start: { dateTime: '2026-10-28T12:00:00Z' }, end: { dateTime: '2026-10-28T13:00:00Z' },
        attendees: [{ email: 'you@example.com', self: true, responseStatus: 'declined' }] },
    ] }), { status: 200 }));
    const events = await listEvents('work@group.calendar.google.com', NOW, { identity, fetch: fetch as unknown as typeof globalThis.fetch, clientId: 'x' });
    expect(events.map((e) => e.id)).toEqual(['a']);
    const url = fetch.mock.calls[0]![0];
    expect(url).toContain('/calendars/work%40group.calendar.google.com/events?');
    expect(url).toContain('singleEvents=true');
  });
});
