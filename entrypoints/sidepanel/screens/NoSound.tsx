import { useEffect, useState } from 'react';
import { useRouter } from '../router';
import { appAudio, appLabel, appName, endedBanner, SILENT_LEVEL, type AppAudioStatus } from '@/lib/audio/appAudio';
import { getMeeting } from '@/lib/db';
import { elapsedMs } from '@/lib/live';
import { onMessage, send } from '@/lib/messages';
import { formatClock } from '@/lib/time';
import type { Meeting, RecordingState } from '@/lib/types';

/** The side panel's app-audio status, kept in sync. */
export function useAppAudioStatus(): AppAudioStatus {
  const [status, setStatus] = useState<AppAudioStatus>(() => appAudio().status);
  useEffect(() => {
    const c = appAudio();
    setStatus(c.status);
    return c.subscribe(setStatus);
  }, []);
  return status;
}

function useRecording(): RecordingState | undefined {
  const [rec, setRec] = useState<RecordingState | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const off = onMessage((msg) => {
      if (msg.type === 'recording/state') setRec(msg.state);
      return undefined;
    });
    send<RecordingState>({ type: 'recording/get-state' }).then((s) => alive && setRec((r) => r ?? s ?? { status: 'idle' }), () => undefined);
    return () => { alive = false; off(); };
  }, []);
  return rec;
}

function useMeeting(meetingId?: string): Meeting | undefined {
  const [m, setM] = useState<Meeting | undefined>(undefined);
  useEffect(() => {
    if (!meetingId) return;
    getMeeting(meetingId).then(setM, () => undefined);
  }, [meetingId]);
  return m;
}

/** V3NoSound: after an app start, Rekord hears nothing from the meeting. */
export default function NoSound() {
  const { route, replace } = useRouter();
  const meetingId = route.params.meetingId;
  const status = useAppAudioStatus();
  const rec = useRecording();
  const meeting = useMeeting(meetingId);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const active = rec && rec.status !== 'idle' ? rec : undefined;
  const othersLevel = active?.tabLevel ?? 0;
  const micLevel = active && !active.micUnavailable ? active.micLevel : 0;

  // Back to Live once sound arrives after Share again.
  useEffect(() => {
    if (meetingId && status === 'on' && othersLevel >= SILENT_LEVEL) replace('live', { meetingId });
  }, [status, othersLevel, meetingId, replace]);

  // The recording ended elsewhere: move on like Live does.
  useEffect(() => {
    if (rec?.status === 'idle' && !stopping) replace(meetingId ? 'processing' : 'start', meetingId ? { meetingId } : {});
  }, [rec, stopping, meetingId, replace]);

  async function shareAgain() {
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await appAudio().shareAgain().catch(() => 'error' as const);
    setBusy(false);
    if (r === 'error') setError('Chrome didn’t share the screen. Select Share again to try once more.');
  }

  async function micOnly() {
    await appAudio().micOnly();
    if (meetingId) replace('live', { meetingId });
  }

  async function end() {
    if (!meetingId || stopping) return;
    setStopping(true);
    const reply = await send<{ ok?: boolean }>({ type: 'recording/stop' });
    if (reply === undefined || reply.ok !== false) replace('processing', { meetingId });
    else { setStopping(false); setError('Rekord couldn’t stop the recording. Try again.'); }
  }

  const label = appLabel(meeting?.event);
  const sub = ['Recording', active ? formatClock(elapsedMs(active.startedAt, now)) : null, label].filter(Boolean).join(' · ');
  const meter = (level: number) => Math.round(Math.min(1, Math.max(0, level)) * 100);

  return (
    <main className="screen ns">
      <style>{NOSOUND_CSS}</style>
      <div className="ns-top">
        <div className="ns-bar">
          <span className="rec-dot" aria-hidden="true" />
          <div className="ns-bar-text">
            <span className="ns-title">{meeting?.title || 'Untitled meeting'}</span>
            <span className="ns-sub">{sub}</span>
          </div>
          <button type="button" className="ns-end" onClick={end} disabled={stopping}>End</button>
        </div>
      </div>
      <div className="ns-body">
        <div role="alert" className="ns-alert">
          <span className="ns-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8A4B00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4z" /><path d="M23 9l-6 6M17 9l6 6" /></svg>
          </span>
          <h1>Rekord can’t hear the meeting</h1>
          <p>Your microphone is working, but no sound is coming from {appName(meeting?.event)}. Chrome probably wasn’t allowed to share the computer’s audio.</p>
        </div>
        <ol aria-label="How to fix it" className="ns-steps">
          <li><span className="ns-n">1</span><span>Select <b>Share again</b> below.</span></li>
          <li><span className="ns-n">2</span><span>In Chrome’s window, choose <b>Entire screen</b>.</span></li>
          <li><span className="ns-n">3</span><span>Turn on <b>Also share system audio</b>, then select <b>Share</b>.</span></li>
        </ol>
        <div className="ns-meter">
          <span className="ns-meter-lbl">Meeting</span>
          <span className="ns-track" role="meter" aria-label="Meeting sound level" aria-valuenow={meter(othersLevel)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${meter(othersLevel)}%` }} /></span>
          <span className={othersLevel >= SILENT_LEVEL ? 'ns-ok' : 'ns-silent'}>{othersLevel >= SILENT_LEVEL ? 'OK' : 'Silent'}</span>
        </div>
        <div className="ns-meter ns-meter-2">
          <span className="ns-meter-lbl">You</span>
          <span className="ns-track" role="meter" aria-label="Your microphone level" aria-valuenow={meter(micLevel)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${meter(micLevel)}%` }} /></span>
          <span className={micLevel >= SILENT_LEVEL ? 'ns-ok' : 'ns-silent'}>{micLevel >= SILENT_LEVEL ? 'OK' : 'Silent'}</span>
        </div>
        {error && <p className="start-warn" role="alert">{error}</p>}
      </div>
      <div className="ns-actions">
        <button type="button" className="ns-primary" onClick={shareAgain} disabled={busy}>Share again</button>
        <button type="button" className="ns-secondary" onClick={micOnly}>Keep going with just my microphone</button>
      </div>
    </main>
  );
}

