import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { getMeeting, listMarkers, listNotes, listSegments } from '@/lib/db';
import { buildTimeline, type TimelineItem } from '@/lib/live';
import { itemText, matchIds, splitMatches, transcriptToText } from '@/lib/library';
import { formatClock, formatDuration } from '@/lib/time';
import type { Meeting } from '@/lib/types';
import { Button, EmptyState, Spinner, Tag } from '../components';
import { useRouter } from '../router';

type Data = { meeting?: Meeting; items: TimelineItem[] };

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitMatches(text, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}

export default function Transcript() {
  const { route, navigate, back } = useRouter();
  const meetingId = route.params.meetingId;
  const [data, setData] = useState<Data | undefined>();
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const load = async () => {
    if (!meetingId) { setError(true); return; }
    setError(false);
    setData(undefined);
    try {
      const [meeting, segments, notes, markers] = await Promise.all([
        getMeeting(meetingId), listSegments(meetingId), listNotes(meetingId), listMarkers(meetingId),
      ]);
      setData({ meeting, items: buildTimeline(segments, notes, markers) });
    } catch {
      setError(true);
    }
  };
  useEffect(() => { void load(); }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const ids = useMemo(() => matchIds(data?.items ?? [], query), [data, query]);
  useEffect(() => setCurrent(0), [query]);
  const currentId = ids.length ? ids[Math.min(current, ids.length - 1)] : undefined;
  useEffect(() => {
    if (currentId) rowRefs.current[currentId]?.scrollIntoView?.({ block: 'center' });
  }, [currentId]);

  const step = (d: number) => ids.length && setCurrent((c) => (c + d + ids.length) % ids.length);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToText(data?.items ?? []));
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
    setTimeout(() => setCopied(null), 2000);
  };

  const meeting = data?.meeting;
  const sub = meeting
    ? `${meeting.title || 'Untitled meeting'}${meeting.endedAt !== undefined ? ` · ${formatDuration(meeting.endedAt - meeting.startedAt)}` : ''}`
    : '';

  return (
    <main className="screen tr">
      <header className="lib-head">
        <button type="button" className="icon-btn" aria-label="Back to summary" onClick={back}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div className="tr-title"><span>Transcript</span><small>{sub}</small></div>
      </header>

      <div className="tr-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6E7079" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <label htmlFor="find" className="sr-only">Find in transcript</label>
        <input
          id="find" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }}
        />
        {query.trim() && <span className="tr-count" aria-live="polite">{ids.length ? `${Math.min(current, ids.length - 1) + 1} of ${ids.length}` : 'No matches'}</span>}
      </div>

      {error ? (
        <EmptyState title="Couldn’t load the transcript" action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
      ) : data === undefined ? (
        <div className="lib-wait"><Spinner label="Loading transcript" /></div>
      ) : data.items.length === 0 ? (
        <EmptyState title="Nothing was transcribed" body="This meeting has no transcript yet." />
      ) : (
        <section className="tr-list" aria-label="Transcript">
          {data.items.map((it) => {
            const on = it.id === currentId;
            const hit = ids.includes(it.id);
            const cls = `tr-row${it.kind === 'note' ? ' tr-note' : ''}${hit ? ' tr-hit' : ''}${on ? ' tr-on' : ''}`;
            const clock = <span className="tr-clock">{formatClock(it.atMs)}</span>;
            if (it.kind === 'marker') {
              return (
                <div className={cls} key={it.id}>
                  {clock}
                  <div className="tr-body"><Tag kind={it.marker.kind} />{it.marker.label && <span className="tr-text">{it.marker.label}</span>}</div>
                </div>
              );
            }
            const who = it.kind === 'note' ? 'Your note' : it.segment.speaker === 'you' ? 'You' : 'Others';
            return (
              <div className={cls} key={it.id} ref={(el) => { rowRefs.current[it.id] = el; }}>
                {clock}
                <div className="tr-body">
                  <span className={`tr-who${who === 'You' ? '' : ' alt'}`}>{who}</span>
                  <span className="tr-text"><Marked text={itemText(it)} query={query} /></span>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <footer className="tr-foot">
        <Button variant="secondary" className="tr-btn" onClick={() => void copyAll()} disabled={!data?.items.length}>
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Couldn’t copy' : 'Copy all'}
        </Button>
        <Button className="tr-btn" onClick={() => navigate('export', { meetingId })} disabled={!meetingId}>Export</Button>
      </footer>
    </main>
  );
}
