import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { askAll, askAllSession, citationClock, nothingFoundText, RANGES, SUGGESTIONS, type AskAllResult, type Range } from '@/lib/askAll';
import { listMeetings } from '@/lib/db';
import { dateLabel } from '@/lib/library';
import type { Meeting } from '@/lib/types';
import { Spinner } from '../components';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { useRouter } from '../router';

const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 16, background: '#fff', border: '1px solid var(--line)', boxShadow: '0 1px 2px rgba(16,16,20,0.04)' };
const smallBtn: CSSProperties = { height: 32, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 9, background: '#fff', font: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--ink)', cursor: 'pointer' };
const pill: CSSProperties = { height: 30, padding: '0 10px', border: 0, borderRadius: 999, background: '#F1F1F3', font: 'inherit', fontSize: 12, fontWeight: 500, color: 'var(--ink)', cursor: 'pointer' };
const sourceRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 0, borderRadius: 10, background: '#F6F6F7', font: 'inherit', color: 'var(--ink)', textAlign: 'left', cursor: 'pointer' };
const chip: CSSProperties = { height: 22, padding: '0 6px', borderRadius: 6, background: '#EEF0FF', color: 'var(--accent)', fontFamily: "'Geist Mono', monospace", fontSize: 11, display: 'flex', alignItems: 'center' };

const sparkle = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>
);