/**
 * Runs beside Live for an app meeting: opens V3NoSound when the recorder reports silence, and shows the
 * "Rekord can’t hear <App> anymore" banner (V3States "Live · screen sharing stopped") when sharing ends.
 */
export function AppAudioWatch({ meetingId }: { meetingId?: string }) {
  const { navigate } = useRouter();
  const status = useAppAudioStatus();
  const meeting = useMeeting(meetingId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'silent' && meetingId) navigate('nosound', { meetingId });
  }, [status, meetingId, navigate]);

  if (status !== 'ended') return null;
  const b = endedBanner(appName(meeting?.event));
  return (
    <div role="alert" className="ns-banner">
      <style>{NOSOUND_CSS}</style>
      <div className="ns-banner-text"><span className="ns-banner-title">{b.title}</span><span>{b.body}</span></div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await appAudio().shareAgain().catch(() => undefined);
          setBusy(false);
        }}
      >Share again</button>
    </div>
  );
}

const NOSOUND_CSS = `
.ns { display: flex; flex-direction: column; min-height: 100vh; }
.ns-top { padding: 12px 12px 0; }
.ns-bar { display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 14px; border-radius: 16px; background: var(--ink); color: #fff; }
.ns-bar-text { flex-grow: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ns-title { font-size: 13px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ns-sub { font-family: var(--mono); font-size: 11px; color: #a3a3b2; }
.ns-end { height: 36px; padding: 0 14px; border: 0; border-radius: 10px; background: #fff; color: var(--ink); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.ns-body { flex-grow: 1; padding: 20px 20px 0; display: flex; flex-direction: column; gap: 18px; }
.ns-alert { display: flex; flex-direction: column; gap: 10px; }
.ns-icon { width: 48px; height: 48px; border-radius: 16px; background: #fff4e5; display: flex; align-items: center; justify-content: center; }
.ns-alert h1 { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 600; letter-spacing: -0.01em; }
.ns-alert p { margin: 0; font-size: 14px; line-height: 1.5; color: var(--muted); }
.ns-steps { list-style: none; margin: 0; padding: 16px; border-radius: 18px; background: var(--surface); border: 1px solid var(--line); display: flex; flex-direction: column; gap: 14px; }
.ns-steps li { display: flex; gap: 12px; align-items: flex-start; font-size: 14px; line-height: 1.45; }
.ns-steps b { font-weight: 600; }
.ns-n { width: 22px; height: 22px; border-radius: 50%; background: var(--ink); color: #fff; font-family: var(--mono); font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.ns-meter { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); }
.ns-meter-2 { margin-top: -10px; }
.ns-meter-lbl { font-size: 12px; font-weight: 500; color: #44464d; width: 70px; }
.ns-track { flex-grow: 1; height: 6px; border-radius: 3px; background: #ebebee; overflow: hidden; display: flex; }
.ns-track span { background: var(--accent); transition: width 0.2s; }
.ns-silent { font-size: 12px; color: #8a4b00; font-weight: 600; }
.ns-ok { font-size: 12px; color: #1a6b40; font-weight: 600; }
.ns-actions { padding: 20px; display: flex; flex-direction: column; gap: 8px; }
.ns-primary { height: 48px; border: none; border-radius: 12px; background: var(--ink); color: #fff; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
.ns-primary:disabled { opacity: 0.6; }
.ns-secondary { height: 44px; border: 0; border-radius: 12px; background: transparent; color: var(--ink); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.ns-end:focus-visible, .ns-primary:focus-visible, .ns-secondary:focus-visible, .ns-banner button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ns-banner { margin: 12px 12px 0; padding: 12px 14px; border-radius: 14px; background: #fff8ec; border: 1px solid #f5ddb0; display: flex; flex-direction: column; gap: 10px; }
.ns-banner-text { display: flex; flex-direction: column; gap: 3px; font-size: 13px; line-height: 1.45; color: #6b3d00; }
.ns-banner-title { font-size: 14px; font-weight: 600; color: #5c3200; }
.ns-banner button { align-self: flex-start; height: 32px; padding: 0 12px; border: none; border-radius: 9px; background: var(--ink); color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
`;
