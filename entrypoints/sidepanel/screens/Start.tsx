import { useEffect, useRef, useState } from 'react';
import { BrandMark, Button, Spinner } from '../components';
import { CalendarCard } from '../components/CalendarCard';
import { attachEvent } from '@/lib/calendar';
import { useRouter } from '../router';
import type { RecordingReply } from '../../background';
import { ensureKeys, reconnect, transcriptionKeyRejected } from '@/lib/connect';
import { PENV_HOSTS, requestHosts } from '@/lib/hosts';
import { getSettings } from '@/lib/settings';
import { wasDisconnected } from '@/lib/penvApp';
import { DisconnectedPanel } from './PenvConnect';
import { getMeeting, listMeetings, putMeeting } from '@/lib/db';
import { dateTile, hostOf } from '@/lib/live';
import { captureSources, needsTabGrant, TAB_GRANT_HINT, type AppFlag, type MeetingPlace } from '@/lib/capture';
import { appAudio } from '@/lib/audio/appAudio';
import { onMessage, send, type MessageOf } from '@/lib/messages';
import { formatDuration } from '@/lib/time';
import type { CalendarEvent, Meeting, RecordingState } from '@/lib/types';

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
  const [place, setPlace] = useState<MeetingPlace>('tab');
  const [mic, setMic] = useState(true);
  const placeRefs = useRef<Record<MeetingPlace, HTMLButtonElement | null>>({ tab: null, app: null });
  const [keys, setKeys] = useState<'checking' | 'ready' | 'reconnect'>('checking');
  const [recent, setRecent] = useState<Meeting[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [keyRejected, setKeyRejected] = useState(false);
  const [penvGone, setPenvGone] = useState(false);
  const [stateChecked, setStateChecked] = useState(false);
  const autoName = useRef(''); // the tab title we filled in; replaced when the active tab changes, unless edited
  const calEvent = useRef<CalendarEvent | undefined>(undefined); // T6: event happening now, attached on start

  useEffect(() => {
    let alive = true;
    send<RecordingState>({ type: 'recording/get-state' })
      .then((s) => {
        if (!alive) return;
        if (s && s.status !== 'idle' && 'meetingId' in s && s.meetingId) replace('live', { meetingId: s.meetingId });
        else setStateChecked(true);
      })
      .catch(() => alive && setStateChecked(true));
    // tabs.get/query only expose a tab's url once Rekord was invoked on it (activeTab), which is how we
    // detect a missing tab-capture grant. Re-check when the active tab changes and when the panel regains focus.
    const loadTab = () => browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => (t?.id != null ? browser.tabs.get(t.id) : undefined))
      .then((t) => {
        if (!alive) return;
        if (t?.id != null) {
          const title = t.title ?? '';
          setTab({ id: t.id, title, url: t.url, favIconUrl: t.favIconUrl });
          setName((n) => (n === autoName.current ? title : n));
          autoName.current = title;
        } else setTab(null);
      })
      .catch(() => alive && setTab(null));
    void loadTab();
    const onActivated = () => void loadTab();
    const onUpdated = (_id: number, info: { status?: string; url?: string; title?: string }) => {
      if (info.status === 'complete' || info.url || info.title) void loadTab();
    };
    window.addEventListener('focus', onActivated);
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    const offGranted = onMessage((m) => {
      if (m.type === 'tab/granted') void loadTab();
      return undefined;
    });
    const needReconnect = () => {
      setKeys('reconnect');
      Promise.all([getSettings(), wasDisconnected()])
        .then(([st, gone]) => alive && setPenvGone(gone && st.keySource === 'penv-app'))
        .catch(() => {});
    };
    ensureKeys().then((k) => (k === 'reconnect' ? needReconnect() : setKeys(k)), needReconnect);
    transcriptionKeyRejected().then((r) => alive && setKeyRejected(r), () => {});
    listMeetings()
      .then((all) => setRecent(all.filter((m) => m.status !== 'recording').sort((a, b) => b.startedAt - a.startedAt).slice(0, 3)))
      .catch(() => setRecent([]));
    return () => {
      alive = false;
      window.removeEventListener('focus', onActivated);
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      offGranted();
    };
  }, []);

  async function tryReconnect() {
    setReconnecting(true);
    setError('');
    await requestHosts(PENV_HOSTS);
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

  function choosePlace(next: MeetingPlace, focus = false) {
    setPlace(next);
    setError('');
    if (focus) placeRefs.current[next]?.focus();
  }

  function onPlaceKey(e: React.KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    choosePlace(place === 'tab' ? 'app' : 'tab', true);
  }

  async function record() {
    if ((place === 'tab' && !tab) || busy) return;
    setBusy(true);
    setError('');
    // In an app: Chrome's share picker first (still inside the click), then the recording.
    const app = place === 'app' ? appAudio() : null;
    const picked = app ? await app.pick() : 'audio';
    if (picked === 'cancelled' || picked === 'error') {
      setBusy(false);
      if (picked === 'error') setError("Rekord couldn’t start recording. Try again in a moment.");
      return;
    }
    const { sources, app: isApp } = captureSources(place, mic, picked === 'audio');
    const start: MessageOf<'recording/start'> & AppFlag = { type: 'recording/start', tabId: tab?.id ?? -1, sources, ...(isApp && { app: true }) };
    const reply = await send<RecordingReply>(start);
    if (reply && reply.ok && reply.meetingId && app) {
      try {
        await app.connect();
      } catch {
        // The microphone keeps recording; the meeting can be shared again from the next screen.
      }
    } else if (app) app.end();
    if (reply && reply.ok && reply.meetingId) {
      // In an app the tab's title isn't the meeting's name: only keep a name the user typed.
      const typed = place === 'app' && name === autoName.current ? '' : name;
      const title = typed.trim();
      if (title) {
        try {
          const m = await getMeeting(reply.meetingId);
          if (m && m.title !== title) await putMeeting({ ...m, title });
        } catch { /* keep the default title */ }
      }
      if (calEvent.current) await attachEvent(reply.meetingId, calEvent.current).catch(() => undefined);
      replace(app && app.status === 'silent' ? 'nosound' : 'live', { meetingId: reply.meetingId });
      return;
    }
    setBusy(false);
    setError(reply && !reply.ok ? reply.error : "Rekord couldn’t start recording. Try again in a moment.");
  }

  const host = hostOf(tab?.url);
  const canRecord = (place === 'app' || !!tab) && keys === 'ready' && stateChecked && !busy;

  return (
    <main className="screen">
      <style>{START_CSS}</style>
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

      <CalendarCard onEvent={(ev) => { calEvent.current = ev; if (ev) setName((n) => (n === autoName.current ? ev.title : n)); }} />

      <section className="start-card" aria-label="New recording">
        {place === 'app' ? null : tab === undefined ? (
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

        <div className="start-place">
          <span id="others-lbl" className="start-place-lbl">Where is the meeting?</span>
          <div role="radiogroup" aria-labelledby="others-lbl" className="start-seg" onKeyDown={onPlaceKey}>
            <button type="button" role="radio" aria-checked={place === 'tab'} tabIndex={place === 'tab' ? 0 : -1} ref={(el) => { placeRefs.current.tab = el; }} onClick={() => choosePlace('tab')}>In this tab<span>Meet, Zoom or Teams in Chrome</span></button>
            <button type="button" role="radio" aria-checked={place === 'app'} tabIndex={place === 'app' ? 0 : -1} ref={(el) => { placeRefs.current.app = el; }} onClick={() => choosePlace('app')}>In an app<span>Zoom or Teams for Windows</span></button>
          </div>
          {place === 'app' && (
            <p className="start-steps">Next, Chrome asks what to share. Choose <b>Entire screen</b> and turn on <b>Also share system audio</b>. Rekord only listens. It never records your screen.</p>
          )}
          <label className="start-mic">
            <input type="checkbox" checked={mic} onChange={(e) => setMic(e.target.checked)} />Include my microphone
          </label>
        </div>

        {keys === 'reconnect' && penvGone && <DisconnectedPanel onConnect={() => navigate('penvConnect')} />}
        {keys === 'reconnect' && !penvGone && (
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
        {!error && tab && place === 'tab' && needsTabGrant({ tabOn: true, tabUrl: tab.url }) && (
          <p className="start-grant" role="status">{TAB_GRANT_HINT}</p>
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

/* v3 "Where is the meeting?" (V3Start) */
const START_CSS = `
.start-place { display: flex; flex-direction: column; gap: 8px; }
.start-place-lbl { font-size: 12px; font-weight: 500; color: #44464d; }
.start-seg { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; padding: 4px; border-radius: 12px; background: #f1f1f3; }
.start-seg button { height: 40px; border: none; border-radius: 9px; background: transparent; font: inherit; font-size: 13px; font-weight: 500; color: var(--muted); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; cursor: pointer; }
.start-seg button span { font-size: 10px; font-weight: 500; color: var(--faint); }
.start-seg button[aria-checked="true"] { background: var(--surface); font-weight: 600; color: var(--ink); box-shadow: 0 1px 2px rgba(16,16,20,0.08); }
.start-seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.start-steps { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--ground); font-size: 12px; line-height: 1.45; color: #44464d; }
.start-steps b { font-weight: 600; }
.start-mic { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.start-mic input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
`;
