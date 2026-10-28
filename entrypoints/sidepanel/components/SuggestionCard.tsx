import { useId, useState } from 'react';
import { formatClock } from '@/lib/time';
import type { Marker } from '@/lib/types';

interface Props {
  marker: Marker;
  onAccept: (edits: { label: string }) => void;
  onDismiss: () => void;
}

/** A suggested action item shown under its moment in the live transcript. */
export function SuggestionCard({ marker, onAccept, onDismiss }: Props) {
  const id = useId();
  const [text, setText] = useState(marker.label ?? '');
  const meta = [marker.owner && `Owner: ${marker.owner}`, marker.due && `Due: ${marker.due}`].filter(Boolean).join(' · ');
  return (
    <div role="group" aria-label="Suggested action" className="sg-card">
      <div className="sg-head">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" /></svg>
        <span className="sg-title">Looks like an action item</span>
        <span className="sg-time">{formatClock(marker.atMs)}</span>
      </div>
      <div className="sg-fields">
        <label htmlFor={id} className="sr-only">Action item</label>
        <input id={id} type="text" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        {meta && <span className="sg-meta">{meta}</span>}
      </div>
      <div className="sg-actions">
        <button type="button" className="sg-add" disabled={!text.trim()} onClick={() => onAccept({ label: text })}>Add to actions</button>
        <button type="button" className="sg-dismiss" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
