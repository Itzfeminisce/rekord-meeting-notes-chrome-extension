import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Spinner } from '../components';
import { useRouter } from '../router';
import { getMeeting, listRecordingParts, listSegments, getRecordingMeta } from '@/lib/db';
import { displayName, saveSpeakerNames, skipSpeakers, speakerStats, toRecordingMs, type SpeakerStats } from '@/lib/speakers';
import type { Meeting, RecordingMeta, Segment } from '@/lib/types';

const COLORS: [string, string][] = [['#E3E2FF', '#3730A3'], ['#FDE7D7', '#8A4B00'], ['#DDF3E6', '#1A6B40'], ['#FCE1EC', '#9B1C4D'], ['#E0F0FA', '#0B5C8A']];
const SAMPLE_MS = 8000;

const card: CSSProperties = { padding: 14, borderRadius: 18, background: '#FFFFFF', border: '1px solid #E8E8EB', display: 'flex', flexDirection: 'column', gap: 12 };
const input: CSSProperties = { height: 42, boxSizing: 'border-box', padding: '0 12px', border: '1px solid #DCDCE0', borderRadius: 10, background: '#F9F9FA', font: 'inherit', fontSize: 14, color: '#111114' };
const small: CSSProperties = { fontSize: 12, color: '#6E7079' };

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function talk(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  return `Spoke for ${min} min`;
}
function excerpt(t: string, n = 60): string {
  const x = t.trim().replace(/\s+/g, ' ');
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
}

interface Data { meeting: Meeting; segments: Segment[]; hasAudio: boolean; recMeta?: RecordingMeta }

