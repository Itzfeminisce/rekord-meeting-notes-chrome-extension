import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { listCalendars, type CalendarInfo } from '@/lib/calendar';
import { disconnectGoogle, GoogleError, type GoogleDeps, type GoogleSettings } from '@/lib/google';
import { getSettings, onSettingsChanged, updateSettings } from '@/lib/settings';
import { loadKeys } from '@/lib/keys';
import { NOTION_HOSTS, requestHosts } from '@/lib/hosts';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { openGoogleConnect } from './GoogleConnect';

/** Test hook: lets tests inject chrome.identity and fetch. */
export const connectionsDeps: { current?: GoogleDeps } = {};

const s = {
  row: { padding: 14, borderRadius: 16, background: '#FFFFFF', border: '1px solid #E8E8EB', display: 'flex', flexDirection: 'column', gap: 12 },
  head: { display: 'flex', alignItems: 'center', gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  names: { flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  name: { fontSize: 14, fontWeight: 600 },
  sub: { fontSize: 12, color: '#6E7079', overflowWrap: 'anywhere' },
  on: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: '#1A6B40', flexShrink: 0 },
  dot: { width: 7, height: 7, borderRadius: '50%', background: '#1A7F4B' },
  connect: { height: 32, padding: '0 12px', border: 'none', borderRadius: 9, background: '#111114', color: '#FFFFFF', font: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  uses: { listStyle: 'none', margin: 0, padding: '10px 12px', borderRadius: 10, background: '#F6F6F7', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, lineHeight: 1.4, color: '#44464D' },
  note: { fontSize: 12, lineHeight: 1.4, color: '#44464D' },
  select: { height: 34, padding: '0 8px', border: '1px solid #DCDCE0', borderRadius: 9, background: '#F9F9FA', font: 'inherit', fontSize: 13, color: '#111114', maxWidth: '60%' },
  disconnect: { alignSelf: 'flex-start', height: 32, padding: '0 12px', border: '1px solid #E8E8EB', borderRadius: 9, background: '#FFFFFF', font: 'inherit', fontSize: 12, fontWeight: 600, color: '#111114', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 },
  alert: { margin: 0, padding: '10px 12px', borderRadius: 10, background: '#FFF8EC', border: '1px solid #F5DDB0', fontSize: 12, lineHeight: 1.45, color: '#5C3200' },
} satisfies Record<string, CSSProperties>;

function Connected() {
  return <span style={s.on}><span style={s.dot} />Connected</span>;
}

function ConnectButton({ onClick }: { onClick?: () => void }) {
  return <button type="button" style={s.connect} onClick={onClick}>Connect</button>;
}

function Row({ icon, iconBg, name, sub, right, children, gap = 12 }: { icon: ReactNode; iconBg: string; name: string; sub: string; right: ReactNode; children?: ReactNode; gap?: number }) {
  return (
    <section aria-label={name} style={{ ...s.row, gap }}>
      <div style={s.head}>
        <span style={{ ...s.icon, background: iconBg }}>{icon}</span>
        <span style={s.names}><span style={s.name}>{name}</span><span style={s.sub}>{sub}</span></span>
        {right}
      </div>
      {children}
    </section>
  );
}

export default function Connections() {
  const router = useRouter();
  const { back, canGoBack, replace } = router;
  const [google, setGoogle] = useState<GoogleSettings | undefined>(undefined);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lost, setLost] = useState(false);
  const [notion, setNotion] = useState<{ pageId?: string; pageTitle?: string } | undefined>(undefined);
  const [notionToken, setNotionToken] = useState(false);

  useEffect(() => {
    const apply = (st: { google: GoogleSettings; notion: { pageId?: string; pageTitle?: string } }) => { setGoogle(st.google); setNotion(st.notion); };
    void getSettings().then(apply);
    void loadKeys().then((k) => setNotionToken(Boolean(k.NOTION_TOKEN))).catch(() => undefined);
    return onSettingsChanged(apply);
  }, []);

  useEffect(() => {
    setLost(false);
    if (!google?.calendar) return;
    let alive = true;
    listCalendars(connectionsDeps.current)
      .then((list) => { if (alive) setCalendars(list); })
      .catch((err) => {
        if (alive && err instanceof GoogleError && err.code === 'auth') setLost(true);
      });
    return () => { alive = false; };
  }, [google?.calendar]);

  const toSettings = () => (canGoBack ? back() : replace('settings'));
  const connect = () => openGoogleConnect(router, 'connections');

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await disconnectGoogle(connectionsDeps.current);
      setCalendars([]);
    } catch {
      setError('Rekord couldn’t disconnect Google. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  async function chooseCalendar(calendarId: string) {
    if (!google) return;
    await updateSettings({ google: { ...google, calendarId } });
  }

  const disconnectButton = (
    <button type="button" style={s.disconnect} onClick={() => void disconnect()} disabled={busy} aria-busy={busy || undefined}>{busy && <Spinner label="Disconnecting" size={12} />}{busy ? 'Disconnecting…' : 'Disconnect'}</button>
  );
  const selected = google?.calendarId ?? calendars.find((c) => c.primary)?.id ?? 'primary';

  return (
    <main className="screen" style={{ background: '#F6F6F7' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
        <button type="button" className="icon-btn" aria-label="Back to settings" onClick={toSettings}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>Connected apps</h1>
      </header>
      <p style={{ margin: '10px 20px 0', fontSize: 13, lineHeight: 1.5, color: '#5F6168' }}>Rekord only asks each app for what it needs. You can disconnect any time.</p>

      {google === undefined ? (
        <div style={{ padding: 24 }}><Spinner label="Loading connected apps" /></div>
      ) : (
        <div style={{ padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Row
            iconBg="#EEF0FF"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4F46E5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>}
            name="Google Calendar"
            sub={google.calendar && google.email ? `${google.email} · can only read your events` : 'Can only read your events'}
            right={google.calendar ? <Connected /> : <ConnectButton onClick={connect} />}
          >
            <ul style={s.uses}>
              <li>Names a meeting after the event you’re in</li>
              <li>Suggests speaker names from the invite’s guests</li>
              <li>Shows your next call on the start screen</li>
            </ul>
            {google.calendar && (
              <>
                {lost && (
                  <div role="alert" style={{ ...s.alert, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ flexGrow: 1 }}>Rekord can’t see your calendar anymore.</span>
                    <button type="button" style={{ ...s.disconnect, alignSelf: 'center', borderColor: '#F5DDB0', color: '#5C3200' }} onClick={connect}>Reconnect</button>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <label htmlFor="cal" style={{ flexGrow: 1, fontSize: 13, fontWeight: 500 }}>Calendar to use</label>
                  <select id="cal" style={s.select} value={selected} onChange={(e) => void chooseCalendar(e.target.value)}>
                    {calendars.length === 0 && <option value={selected}>{google.email || 'Your calendar'}</option>}
                    {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                {error && <p role="alert" style={s.alert}>{error}</p>}
                {disconnectButton}
              </>
            )}
          </Row>

          <Row
            gap={10}
            iconBg="#EAF6EF"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1A6B40" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>}
            name="Google Docs"
            sub="Can only see files Rekord makes"
            right={google.docs ? <Connected /> : <ConnectButton onClick={connect} />}
          >
            <span style={s.note}>Saves shared meetings to a “Rekord” folder in your Drive and makes view-only links.</span>
            {google.docs && !google.calendar && disconnectButton}
            {!google.calendar && error && <p role="alert" style={s.alert}>{error}</p>}
          </Row>

          <Row
            gap={10}
            iconBg="#F1F1F3"
            icon={<span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600 }}>N</span>}
            name="Notion"
            sub="Can only see pages you choose"
            right={notionToken ? <Connected /> : <ConnectButton onClick={() => router.navigate('notionConnect')} />}
          >
            <span style={s.note}>Adds each shared meeting as a page under the one you choose.</span>
            {notionToken && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere' }}>{notion?.pageTitle ?? 'No page chosen yet'}</span>
                <button type="button" style={{ ...s.disconnect, alignSelf: 'center' }} onClick={() => void requestHosts(NOTION_HOSTS).then(() => router.navigate('notionPage'))}>{notion?.pageId ? 'Change' : 'Choose a page'}</button>
              </div>
            )}
          </Row>
        </div>
      )}
    </main>
  );
}
