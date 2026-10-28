import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Spinner, Tag } from '../components';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { LevelMeter } from '../components/LevelMeter';
import { Timeline } from '../components/Timeline';
import { useRouter } from '../router';
import { AskPanel, useAskEnabled } from './Ask';
import { SuggestionCard } from '../components/SuggestionCard';
import { AppAudioWatch } from './NoSound';
import { appLabel } from '@/lib/audio/appAudio';
import { displayName } from '@/lib/llm';
import { LIVE_CHUNK_ID, liveSpeakerCount, supersede, type StreamRequest, type StreamState } from '@/lib/transcribe/stream';
import { getMeeting, pendingChunks, listMarkers, listNotes, listSegments, putMarker, putNote } from '@/lib/db';
import { buildTimeline, elapsedMs, waitingSpan, mergeSegment, nearBottom, newMarker, newNote } from '@/lib/live';
import { useConnection } from '@/lib/connection';
import { onMessage, send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';
import { resolveSuggestion, startSuggester, suggestionCounts } from '@/lib/suggest';
import { formatClock } from '@/lib/time';
import type { Marker, MarkerKind, Meeting, Note, RecordingState, Segment, Speaker } from '@/lib/types';

type Active = Exclude<RecordingState, { status: 'idle' }>;
const MARKERS: { kind: MarkerKind; label: string }[] = [
  { kind: 'decision', label: 'Decision' },
  { kind: 'action', label: 'Action' },
  { kind: 'question', label: 'Question' },
];

/** One transcript line, named "You", the matched name or "Speaker A" (v2 chunks: "Others"); interim: greyed with a caret. */
function Line({ segment, speakers, now }: { segment: Segment; speakers?: Meeting['speakers']; now?: boolean }) {
  const you = segment.speaker === 'you';
  const name = displayName(segment, speakers);
  const initial = !you && segment.speakerLabel && name === `Speaker ${segment.speakerLabel}` ? segment.speakerLabel[0] : name[0];
  return (
    <div className="tl-row">
      <span className={`tl-avatar ${you ? 'you' : 'others'}`} aria-hidden="true">{initial?.toUpperCase()}</span>
      <div className="tl-body">
        <span className="tl-meta"><strong>{name}</strong> · {now ? 'now' : formatClock(segment.startMs)}</span>
        <span className={`tl-text${segment.interim ? ' rt-interim' : ''}`}>
          {segment.text}{segment.interim && <span className="rt-caret" aria-hidden="true" />}
        </span>
      </div>
    </div>
  );
}

/** V3States "Live · real time stopped, backup on". */
function BackupBanner() {
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" className="rt-banner">
      <div className="rt-banner-text">
        <span className="rt-banner-title">Switched to Groq</span>
        <span>Real-time transcription stopped, so text will appear a few seconds later. Nothing was missed.</span>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void send({ type: 'transcription/catch-up' });
          setTimeout(() => setBusy(false), 3000);
        }}
      >Try real time again</button>
    </div>
  );
}

