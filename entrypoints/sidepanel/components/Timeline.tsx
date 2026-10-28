import { formatClock } from '@/lib/time';
import type { TimelineItem } from '@/lib/live';
import { Tag } from './Tag';

/** Transcript lines with notes and markers shown inline at the moment they were added. */
export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <>
      {items.map((it) => {
        if (it.kind === 'segment') {
          const you = it.segment.speaker === 'you';
          const name = you ? 'You' : 'Others';
          return (
            <div className="tl-row" key={it.id}>
              <span className={`tl-avatar ${you ? 'you' : 'others'}`} aria-hidden="true">{name[0]}</span>
              <div className="tl-body">
                <span className="tl-meta"><strong>{name}</strong> · {formatClock(it.atMs)}</span>
                <span className="tl-text">{it.segment.text}</span>
              </div>
            </div>
          );
        }
        if (it.kind === 'marker') {
          return (
            <div className="tl-inline" key={it.id}>
              <Tag kind={it.marker.kind} />
              <span className="tl-meta">{formatClock(it.atMs)}</span>
            </div>
          );
        }
        return (
          <div className="tl-inline tl-note" key={it.id}>
            <span className="tl-meta">Note · {formatClock(it.atMs)}</span>
            <span className="tl-text">{it.note.text}</span>
          </div>
        );
      })}
    </>
  );
}
