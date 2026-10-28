import type { MarkerKind } from '@/lib/types';

export const MARKER_LABELS: Record<MarkerKind, string> = {
  decision: 'Decision',
  action: 'Action',
  question: 'Question',
  bookmark: 'Bookmark',
};

/** Pill for a marker kind. `onDark` for use on the dark ink surfaces. */
export function Tag({ kind, onDark, children }: { kind: MarkerKind; onDark?: boolean; children?: string }) {
  return <span className={`tag tag-${kind}${onDark ? ' tag-on-dark' : ''}`}>{children ?? MARKER_LABELS[kind]}</span>;
}
