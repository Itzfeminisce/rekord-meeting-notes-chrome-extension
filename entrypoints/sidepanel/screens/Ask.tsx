import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Spinner } from '../components';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { useRouter } from '../router';
import { ask, CITATION_TOLERANCE_MS, markUnfinished, parseCitations, QUICK_PROMPTS, saveAnswerAsNote } from '@/lib/ask';
import { getMeeting, listAsks } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { formatClock } from '@/lib/time';
import type { AskTurn } from '@/lib/types';

const CITE = /\[\d{1,3}:\d{2}(?::\d{2})?\]/g;

const chip: CSSProperties = {
  flexShrink: 0, height: 22, padding: '0 6px', border: 0, borderRadius: 6, background: '#EEF0FF', color: 'var(--accent)',
  fontFamily: "'Geist Mono', monospace", fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center',
};
const smallBtn: CSSProperties = {
  height: 32, padding: '0 12px', border: 0, borderRadius: 9, background: '#F1F1F3', font: 'inherit', fontSize: 12, fontWeight: 500, color: 'var(--ink)', cursor: 'pointer',
};
const pill: CSSProperties = { ...smallBtn, height: 30, padding: '0 10px', borderRadius: 999 };

/** Whether Ask is switched on in Settings (undefined while loading). */
export function useAskEnabled(): boolean | undefined {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    getSettings().then((s) => alive && setOn(s.features.ask)).catch(() => alive && setOn(true));
    return () => { alive = false; };
  }, []);
  return on;
}

