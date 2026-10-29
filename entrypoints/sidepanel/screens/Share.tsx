import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Spinner } from '../components';
import { useRouter } from '../router';
import { getMeeting, listMarkers, listNotes, listSegments } from '@/lib/db';
import { DEFAULT_OPTIONS, type ExportOptions } from '@/lib/export';
import { getSettings } from '@/lib/settings';
import { GoogleError, type GoogleDeps } from '@/lib/google';
import { gdocsShare, shareLink, shareToDocs } from '@/lib/share/gdocs';
import { toHtml } from '@/lib/share/render';
import { loadKeys } from '@/lib/keys';
import { NOTION_HOSTS, requestHosts } from '@/lib/hosts';
import { buildBlocks, NotionError, notionShare, shareToNotion } from '@/lib/share/notion';
import { notionDeps } from './NotionConnect';
import type { Marker, Meeting, Note, Segment } from '@/lib/types';

/** Test hook: lets tests inject chrome.identity and fetch. */
export const shareDeps: { current?: GoogleDeps } = {};

type Action = 'save' | 'link' | 'notion';
/** What the user was doing when they left for Connect Google; it continues when they come back connected. */
let pending: { meetingId: string; action: Action; opts: ExportOptions } | undefined;

/** A pending share continues only if the user actually connected while away (Back / Not now must not loop). */
export function canResumeShare(action: Action, c: { googleDocs: boolean; notionToken?: string; notionPageId?: string }): boolean {
  return action === 'notion' ? Boolean(c.notionToken) && Boolean(c.notionPageId) : c.googleDocs;
}

const CHOICES: { key: keyof ExportOptions; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'actions', label: 'Action items' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'notes', label: 'My notes' },
];

const FAILED = 'Couldn’t save to Google Docs. Check your connection and try again.';
const NOTION_FAILED = 'Couldn’t save to Notion. Check your connection and try again.';
const icon = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

