import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components';
import { useRouter } from '../router';
import { getMeeting, listNotes, listSegments, pendingChunks } from '@/lib/db';
import { CONNECTION_LOST, useConnection } from '@/lib/connection';
import { onMessage, send } from '@/lib/messages';
import { summarize } from '@/lib/summarize';
import { runSpeakerStep } from '@/lib/speakers';

type Phase = 'transcribing' | 'summarizing' | 'speakers' | 'failed' | 'missing';

function minutesText(ms: number): string {
  const n = ms > 0 ? Math.max(1, Math.round(ms / 60000)) : 0;
  return `${n} ${n === 1 ? 'minute' : 'minutes'}`;
}

function Step({ state, children, note }: { state: 'done' | 'active' | 'todo'; children: ReactNode; note?: string }) {
  return (
    <li className={`proc-step proc-${state}`}>
      <span className="proc-dot" aria-hidden="true">
        {state === 'done' && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
        )}
      </span>
      <span className="proc-label">{children}</span>
      {note && <span className="proc-note">{note}</span>}
    </li>
  );
}

export default function Processing() {
  const { route, replace, navigate } = useRouter();
  const meetingId = route.params.meetingId;
  const [phase, setPhase] = useState<Phase>('transcribing');
  const [pending, setPending] = useState<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [facts, setFacts] = useState<{ ms: number; notes: number } | undefined>(undefined);
  const started = useRef(false);
  const failed = useRef(false);
  const drained = useRef(false);
  const conn = useConnection();
  const [lostSeen, setLostSeen] = useState(false);
  const speakersStarted = useRef(false);
  const [found, setFound] = useState<{ decisions: number; actions: number } | undefined>(undefined);

  // After the summary: tell voices apart when the meeting has a recording. Never fails the summary.
  const finish = useCallback(async () => {
    if (!meetingId || speakersStarted.current) return;
    speakersStarted.current = true;
    let pendingStep = false;
    try { pendingStep = (await getMeeting(meetingId))?.speakerStep === 'pending'; } catch { /* go to Summary */ }
    if (pendingStep) {
      setPhase('speakers');
      if ((await runSpeakerStep(meetingId)) === 'ready') { replace('speakers', { meetingId }); return; }
    }
    replace('summary', { meetingId });
  }, [meetingId, replace]);

  const run = useCallback(async (manual = false) => {
    if (!meetingId || started.current) return;
    if (failed.current && !manual) return; // after a failure only Retry re-runs
    failed.current = false;
    started.current = true;
    setError('');
    setPhase('summarizing');
    try {
      const m = await summarize(meetingId);
      if (m.summary) setFound({ decisions: m.summary.decisions.length, actions: m.summary.actions.length });
    } catch (e) {
      started.current = false;
      failed.current = true;
      setError(e instanceof Error ? e.message : 'Something went wrong while writing the summary.');
      setPhase('failed');
      return;
    }
    await finish();
  }, [meetingId, finish]);

  useEffect(() => {
    if (!meetingId) { setPhase('missing'); return; }
    let alive = true;
    const refresh = async () => {
      try {
        const [m, chunks, segs, notes] = await Promise.all([getMeeting(meetingId), pendingChunks(meetingId), listSegments(meetingId), listNotes(meetingId)]);
        if (!alive) return;
        if (!m) { setPhase('missing'); return; }
        if (m.status === 'done' && m.summary) {
          if (m.speakerStep === 'pending' || speakersStarted.current) {
            setFound({ decisions: m.summary.decisions.length, actions: m.summary.actions.length });
            void finish();
          }
          else replace('summary', { meetingId });
          return;
        }
        const last = segs.reduce((mx, s) => Math.max(mx, s.endMs), 0);
        setFacts({ ms: m.endedAt ? m.endedAt - m.startedAt : last, notes: notes.length });
        setPending(chunks.length);
        if (chunks.length === 0 && m.status !== 'recording') void run();
      } catch {
        if (alive) setPending(undefined);
      }
    };
    void refresh();
    void send({ type: 'transcription/catch-up' });
    const off = onMessage((msg) => {
      if (msg.type === 'transcription/drained' && msg.meetingId === meetingId) { drained.current = true; void run(); }
      else if (msg.type === 'segment/added' && msg.segment.meetingId === meetingId) void refresh();
      return undefined;
    });
    const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [meetingId, replace, run, finish]);

  useEffect(() => { if (!conn.ok) setLostSeen(true); }, [conn]);
  useEffect(() => {
    if (meetingId && lostSeen && phase === 'transcribing' && (pending ?? 0) > 0 && !drained.current) {
      replace('error', { message: CONNECTION_LOST, meetingId });
    }
  }, [lostSeen, pending, phase, meetingId, replace]);

  const speakers = phase === 'speakers';
  const summarizing = phase === 'summarizing' || speakers;
  const waiting = phase === 'transcribing' && (pending ?? 0) > 0;

  return (
    <main className="screen proc">
      <div className="proc-body">
        <div className="proc-mark" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#C7C4FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>
        </div>
        <div className="proc-head" role="status" aria-live="polite">
          <h1>{phase === 'failed' ? 'The summary did not finish' : phase === 'missing' ? 'Meeting not found' : 'Writing your summary'}</h1>
          {phase === 'failed' ? (
            <p>{error} Your transcript is saved.</p>
          ) : phase === 'missing' ? (
            <p>This meeting is no longer on this computer.</p>
          ) : (
            <p>
              {facts ? `${minutesText(facts.ms)} of conversation and ${facts.notes} of your ${facts.notes === 1 ? 'note' : 'notes'}. ` : ''}
              This usually takes under a minute.
            </p>
          )}
        </div>

        {(phase === 'transcribing' || summarizing) && (
          <ol className="proc-steps" aria-label="Progress">
            <Step state={summarizing ? 'done' : 'active'} note={summarizing ? 'done' : waiting ? `${pending} left` : undefined}>Final transcript</Step>
            <Step state={speakers ? 'done' : 'todo'} note={speakers && found ? `${found.decisions} found` : undefined}>Decisions</Step>
            <Step state={speakers ? 'done' : 'todo'} note={speakers && found ? `${found.actions} found` : undefined}>Action items and owners</Step>
            <Step state={speakers ? 'done' : summarizing ? 'active' : 'todo'} note={speakers ? 'done' : undefined}>Summary</Step>
            {speakers && <Step state="active">Telling voices apart</Step>}
          </ol>
        )}
      </div>
      <div className="proc-foot">
        {phase === 'failed' && <Button block onClick={() => void run(true)}>Retry</Button>}
        {waiting && (
          <Button block variant="secondary" onClick={() => void run(true)}>Summarize what exists</Button>
        )}
        {phase === 'missing' ? (
          <Button block variant="secondary" onClick={() => replace('start')}>Back to home</Button>
        ) : (
          <Button block variant="secondary" onClick={() => navigate('transcript', { meetingId })}>Read the transcript meanwhile</Button>
        )}
        <span className="hint">
          {waiting ? 'Some audio is still waiting to be transcribed, maybe because you are offline.' : 'You can close the panel. Rekord finishes in the background.'}
        </span>
      </div>
    </main>
  );
}