function Answer({ turn, nowMs, onOpen, onRetry }: { turn: AskTurn; nowMs: number; onOpen: (atMs: number) => void; onRetry: () => void }) {
  const [saved, setSaved] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [copied, setCopied] = useState(false);
  const maxMs = nowMs > 0 ? nowMs + CITATION_TOLERANCE_MS : undefined;
  const pending = turn.answer === undefined && !turn.error;
  const lines = (turn.answer ?? '').split('\n').filter((l) => l.trim());

  async function copy() {
    try { await navigator.clipboard.writeText(turn.answer ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }
  async function save() {
    try { await saveAnswerAsNote(turn, nowMs, maxMs); setSaved('saved'); } catch { setSaved('failed'); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 16, background: '#fff', border: '1px solid var(--line)', boxShadow: '0 1px 2px rgba(16,16,20,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>Rekord
      </div>
      {pending && <Spinner label="Thinking" />}
      {turn.error && (
        <>
          <p role="alert" style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{turn.error}</p>
          <div style={{ display: 'flex', gap: 6 }}><button type="button" style={smallBtn} onClick={onRetry}>Retry</button></div>
        </>
      )}
      {lines.map((line, i) => {
        const cites = parseCitations(line, maxMs);
        const text = line.replace(CITE, '').replace(/\s+([.,;:])/g, '$1').trim();
        return (
          <div key={i} style={{ display: 'flex', gap: 8, fontSize: 14, lineHeight: 1.5 }}>
            <span style={{ flexGrow: 1, whiteSpace: 'pre-wrap' }}>{text}</span>
            {cites.map((ms) => (
              <button type="button" key={ms} style={chip} aria-label={`Open transcript at ${formatClock(ms)}`} onClick={() => onOpen(ms)}>{formatClock(ms)}</button>
            ))}
          </div>
        );
      })}
      {turn.answer !== undefined && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" style={smallBtn} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" style={smallBtn} disabled={saved === 'saved'} onClick={() => void save()}>{saved === 'saved' ? 'Saved' : 'Save to notes'}</button>
          {saved === 'failed' && <span role="alert" style={{ fontSize: 12, color: 'var(--muted)' }}>Couldn’t save. Try again.</span>}
        </div>
      )}
    </div>
  );
}

/** The conversation + composer. Renders a scroll area and a footer; the parent supplies a flex-column container. */
export function AskPanel({ meetingId, nowMs, onOpenMoment }: { meetingId: string; nowMs: number; onOpenMoment: (atMs: number) => void }) {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const scroller = useRef<HTMLElement>(null);

  const runningId = useRef<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    listAsks(meetingId).then((t) => alive && setTurns((cur) => {
      const running = cur.find((x) => x.id === runningId.current);
      return markUnfinished(t, runningId.current).map((x) => (running && x.id === running.id ? running : x));
    })).catch(() => alive && setLoadFailed(true));
    return () => { alive = false; };
  }, [meetingId]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const run = useCallback(async (question: string, turnId?: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    const placeholder: AskTurn = { id: turnId ?? `pending-${Date.now()}`, meetingId, createdAt: Date.now(), question: q };
    runningId.current = placeholder.id;
    setTurns((t) => (turnId ? t.map((x) => (x.id === turnId ? placeholder : x)) : [...t, placeholder]));
    const done = await ask(meetingId, q, { turnId });
    setTurns((t) => t.map((x) => (x.id === placeholder.id ? done : x)));
    runningId.current = undefined;
    setBusy(false);
  }, [meetingId, busy]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = draft;
    setDraft('');
    void run(q);
  }

  return (
    <>
      <section ref={scroller} className="live-scroll" aria-label="Answers" aria-live="polite" tabIndex={0}>
        {loadFailed && <p className="live-empty" role="alert">Rekord couldn’t load earlier questions. You can still ask a new one.</p>}
        {!loadFailed && turns.length === 0 && <p className="live-empty">Ask anything about this meeting. Try a suggestion below.</p>}
        {turns.map((t) => (
          <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ alignSelf: 'flex-end', maxWidth: '80%', padding: '10px 14px', borderRadius: '16px 16px 4px 16px', background: 'var(--ink)', color: '#fff', fontSize: 14, lineHeight: 1.5 }}>{t.question}</div>
            <Answer turn={t} nowMs={nowMs} onOpen={onOpenMoment} onRetry={() => void run(t.question, t.id)} />
          </div>
        ))}
      </section>
      <footer className="live-foot">
        <div role="group" aria-label="Suggested questions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {QUICK_PROMPTS.map((p) => (
            <button type="button" key={p.label} style={pill} disabled={busy} onClick={() => void run(p.question)}>{p.label}</button>
          ))}
        </div>
        <form className="live-note" onSubmit={submit}>
          <label htmlFor="ask" className="sr-only">Ask about this meeting</label>
          <input id="ask" type="text" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask about this meeting" autoComplete="off" />
          <button type="submit" aria-label="Send" disabled={busy || !draft.trim()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        </form>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Answers come from this meeting’s transcript and notes.</span>
      </footer>
    </>
  );
}

/** Full-screen Ask, used after a meeting (Summary → Ask about it). */
export default function Ask() {
  const { route, replace, back, navigate } = useRouter();
  const meetingId = route.params.meetingId;
  const enabled = useAskEnabled();
  const [title, setTitle] = useState('');
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    if (!meetingId) return;
    getMeeting(meetingId).then((m) => {
      setTitle(m?.title ?? '');
      if (m?.endedAt) setDurationMs(m.endedAt - m.startedAt);
    }).catch(() => {});
  }, [meetingId]);

  useEffect(() => { if (enabled === false || (enabled !== undefined && !meetingId)) replace('start'); }, [enabled, meetingId, replace]);

  if (!meetingId || enabled === undefined) return <main className="screen screen-center"><Spinner label="Loading" /></main>;
  return (
    <main className="screen live">
      <header className="sum-top">
        <button type="button" className="perm-back" aria-label="Back" onClick={back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <span className="live-title">{title || 'Ask'}</span>
      </header>
      <ConnectionBanner />
      <AskPanel meetingId={meetingId} nowMs={durationMs} onOpenMoment={(atMs) => navigate('transcript', { meetingId, atMs })} />
    </main>
  );
}