function Answer({ turn, pending, onOpen, onRetry, onAllTime }: {
  turn: AskAllResult | undefined; pending: boolean;
  onOpen: (meetingId: string, atMs: number) => void; onRetry: () => void; onAllTime: () => void;
}) {
  if (pending || !turn) return <div style={card}><Spinner label="Thinking" /></div>;
  if (turn.status === 'error') {
    return (
      <div style={card}>
        <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{turn.error}</p>
        <div style={{ display: 'flex', gap: 6 }}><button type="button" style={smallBtn} onClick={onRetry}>Retry</button></div>
      </div>
    );
  }
  if (turn.status === 'none') {
    return (
      <div style={{ ...card, gap: 10 }}>
        <span style={{ fontSize: 14, lineHeight: 1.5 }}>{nothingFoundText(turn.range)}</span>
        {turn.range !== 'all' && <button type="button" style={{ ...smallBtn, alignSelf: 'flex-start' }} onClick={onAllTime}>Search all time</button>}
      </div>
    );
  }
  const sources = turn.sources ?? [];
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
        {sparkle}{sources.length > 0 ? `Found in ${sources.length} ${sources.length === 1 ? 'meeting' : 'meetings'}` : 'Rekord'}
      </div>
      {(turn.answer ?? '').split('\n').filter((l) => l.trim()).map((line, i) => (
        <p key={i} style={{ margin: 0, fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{line}</p>
      ))}
      {sources.length > 0 && (
        <ul aria-label="Sources" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sources.map((s) => (
            <li key={s.meetingId}>
              <button type="button" style={sourceRow} aria-label={`${s.title}, open transcript at ${citationClock(s.atMs)}`} onClick={() => onOpen(s.meetingId, s.atMs)}>
                <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 500, minWidth: 0, overflowWrap: 'anywhere' }}>{s.title}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{dateLabel(s.startedAt)}</span>
                <span style={chip}>{citationClock(s.atMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AskAll() {
  const { back, navigate } = useRouter();
  const [meetings, setMeetings] = useState<Meeting[] | undefined>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [range, setRangeState] = useState<Range>(askAllSession.range);
  const [turns, setTurns] = useState<AskAllResult[]>(askAllSession.turns);
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    listMeetings().then((l) => alive.current && setMeetings(l)).catch(() => { if (alive.current) { setLoadFailed(true); setMeetings([]); } });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, pendingQ]);

  const setRange = (r: Range) => { askAllSession.range = r; setRangeState(r); };
  const commit = (next: AskAllResult[]) => { askAllSession.turns = next; setTurns(next); };

  /** Asks `question`; `replaceAt` re-runs an earlier turn in place. */
  async function run(question: string, r: Range, replaceAt?: number) {
    const q = question.trim();
    if (!q || pendingQ !== null || !meetings) return;
    setPendingQ(q);
    const result = await askAll(q, r, meetings);
    if (!alive.current) { // left the screen mid-answer: still keep it for this panel session
      askAllSession.turns = replaceAt === undefined ? [...askAllSession.turns, result] : askAllSession.turns.map((t, i) => (i === replaceAt ? result : t));
      return;
    }
    setPendingQ(null);
    commit(replaceAt === undefined ? [...askAllSession.turns, result] : askAllSession.turns.map((t, i) => (i === replaceAt ? result : t)));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = draft;
    setDraft('');
    void run(q, range);
  }

  function suggest(s: (typeof SUGGESTIONS)[number]) {
    if (s.incomplete) { setDraft(s.question); input.current?.focus(); return; }
    void run(s.question, range);
  }

  function searchAllTime(i: number) {
    setRange('all');
    void run(turns[i]?.question ?? "", 'all', i);
  }

  const busy = pendingQ !== null;
  const total = meetings?.length ?? 0;

  return (
    <main className="screen live">
      <header className="lib-head">
        <button type="button" className="icon-btn" aria-label="Back to meetings" onClick={back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>Ask all meetings</h1>
          {meetings && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Answers from your {total} saved {total === 1 ? 'meeting' : 'meetings'}</span>}
        </div>
      </header>
      <ConnectionBanner />

      <div role="group" aria-label="Which meetings" className="lib-filters" style={{ margin: '12px 16px 0', flexWrap: 'wrap' }}>
        {RANGES.map((r) => (
          <button type="button" key={r.id} aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
        ))}
      </div>

      <section ref={scroller} className="live-scroll" aria-label="Answers" aria-live="polite" tabIndex={0}>
        {meetings === undefined && <Spinner label="Loading meetings" />}
        {loadFailed && <p className="live-empty" role="alert">Rekord couldn’t load your meetings. Close this screen and try again.</p>}
        {meetings && !loadFailed && total === 0 && <p className="live-empty">Meetings you record will be saved here. Then you can ask about all of them.</p>}
        {meetings && total > 0 && turns.length === 0 && !busy && <p className="live-empty">Ask anything about your meetings. Try a suggestion below.</p>}
        {turns.map((t, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ alignSelf: 'flex-end', maxWidth: '80%', padding: '10px 14px', borderRadius: '16px 16px 4px 16px', background: 'var(--ink)', color: '#fff', fontSize: 14, lineHeight: 1.5 }}>{t.question}</div>
            <Answer
              turn={t} pending={false}
              onOpen={(meetingId, atMs) => navigate('transcript', { meetingId, atMs })}
              onRetry={() => void run(t.question, t.range, i)}
              onAllTime={() => searchAllTime(i)}
            />
          </div>
        ))}
        {busy && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ alignSelf: 'flex-end', maxWidth: '80%', padding: '10px 14px', borderRadius: '16px 16px 4px 16px', background: 'var(--ink)', color: '#fff', fontSize: 14, lineHeight: 1.5 }}>{pendingQ}</div>
            <Answer turn={undefined} pending onOpen={() => {}} onRetry={() => {}} onAllTime={() => {}} />
          </div>
        )}
      </section>

      <footer className="live-foot">
        <div role="group" aria-label="Suggested questions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SUGGESTIONS.map((s) => (
            <button type="button" key={s.label} style={pill} disabled={busy || !meetings || total === 0} onClick={() => suggest(s)}>{s.label}</button>
          ))}
        </div>
        <form className="live-note" onSubmit={submit}>
          <label htmlFor="askall" className="sr-only">Ask about your meetings</label>
          <input ref={input} id="askall" type="text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask about your meetings" autoComplete="off" />
          <button type="submit" aria-label="Send" disabled={busy || !draft.trim() || !meetings || total === 0}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        </form>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Tap a meeting to jump to the moment it came from.</span>
      </footer>
    </main>
  );
}
