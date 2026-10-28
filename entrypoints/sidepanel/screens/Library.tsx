import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteMeeting, listMeetings, listSegments } from '@/lib/db';
import { dateLabel, groupMeetings, joinTranscript, matchesQuery, openActions } from '@/lib/library';
import { formatDuration } from '@/lib/time';
import type { Meeting } from '@/lib/types';
import { Button, EmptyState, Spinner } from '../components';
import { ComingUp } from '../components/CalendarCard';
import { useRouter } from '../router';

type Filter = 'all' | 'actions';

export default function Library() {
  const { navigate, back } = useRouter();
  const [meetings, setMeetings] = useState<Meeting[] | undefined>();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const list = await listMeetings();
      setMeetings(list);
      const entries = await Promise.all(list.map(async (m) => [m.id, joinTranscript(await listSegments(m.id))] as const));
      setTexts(Object.fromEntries(entries));
    } catch {
      setError(true);
      setMeetings((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = (m: Meeting) => navigate(m.status === 'done' ? 'summary' : m.status === 'recording' ? 'live' : 'processing', { meetingId: m.id });

  const remove = async (id: string) => {
    setConfirming(null);
    const target = meetings?.find((m) => m.id === id);
    if (target && (target.status === 'recording' || target.status === 'processing')) return;
    try {
      await deleteMeeting(id);
      setMeetings((cur) => cur?.filter((m) => m.id !== id));
    } catch {
      setError(true);
    }
  };

  const actionCount = useMemo(() => (meetings ?? []).filter((m) => openActions(m) > 0).length, [meetings]);
  const shown = useMemo(
    () => (meetings ?? []).filter((m) => (filter === 'all' || openActions(m) > 0) && matchesQuery(m, texts[m.id], query)),
    [meetings, texts, query, filter],
  );
  const groups = useMemo(() => groupMeetings(shown), [shown]);

  return (
    <main className="screen lib">
      <header className="lib-head">
        <button type="button" className="icon-btn" aria-label="Back to home" onClick={back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <h1>Meetings</h1>
        {meetings && <span className="lib-count">{meetings.length} saved</span>}
      </header>

      <div className="lib-tools">
        <div className="lib-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6E7079" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <label htmlFor="q" className="sr-only">Search meetings</label>
          <input id="q" type="search" placeholder="Search every meeting" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div role="group" aria-label="Filter" className="lib-filters">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
          <button type="button" aria-pressed={filter === 'actions'} onClick={() => setFilter('actions')}>Open actions · {actionCount}</button>
        </div>
      </div>

      {error && (
        <p className="start-warn" role="alert">
          <span>Couldn’t load your meetings.</span>
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        </p>
      )}

      {meetings === undefined ? (
        <div className="lib-wait"><Spinner label="Loading meetings" /></div>
      ) : meetings.length === 0 ? (
        <EmptyState title="No meetings yet" body="Meetings you record will be saved here." />
      ) : groups.length === 0 ? (
        <EmptyState title="No matches" body="Try a different word, or clear the search." />
      ) : (
        <section className="lib-list" aria-label="Meetings">
          {groups.map((g) => (
            <div className="lib-group" key={g.label}>
              <h2>{g.label}</h2>
              {g.meetings.map((m) => {
                const n = openActions(m);
                const live = m.status === 'recording' || m.status === 'processing';
                return (
                  <div className="lib-card" key={m.id}>
                    <button type="button" className="lib-open" onClick={() => open(m)}>
                      <span className="lib-row">
                        <span className="lib-title">{m.title || 'Untitled meeting'}</span>
                        <span className="lib-date">{dateLabel(m.startedAt)}</span>
                      </span>
                      {m.summary?.overview && <span className="lib-sum">{m.summary.overview}</span>}
                      <span className="lib-pills">
                        {m.status === 'recording' && <span className="pill pill-live">Recording</span>}
                        {m.status === 'processing' && <span className="pill pill-live">Processing</span>}
                        {m.status === 'error' && <span className="pill pill-warn">Needs attention</span>}
                        {m.summary && (n > 0
                          ? <span className="pill pill-warn">{n} open {n === 1 ? 'action' : 'actions'}</span>
                          : <span className="pill pill-ok">All done</span>)}
                        {!live && m.endedAt !== undefined && <span className="pill">{formatDuration(m.endedAt - m.startedAt)}</span>}
                      </span>
                    </button>
                    {!live && (confirming === m.id ? (
                      <div className="lib-confirm" role="alertdialog" aria-label={`Delete ${m.title || 'Untitled meeting'}`}>
                        <span>Delete this meeting for good?</span>
                        <Button variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
                        <Button onClick={() => void remove(m.id)}>Delete</Button>
                      </div>
                    ) : (
                      <button type="button" className="icon-btn lib-del" aria-label={`Delete ${m.title || 'Untitled meeting'}`} onClick={() => setConfirming(m.id)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" /></svg>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      )}
      <ComingUp />
    </main>
  );
}
