import type { Marker, MarkerKind, Note, Segment } from './types';

export type TimelineItem =
  | { kind: 'segment'; id: string; atMs: number; segment: Segment }
  | { kind: 'note'; id: string; atMs: number; note: Note }
  | { kind: 'marker'; id: string; atMs: number; marker: Marker };

/** Adds (or replaces, by id) a segment and keeps the list sorted by start time. Never mutates the input. */
export function mergeSegment(list: Segment[], seg: Segment): Segment[] {
  const next = list.filter((s) => s.id !== seg.id);
  next.push(seg);
  return next.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** One time-ordered list of what was said, noted and marked. Ties: segment, then marker, then note. */
export function buildTimeline(segments: Segment[], notes: Note[], markers: Marker[]): TimelineItem[] {
  const rank = { segment: 0, marker: 1, note: 2 } as const;
  const items: TimelineItem[] = [
    ...segments.filter((s) => s.text.trim()).map((s): TimelineItem => ({ kind: 'segment', id: s.id, atMs: s.startMs, segment: s })),
    ...markers.map((m): TimelineItem => ({ kind: 'marker', id: m.id, atMs: m.atMs, marker: m })),
    ...notes.map((n): TimelineItem => ({ kind: 'note', id: n.id, atMs: n.atMs, note: n })),
  ];
  return items.sort((a, b) => a.atMs - b.atMs || rank[a.kind] - rank[b.kind]);
}

/** Elapsed ms since the meeting started; never negative. */
export function elapsedMs(startedAt: number, now: number = Date.now()): number {
  return Math.max(0, now - startedAt);
}

export function newNote(meetingId: string, atMs: number, text: string): Note | null {
  const t = text.trim();
  if (!t) return null;
  return { id: crypto.randomUUID(), meetingId, atMs, text: t, createdAt: Date.now() };
}

export function newMarker(meetingId: string, atMs: number, kind: MarkerKind): Marker {
  return { id: crypto.randomUUID(), meetingId, atMs, kind };
}

/** Bar heights (px) for a 0..1 level, 5 bars; silent still shows a low resting bar. */
export function levelBars(level: number, min = 4, max = 20): number[] {
  const l = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const shape = [0.45, 0.8, 0.6, 1, 0.5];
  return shape.map((k) => Math.round(min + (max - min) * Math.min(1, l * k * 1.4)));
}

/** "meet.google.com" from a URL, or undefined for non-web pages. */
export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** True when the scroller is within `slack` px of its bottom (so new lines should follow). */
export function nearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

/** "OCT" / "27" for the recent-meetings date tile. */
export function dateTile(ts: number): { month: string; day: string } {
  const d = new Date(ts);
  return { month: d.toLocaleString('en-US', { month: 'short' }).toUpperCase(), day: String(d.getDate()) };
}

/** The span of saved audio still waiting to be transcribed, or null when nothing is pending. */
export function waitingSpan(chunks: { startMs: number; endMs: number }[]): { from: number; to: number } | null {
  if (!chunks.length) return null;
  return { from: Math.min(...chunks.map((c) => c.startMs)), to: Math.max(...chunks.map((c) => c.endMs)) };
}
