import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Spinner, Tag } from '../components';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { LevelMeter } from '../components/LevelMeter';
import { Timeline } from '../components/Timeline';
import { useRouter } from '../router';
import { AskPanel, useAskEnabled } from './Ask';
import { SuggestionCard } from '../components/SuggestionCard';
import { getMeeting, pendingChunks, listMarkers, listNotes, listSegments, putMarker, putNote } from '@/lib/db';
import { buildTimeline, elapsedMs, waitingSpan, mergeSegment, nearBottom, newMarker, newNote } from '@/lib/live';
import { useConnection } from '@/lib/connection';
import { onMessage, send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';
import { resolveSuggestion, startSuggester, suggestionCounts } from '@/lib/suggest';
import { formatClock } from '@/lib/time';
import type { Marker, MarkerKind, Note, RecordingState, Segment } from '@/lib/types';

type Active = Exclude<RecordingState, { status: 'idle' }>;
const MARKERS: { kind: MarkerKind; label: string }[] = [
  { kind: 'decision', label: 'Decision' },
  { kind: 'action', label: 'Action' },
  { kind: 'question', label: 'Question' },
];

export default function Live() {
  const { route, replace, navigate } = useRouter();
  const askOn = useAskEnabled() !== false;
  const conn = useConnection();
  const connOk = useRef(true);
  connOk.current = conn.ok;
  const [sugOn, setSugOn] = useState(false);
  const [rec, setRec] = useState<RecordingState | undefined>(undefined);
  const meetingId = route.params.meetingId ?? (rec && rec.status !== 'idle' ? rec.meetingId : undefined);
  const [title, setTitle] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [waiting, setWaiting] = useState<{ from: number; to: number } | null>(null);
  const [view, setView] = useState<'transcript' | 'notes' | 'ask'>('transcript');
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const scroller = useRef<HTMLElement>(null);
  const follow = useRef(true);

  // Live state: ask once, then follow broadcasts.
  useEffect(() => {
    let alive = true;
    const off = onMessage((msg) => {
      if (msg.type === 'recording/state') setRec(msg.state);
      else if (msg.type === 'segment/added') {
        setSegments((s) => (meetingId && msg.segment.meetingId !== meetingId ? s : mergeSegment(s, msg.segment)));
      }
      return undefined;
    });
    send<RecordingState>({ type: 'recording/get-state' }).then((s) => {
      if (alive) setRec(s ?? { status: 'idle' });
    });
    return () => { alive = false; off(); };
  }, [meetingId]);

  // Initial load from the db (covers a panel reopened mid-meeting).
  useEffect(() => {
    if (!meetingId) return;
    let alive = true;
    Promise.all([getMeeting(meetingId), listSegments(meetingId), listNotes(meetingId), listMarkers(meetingId)])
      .then(([m, s, n, k]) => {
        if (!alive) return;
        setTitle(m?.title ?? '');
        setSegments((cur) => s.reduce(mergeSegment, cur));
        setNotes(n);
        setMarkers(k);
      })
      .catch(() => alive && setLoadFailed(true));
    return () => { alive = false; };
  }, [meetingId]);

  // While transcription is paused, show the span of audio saved but not yet transcribed.
  useEffect(() => {
    if (!meetingId || conn.ok) { setWaiting(null); return; }
    let alive = true;
    const load = () => pendingChunks(meetingId).then((c) => alive && setWaiting(waitingSpan(c))).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [meetingId, conn.ok]);

  useEffect(() => {
    let alive = true;
    getSettings().then((s) => alive && setSugOn(s.features.liveSuggestions)).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Every minute, look for action items while the recording is live.
  const recording = rec !== undefined && rec.status === 'recording';
  useEffect(() => {
    if (!meetingId || !sugOn || !recording) return;
    return startSuggester({
      meetingId,
      isOk: () => connOk.current,
      onNew: (made) => setMarkers((l) => [...l, ...made]),
    });
  }, [meetingId, sugOn, recording]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Recording ended elsewhere (or nothing is recording): leave this screen.
  useEffect(() => {
    if (rec?.status === 'idle' && !stopping) {
      if (meetingId) replace('processing', { meetingId });
      else replace('start');
    }
  }, [rec, stopping, meetingId, replace]);

  const hidden = (m: Marker) => m.source === 'ai' && m.status === 'dismissed';
  const shown = markers.filter((m) => !hidden(m) && (m.source !== 'ai' || m.status !== 'suggested' || sugOn));
  const timeline = buildTimeline(segments, notes, shown);
  const counts = suggestionCounts(markers);
  useEffect(() => {
    const el = scroller.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [timeline.length, view]);

  const active: Active | undefined = rec && rec.status !== 'idle' ? rec : undefined;
  const ms = active ? elapsedMs(active.startedAt, now) : 0;

  const addNote = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!meetingId || !active) return;
    const n = newNote(meetingId, elapsedMs(active.startedAt), draft);
    if (!n) return;
    setNotes((l) => [...l, n]);
    setDraft('');
    try { await putNote(n); setSaveFailed(false); } catch { setSaveFailed(true); }
  }, [meetingId, active, draft]);

  async function mark(kind: MarkerKind) {
    if (!meetingId || !active) return;
    const m = newMarker(meetingId, elapsedMs(active.startedAt), kind);
    setMarkers((l) => [...l, m]);
    try { await putMarker(m); setSaveFailed(false); } catch { setSaveFailed(true); }
  }

  async function decide(m: Marker, status: 'accepted' | 'dismissed', edits: { label?: string } = {}) {
    setMarkers((l) => l.map((x) => (x.id === m.id ? { ...x, ...edits, status } : x)));
    try { await resolveSuggestion(m, status, edits); setSaveFailed(false); } catch { setSaveFailed(true); }
  }

  async function stop() {
    if (!meetingId || stopping) return;
    setStopping(true);
    setStopFailed(false);
    const reply = await send<{ ok?: boolean }>({ type: 'recording/stop' });
    if (reply === undefined || reply.ok !== false) replace('processing', { meetingId });
    else { setStopping(false); setStopFailed(true); }
  }

  if (rec === undefined) {
    return <main className="screen screen-center"><Spinner label="Loading" /></main>;
  }

  return (
    <main className="screen live">
      <div className="live-bar-wrap">
        <div className="live-bar">
          <span className="rec-dot" aria-hidden="true" />
          <div className="live-bar-text">
            <span className="live-title">{title || 'Untitled meeting'}</span>
            <span className="live-clock" role="timer" aria-label={`Recording, ${formatClock(ms)} elapsed`}>
              {active?.status === 'starting' ? 'Starting' : active?.status === 'stopping' ? 'Stopping' : 'Recording'} · {formatClock(ms)}
            </span>
          </div>
          {active && (
            <div className="live-meters">
              {!active.micUnavailable && active.sources?.mic !== false && <LevelMeter level={active.micLevel} label="Your microphone level" />}
              {active.sources?.tab !== false && <LevelMeter level={active.tabLevel} label="Meeting audio level" />}
            </div>
          )}
          <button type="button" className="live-end" onClick={stop} disabled={stopping}>{stopping ? 'Ending…' : 'End'}</button>
        </div>
      </div>

      <ConnectionBanner />

      {stopFailed && <p className="live-msg" role="alert">Rekord couldn’t end the recording. Try End again.</p>}
      {saveFailed && <p className="live-msg" role="alert">Rekord couldn’t save your last note or marker. Try again.</p>}
      {active?.micUnavailable && <p className="live-msg" role="status">Your microphone isn’t available, so only the meeting audio is being recorded.</p>}

      <nav aria-label="View" className="live-tabs" style={askOn ? { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } : undefined}>
        <button type="button" aria-pressed={view === 'transcript'} onClick={() => setView('transcript')}>Transcript</button>
        <button type="button" aria-pressed={view === 'notes'} onClick={() => setView('notes')}>Notes · {notes.length}</button>
        {askOn && <button type="button" aria-pressed={view === 'ask'} onClick={() => setView('ask')}>Ask</button>}
      </nav>

      {view === 'ask' && askOn && meetingId ? (
        <AskPanel meetingId={meetingId} nowMs={ms} onOpenMoment={(atMs) => navigate('transcript', { meetingId, atMs })} />
      ) : (<>
      <section
        ref={scroller}
        className="live-scroll"
        aria-label={view === 'transcript' ? 'Transcript' : 'Notes'}
        aria-live="polite"
        tabIndex={0}
        onScroll={(e) => { follow.current = nearBottom(e.currentTarget); }}
      >
        {loadFailed ? (
          <p className="live-empty" role="alert">Rekord couldn’t load this meeting. Try reopening the side panel.</p>
        ) : view === 'transcript' ? (
          timeline.length === 0 && !waiting ? (
            <p className="live-empty">Listening… Words appear here about 10 s behind the conversation.</p>
          ) : (
            <>
              {timeline.map((it) =>
                it.kind === 'marker' && it.marker.source === 'ai' && it.marker.status === 'suggested' ? (
                  <SuggestionCard
                    key={it.id}
                    marker={it.marker}
                    onAccept={(e) => decide(it.marker, 'accepted', e)}
                    onDismiss={() => decide(it.marker, 'dismissed')}
                  />
                ) : <Timeline key={it.id} items={[it]} />,
              )}
              {waiting && (
                <div className="tl-waiting">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  <span className="tl-waiting-text">{formatClock(waiting.from)} – {formatClock(waiting.to)} waiting to transcribe</span>
                  <span className="tl-waiting-saved">saved</span>
                </div>
              )}
              <p className="hint">about 10 s behind</p>
            </>
          )
        ) : notes.length === 0 && markers.length === 0 ? (
          <p className="live-empty">No notes yet. Type one below and press Enter.</p>
        ) : (
          buildTimeline([], notes, shown.filter((m) => m.status !== 'suggested')).map((it) =>
            it.kind === 'note' ? (
              <div className="tl-inline tl-note" key={it.id}>
                <span className="tl-meta">Note · {formatClock(it.atMs)}</span>
                <span className="tl-text">{it.note.text}</span>
              </div>
            ) : it.kind === 'marker' ? (
              <div className="tl-inline" key={it.id}>
                <Tag kind={it.marker.kind} />
                <span className="tl-meta">{formatClock(it.atMs)}</span>
              </div>
            ) : null,
          )
        )}
      </section>

      <footer className="live-foot">
        {sugOn && (
          <div className="live-sug">
            <span>
              {counts.added} {counts.added === 1 ? 'action' : 'actions'} added · {counts.waiting} {counts.waiting === 1 ? 'suggestion' : 'suggestions'} waiting
            </span>
            <button type="button" className="live-sug-link" onClick={() => navigate('settings')}>Suggestions on</button>
          </div>
        )}
        <div role="group" aria-label="Mark this moment" className="live-markers">
          {MARKERS.map((m) => (
            <button type="button" key={m.kind} onClick={() => mark(m.kind)} disabled={!active}>{m.label}</button>
          ))}
          <button type="button" className="round" aria-label="Bookmark this moment" onClick={() => mark('bookmark')} disabled={!active}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" /></svg>
          </button>
        </div>
        <form className="live-note" onSubmit={addNote}>
          <label htmlFor="note" className="sr-only">Add a note</label>
          <input id="note" type="text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={conn.ok ? `Add a note at ${formatClock(ms)}` : 'Notes still work while offline'} autoComplete="off" />
          <button type="submit" aria-label="Save note" disabled={!active || !draft.trim()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        </form>
      </footer>
      </>)}
    </main>
  );
}