export default function Speakers() {
  const { route, replace, back } = useRouter();
  const meetingId = route.params.meetingId;
  const [data, setData] = useState<Data | undefined>();
  const [failed, setFailed] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const [merges, setMerges] = useState<Record<string, string>>({});
  const [mergeOpen, setMergeOpen] = useState(false);
  const [pick, setPick] = useState<[string, string]>(['', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState('');
  const [audioError, setAudioError] = useState('');
  const audioRef = useRef<{ el: HTMLAudioElement; url: string; timer?: ReturnType<typeof setTimeout> } | null>(null);

  const stopAudio = () => {
    const a = audioRef.current;
    if (!a) return;
    clearTimeout(a.timer);
    a.el.pause();
    URL.revokeObjectURL(a.url);
    audioRef.current = null;
    setPlaying('');
  };
  useEffect(() => stopAudio, []);

  useEffect(() => {
    if (!meetingId) { setFailed(true); return; }
    (async () => {
      try {
        const [meeting, segments, parts, recMeta] = await Promise.all([getMeeting(meetingId), listSegments(meetingId), listRecordingParts(meetingId), getRecordingMeta(meetingId)]);
        if (!meeting) throw new Error('missing');
        const seed: Record<string, string> = {};
        for (const [l, v] of Object.entries(meeting.speakers ?? {})) seed[l] = v.name ?? v.suggested ?? '';
        setNames(seed);
        setData({ meeting, segments, hasAudio: parts.length > 0, recMeta });
      } catch {
        setFailed(true);
      }
    })();
  }, [meetingId]);

  const root = (l: string): string => { let x = l; for (let i = 0; i < 26 && merges[x]; i++) x = merges[x]!; return x; };

  const cards = useMemo<SpeakerStats[]>(() => {
    if (!data) return [];
    const merged = new Map<string, SpeakerStats>();
    for (const st of speakerStats(data.segments)) {
      const r = root(st.label);
      const cur = merged.get(r);
      if (!cur) { merged.set(r, { ...st, label: r }); continue; }
      cur.talkMs += st.talkMs;
      cur.lines += st.lines;
      if (st.quote && (!cur.quote || st.quote.text.length > cur.quote.text.length)) cur.quote = st.quote;
    }
    return [...merged.values()].sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, merges]);

  async function play(st: SpeakerStats) {
    if (!meetingId || !st.quote) return;
    if (playing === st.label) return stopAudio();
    stopAudio();
    setAudioError('');
    try {
      const parts = await listRecordingParts(meetingId);
      if (!parts.length) throw new Error('none');
      const url = URL.createObjectURL(new Blob(parts.map((p) => p.blob), { type: parts[0]?.mimeType }));
      const el = new Audio(url);
      const at = toRecordingMs(st.quote.startMs, data?.recMeta?.pauses) / 1000;
      el.addEventListener('loadedmetadata', () => { el.currentTime = at; }, { once: true });
      el.addEventListener('ended', stopAudio);
      audioRef.current = { el, url };
      setPlaying(st.label);
      await el.play();
      if (audioRef.current?.el === el) audioRef.current.timer = setTimeout(stopAudio, SAMPLE_MS);
    } catch {
      stopAudio();
      setAudioError('Couldn’t play that sample.');
    }
  }

  async function finish(action: 'save' | 'skip') {
    if (!meetingId || busy) return;
    stopAudio();
    setBusy(true);
    setError('');
    try {
      if (action === 'save') await saveSpeakerNames(meetingId, { names, merges });
      else await skipSpeakers(meetingId);
      replace('summary', { meetingId });
    } catch {
      setError('Couldn’t save the names. Try again.');
      setBusy(false);
    }
  }

  function evidence(label: string): string | undefined {
    const sp = data?.meeting.speakers?.[label];
    if (!sp?.suggested || sp.evidenceMs === undefined || !data) return undefined;
    const seg = data.segments.reduce<Segment | undefined>((best, g) => (!best || Math.abs(g.startMs - sp.evidenceMs!) < Math.abs(best.startMs - sp.evidenceMs!) ? g : best), undefined);
    if (!seg) return undefined;
    const who = seg.speaker === 'you' ? 'you' : displayName(seg, undefined);
    return `Suggested: ${who} said “${excerpt(seg.text)}” at ${clock(sp.evidenceMs)}`;
  }

  const header = (
    <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
      <button type="button" className="perm-back" aria-label="Back to summary" onClick={back}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      </button>
      <span style={{ flexGrow: 1 }} />
      <span style={small}>{data?.meeting.title || ''}</span>
    </header>
  );

  if (failed) {
    return (
      <main className="screen">
        {header}
        <div className="perm-error" role="alert">Rekord couldn’t load this meeting. Go back and try again.</div>
      </main>
    );
  }
  if (!data) {
    return <main className="screen">{header}<div className="set-loading"><Spinner label="Loading speakers" /></div></main>;
  }

  const n = cards.length;
  const labels = cards.map((c) => c.label);

  return (
    <main className="screen">
      {header}
      <div style={{ padding: '12px 20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1.2, fontWeight: 600, letterSpacing: '-0.02em' }}>Who was in the call?</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: '#5F6168' }}>
          {n === 1 ? 'Rekord heard 1 other voice.' : `Rekord heard ${n} other voices.`} Check the names it suggests, then they’ll replace “Others” across the transcript and summary.
        </p>
      </div>

      <div style={{ flexGrow: 1, overflowY: 'auto', padding: '18px 12px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {n === 0 && <p style={{ ...small, padding: '0 8px' }}>No other voices were found in this meeting.</p>}
        {cards.map((st, i) => {
          const [bg, fg] = COLORS[i % COLORS.length]!;
          const ev = evidence(st.label);
          const mergedIn = Object.keys(merges).filter((k) => root(k) === st.label);
          return (
            <section key={st.label} style={card} aria-label={`Speaker ${st.label}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: '50%', background: bg, color: fg, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{st.label}</span>
                <span style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>Speaker {st.label}</span>
                  <span style={small}>{talk(st.talkMs)} · {st.lines === 1 ? '1 line' : `${st.lines} lines`}{mergedIn.length ? ` · includes ${mergedIn.map((k) => `Speaker ${k}`).join(', ')}` : ''}</span>
                </span>
                {data.hasAudio && st.quote && (
                  <button
                    type="button"
                    aria-label={playing === st.label ? `Stop the sample of Speaker ${st.label}` : `Play a sample of Speaker ${st.label}`}
                    onClick={() => void play(st)}
                    style={{ width: 36, height: 36, border: 'none', borderRadius: '50%', background: '#F1F1F3', color: '#111114', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                  >
                    {playing === st.label ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>
                    )}
                  </button>
                )}
              </div>
              {st.quote && <p style={{ margin: 0, padding: '10px 12px', borderRadius: 10, background: '#F6F6F7', fontSize: 13, lineHeight: 1.45, color: '#2A2B31' }}>“{excerpt(st.quote.text, 160)}”</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor={`name-${st.label}`} style={{ fontSize: 12, fontWeight: 500, color: '#44464D' }}>Name</label>
                <input
                  id={`name-${st.label}`}
                  type="text"
                  style={input}
                  value={names[st.label] ?? ''}
                  placeholder={`Add a name, or leave as Speaker ${st.label}`}
                  onChange={(e) => setNames((p) => ({ ...p, [st.label]: e.target.value }))}
                  autoComplete="off"
                />
                {ev ? (
                  <span style={{ fontSize: 12, color: '#4F46E5', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>
                    {ev}
                  </span>
                ) : (
                  <span style={small}>No name came up in the conversation.</span>
                )}
              </div>
            </section>
          );
        })}

        {audioError && <span role="status" style={small}>{audioError}</span>}

        {n > 1 && !mergeOpen && (
          <button
            type="button"
            onClick={() => { setPick([labels[0] ?? '', labels[1] ?? '']); setMergeOpen(true); }}
            style={{ alignSelf: 'flex-start', height: 34, padding: '0 10px', border: 'none', borderRadius: 9, background: 'transparent', font: 'inherit', fontSize: 13, fontWeight: 500, color: '#4F46E5', cursor: 'pointer' }}
          >
            These are the same person
          </button>
        )}
        {n > 1 && mergeOpen && (
          <div style={{ ...card, gap: 10 }} role="group" aria-label="Merge two speakers">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select aria-label="First speaker" value={pick[0]} onChange={(e) => setPick([e.target.value, pick[1]])} style={{ ...input, height: 36, fontSize: 13 }}>
                {labels.map((l) => <option key={l} value={l}>Speaker {l}</option>)}
              </select>
              <span style={small}>and</span>
              <select aria-label="Second speaker" value={pick[1]} onChange={(e) => setPick([pick[0], e.target.value])} style={{ ...input, height: 36, fontSize: 13 }}>
                {labels.map((l) => <option key={l} value={l}>Speaker {l}</option>)}
              </select>
              <span style={small}>are the same person</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                disabled={!pick[0] || !pick[1] || pick[0] === pick[1]}
                onClick={() => {
                  const [into, from] = pick[0] < pick[1] ? [pick[0], pick[1]] : [pick[1], pick[0]];
                  setMerges((m) => ({ ...m, [from]: into }));
                  setMergeOpen(false);
                }}
                style={{ height: 34, padding: '0 12px', border: 'none', borderRadius: 9, background: '#111114', color: '#fff', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                Merge
              </button>
              <button type="button" onClick={() => setMergeOpen(false)} style={{ height: 34, padding: '0 12px', border: '1px solid #E8E8EB', borderRadius: 9, background: '#fff', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}
        {error && <div className="perm-error" role="alert">{error}</div>}
      </div>

      <footer style={{ padding: 12, display: 'flex', gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => void finish('skip')} style={{ height: 46, padding: '0 16px', borderRadius: 12, background: '#FFFFFF', border: '1px solid #E8E8EB', color: '#111114', font: 'inherit', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>Skip</button>
        <button type="button" disabled={busy} onClick={() => void finish('save')} style={{ flexGrow: 1, height: 46, borderRadius: 12, background: '#111114', color: '#FFFFFF', border: 'none', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          {busy ? 'Saving…' : 'Save names'}
        </button>
      </footer>
    </main>
  );
}
