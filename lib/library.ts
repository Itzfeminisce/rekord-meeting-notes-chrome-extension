import type { Meeting, Segment } from './types';
import type { TimelineItem } from './live';
import { speakerName } from './llm';
import { formatClock } from './time';

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface MeetingGroup { label: 'This week' | 'Earlier'; meetings: Meeting[] }

/** "Today", "Yesterday" or "Oct 27". */
export function dateLabel(ts: number, now: number = Date.now()): string {
  const start = (t: number) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();
  const diff = Math.round((start(now) - start(ts)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Number of open (not yet done) actions in a meeting's summary; 0 when there is no summary. */
export function openActions(m: Meeting): number {
  return m.summary?.actions.length ?? 0;
}

/** Newest first, split into "This week" (last 7 days) and "Earlier". Empty groups are dropped. */
export function groupMeetings(meetings: Meeting[], now: number = Date.now()): MeetingGroup[] {
  const sorted = [...meetings].sort((a, b) => b.startedAt - a.startedAt);
  const week = sorted.filter((m) => now - m.startedAt < 7 * DAY);
  const earlier = sorted.filter((m) => now - m.startedAt >= 7 * DAY);
  const groups: MeetingGroup[] = [];
  if (week.length) groups.push({ label: 'This week', meetings: week });
  if (earlier.length) groups.push({ label: 'Earlier', meetings: earlier });
  return groups;
}

/** Case-insensitive match on the title or the transcript text. Blank query matches everything. */
export function matchesQuery(m: Meeting, transcript: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return m.title.toLowerCase().includes(q) || (transcript ?? '').toLowerCase().includes(q);
}

export function joinTranscript(segments: Segment[]): string {
  return segments.map((s) => s.text).join(' ');
}

/** Split text into plain and matched pieces for highlighting. */
export function splitMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) break;
    if (j > i) out.push({ text: text.slice(i, j), hit: false });
    out.push({ text: text.slice(j, j + q.length), hit: true });
    i = j + q.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}

/** Text searched for a timeline item (segments and notes only). */
export function itemText(it: TimelineItem): string {
  return it.kind === 'segment' ? it.segment.text : it.kind === 'note' ? it.note.text : '';
}

/** Ids of timeline items that contain the query, in order. */
export function matchIds(items: TimelineItem[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return items.filter((it) => itemText(it).toLowerCase().includes(q)).map((it) => it.id);
}

/** Plain text of the whole transcript for copying: "[12:04] You: text", notes as "Your note". */
export function transcriptToText(items: TimelineItem[], speakers?: Meeting['speakers']): string {
  return items
    .map((it) => {
      const at = `[${formatClock(it.atMs)}]`;
      if (it.kind === 'segment') return `${at} ${speakerName(it.segment, speakers)}: ${it.segment.text}`;
      if (it.kind === 'note') return `${at} Your note: ${it.note.text}`;
      return `${at} ${it.marker.kind.charAt(0).toUpperCase()}${it.marker.kind.slice(1)}${it.marker.label ? `: ${it.marker.label}` : ''}`;
    })
    .join('\n');
}
