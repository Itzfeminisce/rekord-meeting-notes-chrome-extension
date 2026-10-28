import { useEffect, useState } from 'react';
import { loadKeys } from '@/lib/keys';
import { getSettings, updateSettings } from '@/lib/settings';
import { NOTION_ADD_CONNECTIONS_URL, NotionError, searchPages, type NotionPageInfo } from '@/lib/share/notion';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { BackIcon, ExternalLink } from './setupParts';
import { notionDeps, notionFlow } from './NotionConnect';

export default function NotionPage() {
  const { back, replace } = useRouter();
  const [pages, setPages] = useState<NotionPageInfo[] | undefined>(undefined);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setPages(undefined); setError('');
    (async () => {
      const token = (await loadKeys()).NOTION_TOKEN;
      if (!token) { if (alive) { notionFlow.fromConnect = false; replace('connections'); } return; }
      const [list, settings] = await Promise.all([searchPages(token, notionDeps.current), getSettings()]);
      if (!alive) return;
      setPages(list);
      setChosen(list.find((p) => p.id === settings.notion.pageId)?.id ?? list[0]?.id ?? '');
    })().catch((err) => {
      if (!alive) return;
      setError(err instanceof NotionError ? err.message : 'Rekord couldn’t load your Notion pages. Try again.');
      setPages([]);
    });
    return () => { alive = false; };
  }, [attempt, replace]);

  const picked = pages?.find((p) => p.id === chosen);

  function leave() {
    const twice = notionFlow.fromConnect;
    notionFlow.fromConnect = false;
    back();
    if (twice) back();
  }

  async function use() {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await updateSettings({ notion: { pageId: picked.id, pageTitle: picked.title } });
      leave();
    } catch {
      setError('Rekord couldn’t save that choice. Try again.');
      setBusy(false);
    }
  }

  return (
    <main className="screen" style={{ background: '#F6F6F7' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
        <button type="button" className="icon-btn" aria-label="Back to connected apps" onClick={leave}><BackIcon /></button>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#1A6B40' }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: '#1A7F4B' }} />Notion connected
        </span>
      </header>

      <div style={{ padding: '8px 24px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1.2, fontWeight: 600, letterSpacing: '-0.02em' }}>Where should meetings go?</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '#5F6168' }}>Each meeting you share becomes a page inside the one you pick.</p>
      </div>

      {pages === undefined ? (
        <div style={{ padding: 24 }}><Spinner label="Loading your Notion pages" /></div>
      ) : (
        <>
          {pages.length > 0 && (
            <div role="radiogroup" aria-label="Notion page" style={{ margin: '18px 16px 0', borderRadius: 16, background: '#FFFFFF', border: '1px solid #E8E8EB', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {pages.map((p, i) => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderBottom: i < pages.length - 1 ? '1px solid #F0F0F2' : 'none', cursor: 'pointer' }}>
                  <input type="radio" name="np" checked={chosen === p.id} onChange={() => setChosen(p.id)} style={{ width: 18, height: 18, margin: 0, accentColor: '#4F46E5' }} />
                  <span style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 14, fontWeight: chosen === p.id ? 600 : 500, overflowWrap: 'anywhere' }}>{p.title}</span>
                    {p.parent && <span style={{ fontSize: 12, color: '#6E7079' }}>{p.parent}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
          {pages.length === 0 && !error && (
            <p style={{ margin: '18px 24px 0', padding: '12px 14px', borderRadius: 12, background: '#EDEDF0', fontSize: 13, lineHeight: 1.5, color: '#44464D' }}>
              Rekord can’t see any pages yet. In Notion, open a page, choose <b>···</b> then <b>Connections</b>, and add Rekord.
            </p>
          )}
          {error && (
            <div role="alert" style={{ margin: '12px 24px 0', padding: '12px 14px', borderRadius: 12, background: '#FFF8EC', border: '1px solid #F5DDB0', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ flexGrow: 1, fontSize: 13, lineHeight: 1.45, color: '#5C3200' }}>{error}</span>
              <button type="button" onClick={() => setAttempt((n) => n + 1)} style={{ height: 32, padding: '0 12px', border: '1px solid #F5DDB0', borderRadius: 9, background: '#FFFFFF', font: 'inherit', fontSize: 12, fontWeight: 600, color: '#5C3200', cursor: 'pointer' }}>Try again</button>
            </div>
          )}
          <p style={{ margin: '12px 24px 0', fontSize: 12, lineHeight: 1.5, color: '#6E7079' }}>
            Only the pages you allowed in Notion appear here. Missing one?{' '}
            <ExternalLink href={NOTION_ADD_CONNECTIONS_URL} style={{ textDecoration: 'none', fontWeight: 500 }}>Allow more pages</ExternalLink>
          </p>
        </>
      )}

      <div style={{ flexGrow: 1 }} />
      <div style={{ padding: 24 }}>
        <button
          type="button" onClick={() => void use()} disabled={!picked || busy} aria-busy={busy || undefined}
          style={{ width: '100%', height: 48, border: 'none', borderRadius: 12, background: '#111114', color: '#FFFFFF', font: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer', opacity: !picked || busy ? 0.5 : 1 }}
        >
          {picked ? `Use “${picked.title}”` : 'Use this page'}
        </button>
      </div>
    </main>
  );
}
