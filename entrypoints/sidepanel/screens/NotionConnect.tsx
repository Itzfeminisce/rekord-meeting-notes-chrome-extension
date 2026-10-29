import { useState } from 'react';
import { NOTION_HOSTS, requestHosts } from '@/lib/hosts';
import { loadKeys, mergeKeys } from '@/lib/keys';
import { NOTION_INTEGRATIONS_URL, NotionError, validateSecret, type NotionDeps } from '@/lib/share/notion';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { BackIcon, ExternalLink, PenvCloudLink } from './setupParts';

/** Test hook: lets tests inject fetch. */
export const notionDeps: { current?: NotionDeps } = {};

/** True while Connect → Choose a page runs as one flow, so "Use" can go back past both screens. */
export const notionFlow = { fromConnect: false };

const STEP: React.CSSProperties = { width: 22, height: 22, borderRadius: '50%', background: '#111114', color: '#FFFFFF', fontFamily: 'var(--mono)', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 };
const ITEM: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'flex-start' };
const TEXT: React.CSSProperties = { fontSize: 14, lineHeight: 1.45 };

export default function NotionConnect() {
  const { back, navigate } = useRouter();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    if (busy) return;
    setError('');
    let token = secret.trim();
    // Asked before any other await, so the click still counts as the gesture Chrome wants.
    const allowed = token ? requestHosts(NOTION_HOSTS) : undefined;
    if (!token) {
      try { token = (await loadKeys()).NOTION_TOKEN?.trim() ?? ''; } catch { token = ''; }
    }
    if (!token) { setError('Paste your Notion secret to continue.'); return; }
    setBusy(true);
    if (!(await (allowed ?? requestHosts(NOTION_HOSTS)))) {
      setError('Rekord needs your permission to reach Notion. Try again and choose Allow.');
      setBusy(false);
      return;
    }
    try {
      await validateSecret(token, notionDeps.current);
      await mergeKeys({ NOTION_TOKEN: token });
      notionFlow.fromConnect = true;
      navigate('notionPage');
    } catch (err) {
      setError(err instanceof NotionError ? err.message : 'Notion didn’t connect. Try again in a moment.');
      setBusy(false);
    }
  }

  return (
    <main className="screen" style={{ background: '#F6F6F7' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
        <button type="button" className="icon-btn" aria-label="Back to connected apps" onClick={back}><BackIcon /></button>
      </header>

      <div style={{ padding: '8px 24px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1.2, fontWeight: 600, letterSpacing: '-0.02em' }}>Connect Notion</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '#5F6168' }}>Rekord connects to Notion with a secret you create once. It takes about two minutes.</p>
      </div>

      <ol aria-label="Steps" style={{ listStyle: 'none', margin: '18px 24px 0', padding: 16, borderRadius: 18, background: '#FFFFFF', border: '1px solid #E8E8EB', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <li style={ITEM}>
          <span style={STEP}>1</span>
          <span style={TEXT}>In Notion, create a connection named Rekord. <ExternalLink href={NOTION_INTEGRATIONS_URL} style={{ textDecoration: 'none', fontWeight: 500 }}>Open Notion connections</ExternalLink></span>
        </li>
        <li style={ITEM}>
          <span style={STEP}>2</span>
          <span style={TEXT}>Copy its secret and paste it below.</span>
        </li>
        <li style={ITEM}>
          <span style={STEP}>3</span>
          <span style={TEXT}>On the Notion page where meetings should go, open <span style={{ fontWeight: 600 }}>···</span> then <span style={{ fontWeight: 600 }}>Connections</span>, and add Rekord.</span>
        </li>
      </ol>

      <div style={{ margin: '14px 24px 0', padding: 14, borderRadius: 16, background: '#FFFFFF', border: '1px solid #E8E8EB', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label htmlFor="ns" style={{ fontSize: 12, fontWeight: 500, color: '#44464D' }}>Notion secret</label>
        <input
          id="ns" type="password" placeholder="ntn_…" value={secret} autoComplete="off" spellCheck={false}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void go(); }}
          style={{ height: 42, boxSizing: 'border-box', padding: '0 12px', border: '1px solid #DCDCE0', borderRadius: 10, background: '#F9F9FA', fontFamily: 'var(--mono)', fontSize: 13, color: '#111114' }}
        />
        <span style={{ fontSize: 12, lineHeight: 1.45, color: '#6E7079' }}>
          Using <PenvCloudLink style={{ textDecoration: 'none', fontWeight: 500 }} />? Add it there as <span style={{ fontFamily: 'var(--mono)' }}>NOTION_TOKEN</span> and Rekord picks it up.
        </span>
      </div>

      {error && (
        <p role="alert" style={{ margin: '12px 24px 0', padding: '12px 14px', borderRadius: 12, background: '#FFF8EC', border: '1px solid #F5DDB0', fontSize: 13, lineHeight: 1.45, color: '#5C3200' }}>{error}</p>
      )}

      <div style={{ flexGrow: 1 }} />
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button" onClick={() => void go()} disabled={busy} aria-busy={busy || undefined}
          style={{ height: 48, border: 'none', borderRadius: 12, background: '#111114', color: '#FFFFFF', font: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.75 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          {busy && <Spinner label="Connecting to Notion" size={16} />}
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <span style={{ textAlign: 'center', fontSize: 12, color: '#6E7079' }}>Rekord can only see the pages you add it to.</span>
      </div>
    </main>
  );
}
