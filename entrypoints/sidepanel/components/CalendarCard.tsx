import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { clock, currentEvent, listEvents, nextEvent, peopleCount } from '@/lib/calendar';
import { GoogleError, type GoogleDeps } from '@/lib/google';
import { getSettings } from '@/lib/settings';
import type { CalendarEvent } from '@/lib/types';
import { useRouter } from '../router';
import { openGoogleConnect } from '../screens/GoogleConnect';

export type CalendarState =
  | { status: 'loading' | 'off' | 'error' | 'lost' }
  | { status: 'ready'; events: CalendarEvent[] };

/** Today's events when Google Calendar is connected. 'lost' = Google no longer gives access. */
export function useCalendar(deps?: GoogleDeps): CalendarState {
  const [state, setState] = useState<CalendarState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { google } = await getSettings();
        if (!google.calendar) return alive && setState({ status: 'off' });
        const events = await listEvents(google.calendarId, Date.now(), deps);
        if (alive) setState({ status: 'ready', events });
      } catch (err) {
        if (alive) setState({ status: err instanceof GoogleError && err.code === 'auth' ? 'lost' : 'error' });
      }
    })();
    return () => { alive = false; };
  }, [deps]);
  return state;
}

const s = {
  card: { margin: '0 16px', padding: 14, borderRadius: 16, background: '#EEF0FF', border: '1px solid #D9D7FB', display: 'flex', gap: 12, alignItems: 'center' },
  tile: { width: 40, height: 40, borderRadius: 12, background: '#FFFFFF', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  tileNow: { fontSize: 10, fontWeight: 600, color: '#4F46E5' },
  tileTime: { fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500, color: '#2E2A8A' },
  text: { flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  title: { fontSize: 14, fontWeight: 600, color: '#1E1B5C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sub: { fontSize: 12, color: '#3730A3' },
  now: { fontSize: 12, fontWeight: 600, color: '#1A6B40', flexShrink: 0 },
  empty: { margin: '0 16px', padding: '12px 14px', borderRadius: 14, background: '#FFFFFF', border: '1px dashed #DCDCE0', display: 'flex', alignItems: 'center', gap: 10 },
  emptyText: { flexGrow: 1, fontSize: 13, color: '#44464D' },
  lost: { margin: '0 16px', padding: '12px 14px', borderRadius: 14, background: '#FFF8EC', border: '1px solid #F5DDB0', display: 'flex', alignItems: 'center', gap: 10 },
  lostText: { flexGrow: 1, fontSize: 13, lineHeight: 1.45, color: '#5C3200' },
  lostBtn: { height: 32, padding: '0 12px', borderRadius: 9, background: '#FFFFFF', border: '1px solid #F5DDB0', color: '#5C3200', font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  upHead: { margin: '10px 0 0', padding: '0 4px', fontSize: 12, fontWeight: 600, color: '#6E7079' },
  up: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 16, border: '1px dashed #DCDCE0' },
  upTime: { fontFamily: 'var(--mono)', fontSize: 12, color: '#4F46E5', width: 44, flexShrink: 0 },
  upTitle: { fontSize: 14, fontWeight: 500 },
  upSub: { fontSize: 12, color: '#6E7079' },
} satisfies Record<string, CSSProperties>;

function people(n: number, invited: boolean): string {
  const word = n === 1 ? 'person' : 'people';
  return `From your calendar · ${n} ${word}${invited ? ' invited' : ''}`;
}

/**
 * Start screen: the event happening now, "nothing on the calendar", or the reconnect banner.
 * Calls `onEvent` with the current event (or undefined) so Start can name the meeting and attach the event.
 */
export function CalendarCard({ onEvent, deps }: { onEvent?: (event: CalendarEvent | undefined) => void; deps?: GoogleDeps }) {
  const router = useRouter();
  const cal = useCalendar(deps);
  const event = cal.status === 'ready' ? currentEvent(cal.events, Date.now()) : undefined;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const id = event?.id ?? '';
    if (cal.status !== 'ready' || reported.current === id) return;
    reported.current = id;
    onEvent?.(event);
  }, [cal.status, event, onEvent]);

  if (cal.status === 'lost') {
    return (
      <div role="alert" style={s.lost}>
        <span style={s.lostText}>Rekord can’t see your calendar anymore.</span>
        <button type="button" style={s.lostBtn} onClick={() => openGoogleConnect(router, 'start')}>Reconnect</button>
      </div>
    );
  }
  if (cal.status !== 'ready') return null;
  if (!event) {
    return (
      <div style={s.empty}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6E7079" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        <span style={s.emptyText}>No meeting on your calendar right now. Name this one yourself.</span>
      </div>
    );
  }
  return (
    <section aria-label="From your calendar" style={s.card}>
      <span style={s.tile}><span style={s.tileNow}>NOW</span><span style={s.tileTime}>{clock(event.start)}</span></span>
      <span style={s.text}><span style={s.title}>{event.title}</span><span style={s.sub}>{people(peopleCount(event), true)}</span></span>
      <span style={s.now}>Happening now</span>
    </section>
  );
}

/** Library: the next event on today's calendar (not a link). Nothing when Calendar isn't connected. */
export function ComingUp({ deps }: { deps?: GoogleDeps }) {
  const cal = useCalendar(deps);
  if (cal.status !== 'ready') return null;
  const now = Date.now();
  const next = nextEvent(cal.events, now, currentEvent(cal.events, now)?.id);
  if (!next) return null;
  return (
    <section aria-labelledby="coming-up" style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 id="coming-up" style={s.upHead}>Coming up</h2>
      <div style={s.up}>
        <span style={s.upTime}>{clock(next.start)}</span>
        <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={s.upTitle}>{next.title}</span>
          <span style={s.upSub}>{people(peopleCount(next), false)}</span>
        </span>
      </div>
    </section>
  );
}
