import { useEffect, useState } from 'react';
import { Button, Spinner } from '../components';
import { useRouter } from '../router';
import { getMeeting, listMarkers, listNotes, listSegments } from '@/lib/db';
import { DEFAULT_OPTIONS, fileName, printUrl, toMailto, toMarkdown, type ExportOptions } from '@/lib/export';
import type { Marker, Meeting, Note, Segment } from '@/lib/types';

const CHOICES: { key: keyof ExportOptions; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'actions', label: 'Action items' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'notes', label: 'My notes' },
];

const icon = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export default function Export() {
  const { route, back, replace } = useRouter();
  const meetingId = route.params.meetingId;
  const [meeting, setMeeting] = useState<Meeting | undefined>(undefined);
  const [data, setData] = useState<{ segments: Segment[]; notes: Note[]; markers: Marker[] }>({ segments: [], notes: [], markers: [] });
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_OPTIONS);
  const [choosing, setChoosing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!meetingId) { setState('missing'); return; }
    let alive = true;
    Promise.all([getMeeting(meetingId), listSegments(meetingId), listNotes(meetingId), listMarkers(meetingId)])
      .then(([m, segments, notes, markers]) => {
        if (!alive) return;
        setMeeting(m); setData({ segments, notes, markers }); setState(m ? 'ready' : 'missing');
      })
      .catch(() => alive && setState('missing'));
    return () => { alive = false; };
  }, [meetingId]);

  const close = () => { if (meetingId) replace('summary', { meetingId }); else back(); };

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

  const markdown = () => toMarkdown(meeting, data.segments, data.notes, data.markers, opts);
  const nothing = !Object.values(opts).some(Boolean);
  const note = (m: string) => { setError(''); setMessage(m); };
  const fail = (m: string) => { setMessage(''); setError(m); };

  const copy = async () => {
    if (nothing) return fail('Choose at least one thing to include.');
    try {
      await navigator.clipboard.writeText(markdown());
      note('Copied to your clipboard.');
    } catch {
      fail('Could not copy. Try Download instead.');
    }
  };

  const downloadMd = () => {
    if (nothing) return fail('Choose at least one thing to include.');
    const url = URL.createObjectURL(new Blob([markdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = fileName(meeting);
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    note('Markdown file downloaded.');
  };

  const downloadPdf = async () => {
    if (nothing) return fail('Choose at least one thing to include.');
    try {
      await browser.tabs.create({ url: (browser.runtime.getURL as (p: string) => string)(`/${printUrl(meetingId, opts)}`) });
      note('Choose Save as PDF in the print window.');
    } catch {
      fail('Could not open the print page.');
    }
  };

  const email = () => {
    if (nothing) return fail('Choose at least one thing to include.');
    const { href, shortened } = toMailto(meeting);
    window.open(href, '_blank');
    note(shortened ? 'Opened your mail app. The email was shortened to fit.' : 'Opened your mail app.');
  };

  return (
    <main className="screen exp" aria-live="polite">
      <div className="exp-backdrop" onClick={close} aria-hidden="true" />
      <div className="exp-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <span className="exp-grab" aria-hidden="true" />
        <div className="exp-head">
          <h1 id="sheet-title">Share this meeting</h1>
          <button type="button" className="exp-close" aria-label="Close" onClick={close}>
            <svg {...icon} strokeWidth={2.2}><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <fieldset className="exp-inc">
          <legend>Include</legend>
          <div className="exp-grid">
            {CHOICES.map((c) => (
              <label key={c.key} className="exp-check">
                <input type="checkbox" checked={opts[c.key]} onChange={(e) => setOpts({ ...opts, [c.key]: e.target.checked })} />{c.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="exp-send">
          <span className="exp-label">Send to</span>
          <button type="button" className="exp-row" onClick={() => void copy()}>
            <span className="exp-ico"><svg {...icon}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M4 16V6a2 2 0 0 1 2-2h10" /></svg></span>
            <span className="exp-text"><span className="exp-name">Copy as Markdown</span><span className="exp-sub">Paste into Slack, Notion or a doc</span></span>
          </button>
          <button type="button" className="exp-row" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>
            <span className="exp-ico"><svg {...icon}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg></span>
            <span className="exp-text"><span className="exp-name">Download</span><span className="exp-sub">Markdown or PDF</span></span>
          </button>
          {choosing && (
            <div className="exp-choose">
              <button type="button" className="exp-pill" onClick={downloadMd}>Markdown</button>
              <button type="button" className="exp-pill" onClick={() => void downloadPdf()}>PDF</button>
            </div>
          )}
          <button type="button" className="exp-row" onClick={email}>
            <span className="exp-ico"><svg {...icon}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg></span>
            <span className="exp-text"><span className="exp-name">Email draft</span><span className="exp-sub">Opens in your mail app</span></span>
          </button>
        </div>

        {error && <p className="perm-error exp-msg" role="alert">{error}</p>}
        {message && <p className="exp-ok" role="status">{message}</p>}
        <button type="button" className="exp-copy" onClick={() => void copy()}>Copy to clipboard</button>
      </div>
    </main>
  );
}
