import { useEffect, useState } from 'react';
import { BrandMark, Button, Spinner } from '../components';
import { useRouter } from '../router';
import type { RecordingReply } from '../../background';
import { ensureKeys, reconnect, transcriptionKeyRejected } from '@/lib/connect';
import { getMeeting, listMeetings, putMeeting } from '@/lib/db';
import { dateTile, hostOf } from '@/lib/live';
import { send } from '@/lib/messages';
import { DEFAULT_SOURCES, isLastSource, toggleSource } from '@/lib/sources';
import { formatDuration } from '@/lib/time';
import type { Meeting, RecordingState } from '@/lib/types';

interface TabInfo { id: number; title: string; url?: string; favIconUrl?: string }

function subtitle(m: Meeting): string {
  const parts: string[] = [];
  if (m.endedAt) parts.push(formatDuration(m.endedAt - m.startedAt));
  const n = m.summary?.actions.length;
  if (n) parts.push(`${n} action ${n === 1 ? 'item' : 'items'}`);
  return parts.join(' · ') || 'No summary yet';
}

export default function Start() {
  const { navigate, replace } = useRouter();
  const [tab, setTab] = useState<TabInfo | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [sources, setSources] = useState(DEFAULT_SOURCES);
  const [keys, setKeys] = useState<'checking' | 'ready' | 'reconnect'>('checking');
  const [recent, setRecent] = useState<Meeting[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [keyRejected, setKeyRejected] = useState(false);
  const [stateChecked, setStateChecked] = useState(false);

  useEffect(() => {
    let alive = true;
    send<RecordingState>({ type: 'recording/get-state' })
      .then((s) => {
        if (!alive) return;
        if (s && s.status !== 'idle' && 'meetingId' in s && s.meetingId) replace('live', { meetingId: s.meetingId });
        else setStateChecked(true);
      })
      .catch(() => alive && setStateChecked(true));
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => {
        if (t?.id != null) {
          setTab({ id: t.id, title: t.title ?? '', url: t.url, favIconUrl: t.favIconUrl });
          setName(t.title ?? '');
        } else setTab(null);
      })
      .catch(() => setTab(null));
    ensureKeys().then(setKeys, () => setKeys('reconnect'));
    transcriptionKeyRejected().then((r) => alive && setKeyRejected(r), () => {});
    listMeetings()
      .then((all) => setRecent(all.filter((m) => m.status !== 'recording').sort((a, b) => b.startedAt - a.startedAt).slice(0, 3)))
      .catch(() => setRecent([]));
    return () => { alive = false; };
  }, []);

  async function tryReconnect() {
    setReconnecting(true);
    setError('');
    try {
      const ok = await reconnect();
      if (ok) setKeys('ready');
      else navigate('connect');
    } catch {
      navigate('connect');
    } finally {
      setReconnecting(false);
    }
  }

  async function record() {
    if (!tab || busy) return;
    setBusy(true);
    setError('');
    const reply = await send<RecordingReply>({ type: 'recording/start', tabId: tab.id, sources });
    if (reply && reply.ok && reply.meetingId) {
      const title = name.trim();
      if (title) {
        try {
          const m = await getMeeting(reply.meetingId);
          if (m && m.title !== title) await putMeeting({ ...m, title });
        } catch { /* keep the default title */ }
      }
      replace('live', { meetingId: reply.meetingId });
      return;
    }
    setBusy(false);
    setError(reply && !reply.ok ? reply.error : "Rekord couldn't start recording. Try again in a moment.");
  }

  const host = hostOf(tab?.url);
  const canRecord = !!tab && keys === 'ready' && stateChecked && !busy;

  return (
    <main className="screen">
      <header className="topbar start-top">
        <div className="brand"><BrandMark />Rekord</div>
        <div className="topbar-right">
          <button type="button" className="icon-btn" aria-label="All meetings" onClick={() => navigate('library')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
          </button>
          <button type="button" className="icon-btn" aria-label="Settings" onClick={() => navigate('settings')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
          </button>
        </div>
      </header>

      <section className="start-card" aria-label="New recording">
        {tab === undefined ? (
          <Spinner label="Checking your tab" />
        ) : tab === null ? (
          <p className="start-warn" role="status">Rekord can’t see your current tab. Open your meeting in a tab, then reopen this panel.</p>
        ) : (
          <div className="start-tab">
            <span className="start-dot" aria-hidden="true" />
            {tab.favIconUrl && <img src={tab.favIconUrl} alt="" width={16} height={16} />}
            <span className="start-tab-text">{host ? `Call detected on ${host}` : 'This tab will be recorded'}</span>
          </div>
        )}

        <div className="start-field">
          <label htmlFor="mt">Meeting name</label>
          <input id="mt" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled meeting" />
        </div>

        <ul className="start-sources">
          <li>
            <label>
              <input type="checkbox" checked={sources.mic} aria-disabled={isLastSource(sources, 'mic') || undefined} aria-describedby={isLastSource(sources, 'mic') ? 'src-hint' : undefined} onChange={() => { if (!isLastSource(sources, 'mic')) setSources((s) => toggleSource(s, 'mic')); }} />
              <span>You<small>Microphone</small></span>
            </label>
          </li>
          <li>
            <label>
              <input type="checkbox" checked={sources.tab} aria-disabled={isLastSource(sources, 'tab') || undefined} aria-describedby={isLastSource(sources, 'tab') ? 'src-hint' : undefined} onChange={() => { if (!isLastSource(sources, 'tab')) setSources((s) => toggleSource(s, 'tab')); }} />
              <span>Others<small>This tab</small></span>
            </label>
          </li>
        </ul>
        {(isLastSource(sources, 'mic') || isLastSource(sources, 'tab')) && <p id="src-hint" className="start-hint">Keep at least one source on</p>}

        {keys === 'reconnect' && (
          <div className="start-warn" role="alert">
            <span>Reconnect to your AI service to start recording.</span>
            <Button variant="secondary" onClick={tryReconnect} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'Reconnect'}</Button>
          </div>
        )}
        {keys === 'ready' && keyRejected && (
          <div className="start-warn" role="alert">
            <span>Your transcription key was rejected. Fix it in Settings.</span>
            <Button variant="secondary" onClick={() => navigate('settings')}>Settings</Button>
          </div>
        )}
        {error && <p className="start-warn" role="alert">{error}</p>}

        <button type="button" className="start-record" onClick={record} disabled={!canRecord}>
          <span className="rec-dot" aria-hidden="true" />
          {busy ? 'Starting…' : 'Start recording'}
        </button>
        <p className="hint">Remember to let everyone know you’re transcribing.</p>
      </section>

      <section className="start-recent" aria-labelledby="recent-h">
        <div className="start-recent-head">
          <h2 id="recent-h">Recent</h2>
          <button type="button" className="link-btn" onClick={() => navigate('library')}>View all</button>
        </div>
        {recent === undefined ? (
          <Spinner label="Loading recent meetings" />
        ) : recent.length === 0 ? (
          <p className="hint">Your meetings will show up here.</p>
        ) : (
          recent.map((m, i) => {
            const t = dateTile(m.startedAt);
            return (
              <button
                type="button"
                className="recent-row"
                key={m.id}
                onClick={() => navigate(m.status === 'done' ? 'summary' : 'processing', { meetingId: m.id })}
              >
                <span className={`date-tile${i === 0 ? ' first' : ''}`} aria-hidden="true"><span>{t.month}</span><b>{t.day}</b></span>
                <span className="recent-text"><span className="recent-title">{m.title || 'Untitled meeting'}</span><span className="recent-sub">{subtitle(m)}</span></span>
              </button>
            );
          })
        )}
      </section>
    </main>
  );
}