const RT_CSS = `
.rt-status { margin: 10px 16px 0; display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: #5f6168; }
.rt-status-on { display: flex; align-items: center; gap: 6px; }
.rt-dot { width: 7px; height: 7px; border-radius: 50%; background: #1a7f4b; }
.rt-interim { color: var(--faint); }
.rt-caret { display: inline-block; width: 2px; height: 15px; margin-left: 2px; vertical-align: -2px; background: var(--accent); animation: rt-blink 1s steps(1) infinite; }
@keyframes rt-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .rt-caret { animation: none; } }
.rt-banner { margin: 12px 12px 0; padding: 12px 14px; border-radius: 14px; background: #fff8ec; border: 1px solid #f5ddb0; display: flex; flex-direction: column; gap: 10px; }
.rt-banner-text { display: flex; flex-direction: column; gap: 3px; font-size: 13px; line-height: 1.45; color: #6b3d00; }
.rt-banner-title { font-size: 14px; font-weight: 600; color: #5c3200; }
.rt-banner button { align-self: flex-start; height: 32px; padding: 0 12px; border: none; border-radius: 9px; background: var(--ink); color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.rt-banner button:disabled { opacity: 0.6; }
.rt-banner button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

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
  const [meeting, setMeeting] = useState<Meeting | undefined>(undefined);
  const [stream, setStream] = useState<StreamState>('off');
  const [interim, setInterim] = useState<Partial<Record<Speaker, Segment>>>({});
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
      else if (msg.type === 'stream/state') setStream(msg.state);
      else if (msg.type === 'segment/added') {
        const seg = msg.segment;
        if (meetingId && seg.meetingId !== meetingId) return undefined;
        if (seg.interim) {
          setInterim((cur) => ({ ...cur, [seg.speaker]: seg.text.trim() ? seg : undefined }));
          return undefined;
        }
        if (seg.chunkId === LIVE_CHUNK_ID) setInterim((cur) => ({ ...cur, [seg.speaker]: undefined }));
        // A Groq backup chunk replaces the streamed lines it covers, so nothing shows twice.
        setSegments((s) => mergeSegment(supersede(s, seg), seg));
      }
      return undefined;
    });
    const ask: StreamRequest = { type: 'stream/get-state' };
    browser.runtime.sendMessage(ask).then((s: unknown) => {
      if (alive && (s === 'live' || s === 'backup' || s === 'off')) setStream(s);
    }, () => undefined);
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
        setMeeting(m);
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

  // Names matched while recording (calendar, T9) are saved on the meeting: reload it when a new live label appears.
  const labels = [...new Set(segments.map((s) => s.speakerLabel).filter(Boolean))].join(',');
  useEffect(() => {
    if (!meetingId || !labels) return;
    let alive = true;
    getMeeting(meetingId).then((m) => alive && m && setMeeting(m), () => undefined);
    return () => { alive = false; };
  }, [meetingId, labels]);

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
  const live = stream === 'live';
  const talking = liveSpeakerCount(segments);
  const app = meeting?.source === 'app' ? appLabel(meeting.event) : undefined;
  const interimLines = (['others', 'you'] as const).map((k) => interim[k]).filter((s): s is Segment => !!s);

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
      <style>{RT_CSS}</style>
      <div className="live-bar-wrap">
        <div className="live-bar">
          <span className="rec-dot" aria-hidden="true" />
          <div className="live-bar-text">
            <span className="live-title">{title || 'Untitled meeting'}</span>
            <span className="live-clock" role="timer" aria-label={`Recording, ${formatClock(ms)} elapsed`}>
              {active?.status === 'starting' ? 'Starting' : active?.status === 'stopping' ? 'Stopping' : 'Recording'} · {formatClock(ms)}{app && ` · ${app}`}
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
      {stream === 'backup' && <BackupBanner />}
      <AppAudioWatch meetingId={meetingId} />

      {stopFailed && <p className="live-msg" role="alert">Rekord couldn’t end the recording. Try End again.</p>}
      {saveFailed && <p className="live-msg" role="alert">Rekord couldn’t save your last note or marker. Try again.</p>}
      {active?.micUnavailable && <p className="live-msg" role="status">Your microphone isn’t available, so only the meeting audio is being recorded.</p>}

      <nav aria-label="View" className="live-tabs" style={askOn ? { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } : undefined}>
        <button type="button" aria-pressed={view === 'transcript'} onClick={() => setView('transcript')}>Transcript</button>
        <button type="button" aria-pressed={view === 'notes'} onClick={() => setView('notes')}>Notes · {notes.length}</button>
        {askOn && <button type="button" aria-pressed={view === 'ask'} onClick={() => setView('ask')}>Ask</button>}
      </nav>

      {live && view === 'transcript' && (
        <div className="rt-status">
          <span className="rt-status-on"><span className="rt-dot" aria-hidden="true" />Transcribing as people speak</span>
          {talking > 0 && <span>{talking} {talking === 1 ? 'person' : 'people'} talking</span>}
        </div>
      )}

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
          timeline.length === 0 && !waiting && !interimLines.length ? (
            <p className="live-empty">{live ? 'Listening…' : 'Listening… Words appear here about 10 s behind the conversation.'}</p>
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
                ) : it.kind === 'segment' ? (
                  <Line key={it.id} segment={it.segment} speakers={meeting?.speakers} />
                ) : <Timeline key={it.id} items={[it]} />,
              )}
              {interimLines.map((seg) => <Line key={seg.id} segment={seg} speakers={meeting?.speakers} now />)}
              {waiting && (
                <div className="tl-waiting">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  <span className="tl-waiting-text">{formatClock(waiting.from)} – {formatClock(waiting.to)} waiting to transcribe</span>
                  <span className="tl-waiting-saved">saved</span>
                </div>
              )}
              {!live && <p className="hint">about 10 s behind</p>}
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
