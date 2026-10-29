import { useState, type CSSProperties } from 'react';
import { connectGoogle, GoogleError, type GoogleDeps } from '@/lib/google';
import { Spinner } from '../components';
import { useRouter, type Router, type ScreenName } from '../router';

/** Route names this task adds (router.tsx / App.tsx entries are wired by the orchestrator). */
export const GOOGLE_CONNECT: ScreenName = 'googleConnect';
export const CONNECTIONS: ScreenName = 'connections';

let returnTo: 'connections' | 'start' = 'connections';

/** Opens Connect Google; after consent the user lands on Connected apps. */
export function openGoogleConnect(router: Pick<Router, 'navigate'>, from: 'connections' | 'start') {
  returnTo = from;
  router.navigate(GOOGLE_CONNECT);
}

/** Test hook: lets tests inject chrome.identity and fetch. */
export const googleConnectDeps: { current?: GoogleDeps } = {};

const s = {
  option: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: 16, borderRadius: 16, background: '#FFFFFF', border: '1px solid #E8E8EB', cursor: 'pointer' },
  check: { width: 18, height: 18, margin: '2px 0 0', accentColor: '#4F46E5', flexShrink: 0 },
  optText: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 6 },
  optTitle: { fontSize: 15, fontWeight: 600 },
  optBody: { fontSize: 13, lineHeight: 1.45, color: '#5F6168' },
  optSafe: { fontSize: 12, color: '#1A6B40', fontWeight: 500 },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
} satisfies Record<string, CSSProperties>;

export default function GoogleConnect() {
  const router = useRouter();
  const { back, navigate } = router;
  const [calendar, setCalendar] = useState(true);
  const [docs, setDocs] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    if (busy || (!calendar && !docs)) return;
    setBusy(true);
    setError('');
    try {
      await connectGoogle({ calendar, docs }, googleConnectDeps.current);
      const from = returnTo;
      returnTo = 'connections';
      back();
      if (from !== 'connections') navigate(CONNECTIONS);
    } catch (err) {
      setError(err instanceof GoogleError ? err.message : 'Google didn’t connect. Try again in a moment.');
      setBusy(false);
    }
  }

  return (
    <main className="screen" style={{ background: '#F6F6F7' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
        <button type="button" className="icon-btn" aria-label="Back to connected apps" onClick={back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
      </header>

      <div style={{ padding: '8px 24px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1.2, fontWeight: 600, letterSpacing: '-0.02em' }}>Connect your Google account</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '#5F6168' }}>Choose what Rekord can use. Google will ask you to confirm on the next screen.</p>
      </div>

      <fieldset style={{ margin: '20px 24px 0', padding: 0, border: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <legend style={s.srOnly}>What Rekord can use</legend>
        <label style={s.option}>
          <input type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} style={s.check} />
          <span style={s.optText}>
            <span style={s.optTitle}>Calendar</span>
            <span style={s.optBody}>Rekord can see your events and who’s invited, to name meetings and suggest who’s speaking.</span>
            <span style={s.optSafe}>Can’t change or create events</span>
          </span>
        </label>
        <label style={s.option}>
          <input type="checkbox" checked={docs} onChange={(e) => setDocs(e.target.checked)} style={s.check} />
          <span style={s.optText}>
            <span style={s.optTitle}>Google Docs</span>
            <span style={s.optBody}>Rekord can save meetings you share as Docs in a “Rekord” folder.</span>
            <span style={s.optSafe}>Can’t see your other files</span>
          </span>
        </label>
      </fieldset>

      <p style={{ margin: '16px 24px 0', padding: '12px 14px', borderRadius: 12, background: '#EDEDF0', fontSize: 13, lineHeight: 1.5, color: '#44464D' }}>Your meetings stay on this computer. Rekord only sends a meeting to Google when you choose to share it.</p>

      {error && (
        <p role="alert" style={{ margin: '12px 24px 0', padding: '12px 14px', borderRadius: 12, background: '#FFF8EC', border: '1px solid #F5DDB0', fontSize: 13, lineHeight: 1.45, color: '#5C3200' }}>{error}</p>
      )}

      <div style={{ flexGrow: 1 }} />
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button
          type="button"
          onClick={() => void go()}
          disabled={busy || (!calendar && !docs)}
          aria-busy={busy || undefined}
          style={{ height: 48, border: 'none', borderRadius: 12, background: '#111114', color: '#FFFFFF', font: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.75 : !calendar && !docs ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          {busy && <Spinner label="Connecting to Google" size={16} />}
          {busy ? 'Waiting for Google…' : 'Continue to Google'}
        </button>
        <button
          type="button"
          onClick={back}
          style={{ height: 44, border: 'none', borderRadius: 12, background: 'transparent', color: '#44464D', font: 'inherit', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
        >
          Not now
        </button>
      </div>
    </main>
  );
}