const s = {
  sheetWrap: { flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: '#6B6C73', minHeight: 0 },
  backdrop: { flexGrow: 1, border: 0, background: 'transparent', padding: 0, cursor: 'default' },
  sheet: { padding: '10px 16px 20px', borderRadius: '24px 24px 0 0', background: '#FFFFFF', display: 'flex', flexDirection: 'column', gap: 16, color: '#111114' },
  grab: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, background: '#DCDCE0' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em' },
  close: { width: 36, height: 36, borderRadius: '50%', border: 0, background: '#F1F1F3', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#111114', cursor: 'pointer' },
  fieldset: { margin: 0, padding: 0, border: 'none', display: 'flex', flexDirection: 'column', gap: 8 },
  legend: { padding: '0 0 8px', fontSize: 12, fontWeight: 600, color: '#6E7079' },
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', borderRadius: 999, background: '#F6F6F7', fontSize: 13, fontWeight: 500, cursor: 'pointer' },
  check: { width: 16, height: 16, margin: 0, accentColor: '#4F46E5' },
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { padding: '0 0 6px', fontSize: 12, fontWeight: 600, color: '#6E7079' },
  saved: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 12, background: '#EAF6EF' },
  savedIco: { width: 36, height: 36, borderRadius: 10, background: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  open: { height: 32, padding: '0 10px', borderRadius: 8, background: '#FFFFFF', color: '#134E2F', fontSize: 12, fontWeight: 600, textDecoration: 'none', display: 'flex', alignItems: 'center' },
  row: { display: 'flex', alignItems: 'center', gap: 12, height: 56, padding: '0 12px', border: 'none', borderRadius: 12, background: 'transparent', font: 'inherit', color: '#111114', textAlign: 'left', cursor: 'pointer' },
  ico: { width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  text: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  name: { fontSize: 14, fontWeight: 500 },
  sub: { fontSize: 12, color: '#6E7079' },
  note: { margin: 0, fontSize: 12, lineHeight: 1.45, color: '#6E7079' },
  busy: { padding: '12px 14px', borderRadius: 14, background: '#EEF0FF', border: '1px solid #D9D7FB', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 500, color: '#2E2A8A' },
  fail: { padding: '12px 14px', borderRadius: 14, background: '#FDECEC', border: '1px solid #F2C9C7', display: 'flex', alignItems: 'center', gap: 10 },
  failText: { flexGrow: 1, fontSize: 13, lineHeight: 1.45, color: '#8A1C14' },
  retry: { height: 32, padding: '0 12px', border: '1px solid #F2C9C7', borderRadius: 9, background: '#FFFFFF', font: 'inherit', fontSize: 12, fontWeight: 600, color: '#8A1C14', cursor: 'pointer' },
  copied: { padding: '0 4px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: '#1A6B40' },
} satisfies Record<string, CSSProperties>;

export default function Share() {
  const { route, replace, navigate } = useRouter();
  const meetingId = route.params.meetingId;
  const [meeting, setMeeting] = useState<Meeting | undefined>(undefined);
  const [data, setData] = useState<{ segments: Segment[]; notes: Note[]; markers: Marker[] }>({ segments: [], notes: [], markers: [] });
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const [retry, setRetry] = useState<Action>('save');
  const [copied, setCopied] = useState(false);
  const resumed = useRef(false);

  const close = () => { if (meetingId) replace('summary', { meetingId }); else replace('start'); };

  async function run(action: Action, m: Meeting, d: typeof data, o: ExportOptions) {
    if (busy) return;
    setRetry(action); setFailed(''); setCopied(false);
    if (!Object.values(o).some(Boolean)) { setFailed('Choose at least one thing to include.'); return; }
    if (action === 'notion') { await runNotion(m, d, o); return; }
    let connected = false;
    try { connected = (await getSettings()).google.docs; } catch { /* treated as not connected */ }
    if (!connected) {
      pending = { meetingId: m.id, action, opts: o };
      navigate('googleConnect');
      return;
    }
    setBusy(true);
    try {
      const html = toHtml(m, d.segments, d.notes, d.markers, o);
      const result = action === 'link' ? await shareLink(m, html, shareDeps.current) : await shareToDocs(m, html, {}, shareDeps.current);
      setMeeting(result.meeting);
      if (action === 'link') {
        try { await navigator.clipboard.writeText(result.record.url); setCopied(true); }
        catch { setFailed('Could not copy. Open the doc and copy its link instead.'); }
      }
    } catch (err) {
      setFailed(err instanceof GoogleError && (err.code === 'auth' || err.code === 'not-configured') ? err.message : FAILED);
    } finally {
      setBusy(false);
    }
  }

  async function runNotion(m: Meeting, d: typeof data, o: ExportOptions) {
    let token: string | undefined; let pageId: string | undefined;
    try { token = (await loadKeys()).NOTION_TOKEN; pageId = (await getSettings()).notion.pageId; } catch { /* treated as not connected */ }
    if (!token || !pageId) {
      pending = { meetingId: m.id, action: 'notion', opts: o };
      navigate(token ? 'notionPage' : 'notionConnect');
      return;
    }
    setBusy(true);
    try {
      const result = await shareToNotion(token, pageId, m, buildBlocks(m, d.segments, d.notes, d.markers, o), notionDeps.current);
      setMeeting(result.meeting);
    } catch (err) {
      setFailed(err instanceof NotionError && (err.code === 'auth' || err.code === 'no-access') ? err.message : NOTION_FAILED);
    } finally {
      setBusy(false);
    }
  }

  /** Back from connecting: continue only if the user finished connecting; otherwise just show Share. */
  async function resumePending(p: { action: Action; opts: ExportOptions }, m: Meeting, d: typeof data) {
    try {
      const st = await getSettings();
      const notionToken = p.action === 'notion' ? (await loadKeys()).NOTION_TOKEN : undefined;
      if (canResumeShare(p.action, { googleDocs: st.google.docs, notionToken, notionPageId: st.notion.pageId })) await run(p.action, m, d, p.opts);
    } catch { /* stay on the sheet */ }
  }

  useEffect(() => {
    if (!meetingId) { setState('missing'); return; }
    let alive = true;
    Promise.all([getMeeting(meetingId), listSegments(meetingId), listNotes(meetingId), listMarkers(meetingId)])
      .then(([m, segments, notes, markers]) => {
        if (!alive) return;
        const d = { segments, notes, markers };
        setMeeting(m); setData(d); setState(m ? 'ready' : 'missing');
        if (m && pending?.meetingId === m.id && !resumed.current) {
          resumed.current = true;
          const p = pending; pending = undefined;
          setOpts(p.opts);
          void resumePending(p, m, d);
        }
      })
      .catch(() => alive && setState('missing'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  if (state === 'loading') return <main className="screen screen-center"><Spinner label="Loading" /></main>;
  if (state === 'missing' || !meeting || !meetingId) {
    return (
      <main className="screen screen-center sum-missing">
        <h1 className="empty-title">Meeting not found</h1>
        <p className="empty-body">This meeting is no longer on this computer.</p>
        <Button variant="secondary" onClick={() => replace('start')}>Back to home</Button>
      </main>
    );
  }

  const doc = gdocsShare(meeting);
  const notion = notionShare(meeting);

  return (
    <main className="screen" style={s.sheetWrap}>
      <button type="button" style={s.backdrop} aria-label="Close" tabIndex={-1} onClick={close} />
      <div role="dialog" aria-modal="true" aria-labelledby="sh-title" style={s.sheet}>
        <span style={s.grab} aria-hidden="true" />
        <div style={s.head}>
          <h1 id="sh-title" style={s.title}>Share this meeting</h1>
          <button type="button" style={s.close} aria-label="Close" onClick={close}>
            <svg {...icon} stroke="currentColor" strokeWidth={2.2}><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <fieldset style={s.fieldset}>
          <legend style={s.legend}>Include</legend>
          <div style={s.chips}>
            {CHOICES.map((c) => (
              <label key={c.key} style={s.chip}>
                <input type="checkbox" style={s.check} checked={opts[c.key]} onChange={(e) => setOpts({ ...opts, [c.key]: e.target.checked })} />{c.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div style={s.list}>
          <span style={s.label}>Send to</span>
          {doc ? (
            <div style={s.saved}>
              <span style={s.savedIco}>
                <svg {...icon} stroke="#1A6B40"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>
              </span>
              <span style={s.text}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#134E2F' }}>Saved to Google Docs</span>
                <span style={{ fontSize: 12, color: '#1A6B40' }}>{meeting.title} · in “Rekord” folder</span>
              </span>
              <a href={doc.url} target="_blank" rel="noreferrer" style={s.open}>Open</a>
            </div>
          ) : (
            <button type="button" style={s.row} disabled={busy} onClick={() => void run('save', meeting, data, opts)}>
              <span style={{ ...s.ico, background: '#EAF6EF' }}>
                <svg {...icon} stroke="#1A6B40"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></svg>
              </span>
              <span style={s.text}><span style={s.name}>Google Docs</span><span style={s.sub}>Save this meeting as a doc in your Drive</span></span>
            </button>
          )}
          <button type="button" style={s.row} disabled={busy} onClick={() => void run('link', meeting, data, opts)}>
            <span style={{ ...s.ico, background: '#EEF0FF' }}>
              <svg {...icon} stroke="#4F46E5"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
            </span>
            <span style={s.text}><span style={s.name}>Copy view-only link</span><span style={s.sub}>Anyone with the link can read it, but not edit</span></span>
          </button>
          {notion ? (
            <div style={s.saved}>
              <span style={{ ...s.savedIco, fontFamily: "'Geist Mono', monospace", fontSize: 13, fontWeight: 600, color: '#1A6B40' }}>N</span>
              <span style={s.text}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#134E2F' }}>Saved to Notion</span>
                <span style={{ fontSize: 12, color: '#1A6B40' }}>{meeting.title}</span>
              </span>
              <a href={notion.url} target="_blank" rel="noreferrer" style={s.open}>Open</a>
            </div>
          ) : (
            <button type="button" style={s.row} data-share="notion" disabled={busy} onClick={() => void requestHosts(NOTION_HOSTS).then(() => run('notion', meeting, data, opts))}>
              <span style={{ ...s.ico, background: '#F1F1F3', fontFamily: "'Geist Mono', monospace", fontSize: 13, fontWeight: 600 }}>N</span>
              <span style={s.text}><span style={s.name}>Notion</span><span style={s.sub}>Connect Notion to add meetings as pages</span></span>
            </button>
          )}
          <button type="button" style={s.row} onClick={() => navigate('export', { meetingId })}>
            <span style={{ ...s.ico, background: '#F1F1F3' }}>
              <svg {...icon} stroke="#44464D"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </span>
            <span style={s.text}><span style={s.name}>More: copy, download, email</span><span style={s.sub}>Markdown, PDF or an email draft</span></span>
          </button>
        </div>

        {busy && (
          <div role="status" style={s.busy}>
            <span className="spinner" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }} />
            <span>{retry === 'notion' ? 'Saving to Notion…' : 'Saving to Google Docs…'}</span>
          </div>
        )}
        {failed && (
          <div role="alert" style={s.fail}>
            <span style={s.failText}>{failed}</span>
            {failed === FAILED || failed === NOTION_FAILED || failed.startsWith('Rekord can') || failed.startsWith('Google sign-in') ? (
              <button type="button" style={s.retry} onClick={() => void run(retry, meeting, data, opts)}>Try again</button>
            ) : null}
          </div>
        )}
        {copied && (
          <span role="status" style={s.copied}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>Link copied. Anyone with it can read this meeting.
          </span>
        )}
        <p style={s.note}>Only the parts you tick are shared. Everything else stays on this computer.</p>
      </div>
    </main>
  );
}
