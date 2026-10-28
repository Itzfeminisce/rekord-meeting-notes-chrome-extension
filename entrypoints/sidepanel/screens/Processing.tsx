import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components';
import { useRouter } from '../router';
import { getMeeting, listNotes, listSegments, pendingChunks } from '@/lib/db';
import { onMessage, send } from '@/lib/messages';
import { summarize } from '@/lib/summarize';
import { formatDuration } from '@/lib/time';

type Phase = 'transcribing' | 'summarizing' | 'failed' | 'missing';

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

  const run = useCallback(async () => {
    if (!meetingId || started.current) return;
    started.current = true;
    setError('');
    setPhase('summarizing');
    try {
      await summarize(meetingId);
      replace('summary', { meetingId });
    } catch (e) {
      started.current = false;
      setError(e instanceof Error ? e.message : 'Something went wrong while writing the summary.');
      setPhase('failed');
    }
  }, [meetingId, replace]);

  useEffect(() => {
    if (!meetingId) { setPhase('missing'); return; }
    let alive = true;
    const refresh = async () => {
      try {
        const [m, chunks, segs, notes] = await Promise.all([getMeeting(meetingId), pendingChunks(meetingId), listSegments(meetingId), listNotes(meetingId)]);
        if (!alive) return;
        if (!m) { setPhase('missing'); return; }
        if (m.status === 'done' && m.summary) { replace('summary', { meetingId }); return; }
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
      if (msg.type === 'transcription/drained' && msg.meetingId === meetingId) void run();
      else if (msg.type === 'segment/added' && msg.segment.meetingId === meetingId) void refresh();
      return undefined;
    });
    const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [meetingId, replace, run]);

  const summarizing = phase === 'summarizing';
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
              {facts ? `${formatDuration(facts.ms)} of conversation and ${facts.notes} of your notes. ` : ''}
              This usually takes under a minute.
            </p>
          )}
        </div>

        {(phase === 'transcribing' || summarizing) && (
          <ol className="proc-steps" aria-label="Progress">
            <Step state={summarizing ? 'done' : 'active'} note={summarizing ? 'done' : waiting ? `${pending} left` : undefined}>Final transcript</Step>
            <Step state="todo">Decisions</Step>
            <Step state="todo">Action items and owners</Step>
            <Step state={summarizing ? 'active' : 'todo'}>Summary</Step>
          </ol>
        )}
      </div>
      <div className="proc-foot">
        {phase === 'failed' && <Button block onClick={() => void run()}>Retry</Button>}
        {waiting && (
          <Button block variant="secondary" onClick={() => void run()}>Summarize what exists</Button>
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
