import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner, Tag } from '../components';
import { useRouter } from '../router';
import { useAskEnabled } from './Ask';
import { getMeeting, listMarkers, listNotes } from '@/lib/db';
import { normalizeDecisions, summarize } from '@/lib/summarize';
import { runSpeakerStep } from '@/lib/speakers';
import { formatClock, formatDuration } from '@/lib/time';
import { visibleMarkers } from '@/lib/suggest';
import type { Marker, Meeting, Note } from '@/lib/types';

function when(ms: number): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day} · ${t}`;
}

export default function Summary() {
  const { route, replace, navigate } = useRouter();
  const askOn = useAskEnabled();
  const meetingId = route.params.meetingId;
  const [meeting, setMeeting] = useState<Meeting | undefined>(undefined);
  const [notes, setNotes] = useState<Note[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [voices, setVoices] = useState<'idle' | 'working'>('idle');

  useEffect(() => {
    if (!meetingId) { setState('missing'); return; }
    let alive = true;
    Promise.all([getMeeting(meetingId), listNotes(meetingId), listMarkers(meetingId)])
      .then(([m, n, k]) => {
        if (!alive) return;
        setMeeting(m); setNotes(n); setMarkers(visibleMarkers(k).filter((x) => x.kind !== 'bookmark' || x.label));
        setState(m ? 'ready' : 'missing');
      })
      .catch(() => alive && setState('missing'));
    return () => { alive = false; };
  }, [meetingId]);

  const regenerate = useCallback(async () => {
    if (!meetingId) return;
    setBusy(true); setError('');
    try {
      setMeeting(await summarize(meetingId));
      setChecked(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong while writing the summary.');
      setMeeting(await getMeeting(meetingId).catch(() => undefined));
    } finally {
      setBusy(false);
    }
  }, [meetingId]);

  const retrySpeakers = useCallback(async () => {
    if (!meetingId) return;
    setVoices('working');
    const step = await runSpeakerStep(meetingId);
    if (step === 'ready') return replace('speakers', { meetingId });
    setMeeting(await getMeeting(meetingId).catch(() => undefined));
    setVoices('idle');
  }, [meetingId, replace]);

  const resumed = useRef<string | undefined>(undefined);
  useEffect(() => {
    const step = meeting?.speakerStep;
    if (!meetingId || (step !== 'pending' && step !== 'running') || resumed.current === meetingId) return;
    resumed.current = meetingId;
    void retrySpeakers();
  }, [meeting, meetingId, retrySpeakers]);

  const home = () => replace('start');
  if (state === 'loading') return <main className="screen screen-center"><Spinner label="Loading summary" /></main>;
  if (state === 'missing' || !meeting) {
    return (
      <main className="screen screen-center sum-missing">
        <h1 className="empty-title">Meeting not found</h1>
        <p className="empty-body">This meeting is no longer on this computer.</p>
        <Button variant="secondary" onClick={home}>Back to home</Button>
      </main>
    );
  }

  const s = meeting.summary;
  const decisions = normalizeDecisions(s?.decisions);
  const duration = meeting.endedAt ? formatDuration(meeting.endedAt - meeting.startedAt) : undefined;
  return (
    <main className="screen sum">
      <header className="sum-top">
        <button type="button" className="perm-back" aria-label="Back to home" onClick={home}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <span className="sum-spacer" />
        <button type="button" className="sum-share" onClick={() => navigate('export', { meetingId })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 21h14" /></svg>Share
        </button>
      </header>
      <div className="sum-title">
        <h1>{meeting.title}</h1>
        <span className="sum-meta">{[when(meeting.startedAt), duration].filter(Boolean).join(' · ')}</span>
      </div>

      <div className="sum-cards">
        {error && <p className="perm-error sum-error" role="alert">{error}</p>}
        {voices === 'working' && meeting.speakerStep !== 'failed' && (
          <p className="sum-sub" role="status">Telling voices apart…</p>
        )}
        {meeting.speakerStep === 'failed' && (
          <p className="perm-error sum-error" role="alert">
            Couldn’t tell voices apart.{' '}
            <button type="button" className="set-link" disabled={voices === 'working'} onClick={() => void retrySpeakers()}>
              {voices === 'working' ? 'Trying…' : 'Try again'}
            </button>
          </p>
        )}
        {!s ? (
          <section className="sum-card">
            <h2>Summary</h2>
            <p>There is no summary for this meeting yet. Your transcript is saved.</p>
            <Button variant="secondary" disabled={busy} onClick={() => void regenerate()}>{busy ? 'Writing…' : 'Write the summary'}</Button>
          </section>
        ) : (
          <>
            <section className="sum-dark" aria-labelledby="sum-h">
              <h2 id="sum-h">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>Summary
              </h2>
              <p>{s.overview || 'Nothing to summarize from this meeting.'}</p>
            </section>

            <section className="sum-card">
              <h2>Action items<span className="sum-count">{checked.size} of {s.actions.length}</span></h2>
              {s.actions.length === 0 && <p className="sum-empty">No action items.</p>}
              {s.actions.map((a, i) => (
                <label key={i} className="sum-action">
                  <input
                    type="checkbox"
                    checked={checked.has(i)}
                    onChange={() => setChecked((c) => { const n = new Set(c); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                  />
                  <span className="sum-action-text">
                    {a.text}
                    {a.owner || a.due ? <span className="sum-sub">{[a.owner, a.due && `due ${a.due}`].filter(Boolean).join(' · ')}</span> : <span className="sum-sub sum-warn">No owner yet</span>}
                  </span>
                </label>
              ))}
            </section>

            {decisions.length > 0 && (
              <section className="sum-card">
                <h2>Decisions</h2>
                {decisions.map((d, i) => (
                  <div key={i} className="sum-decision">
                    <span>{d.text}</span>
                    {d.atMs !== undefined && (
                      <button type="button" className="sum-chip" aria-label={`Open transcript at ${formatClock(d.atMs)}`} onClick={() => navigate('transcript', { meetingId, atMs: d.atMs })}>{formatClock(d.atMs)}</button>
                    )}
                  </div>
                ))}
              </section>
            )}
            {s.questions.length > 0 && (
              <section className="sum-card">
                <h2>Still open</h2>
                {s.questions.map((q, i) => <p key={i}>{q}</p>)}
              </section>
            )}
          </>
        )}

        {notes.length > 0 && (
          <section className="sum-card">
            <h2>Your notes</h2>
            {notes.map((n) => <p key={n.id}><span className="sum-time">{formatClock(n.atMs)}</span> {n.text}</p>)}
          </section>
        )}
        {markers.length > 0 && (
          <section className="sum-card">
            <h2>Marked moments</h2>
            {markers.map((m) => (
              <p key={m.id} className="sum-marker"><span className="sum-time">{formatClock(m.atMs)}</span><Tag kind={m.kind} />{m.label}</p>
            ))}
          </section>
        )}
        {s && (
          <Button variant="ghost" disabled={busy} onClick={() => void regenerate()}>{busy ? 'Writing…' : 'Regenerate summary'}</Button>
        )}
      </div>

      <footer className="sum-foot">
        {askOn && <Button block variant="secondary" onClick={() => navigate('ask', { meetingId })}>Ask about it</Button>}
        <Button block variant="secondary" onClick={() => navigate('transcript', { meetingId })}>Transcript</Button>
        <Button block onClick={home}>New meeting</Button>
      </footer>
    </main>
  );
}
