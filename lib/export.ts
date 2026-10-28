import { formatClock, formatDuration } from './time';
import { speakerName } from './llm';
import { visibleMarkers } from './suggest';
import type { Marker, Meeting, Note, Segment } from './types';

export interface ExportOptions {
  summary: boolean;
  actions: boolean;
  decisions: boolean;
  transcript: boolean;
  notes: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = { summary: true, actions: true, decisions: true, transcript: false, notes: false };

const KIND: Record<Marker['kind'], string> = { decision: 'Decision', action: 'Action', question: 'Question', bookmark: 'Bookmark' };
export const MAILTO_URL_LIMIT = 1900;
export const MAILTO_SUBJECT_LIMIT = 120;
export const SHORTENED_NOTE = '… (Shortened. The full notes are in Rekord.)';

export function dateLine(meeting: Meeting): string {
  const d = new Date(meeting.startedAt);
  const day = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dur = meeting.endedAt ? formatDuration(meeting.endedAt - meeting.startedAt) : '';
  return [`${day} · ${time}`, dur].filter(Boolean).join(' · ');
}

export function fileName(meeting: Meeting): string {
  const slug = meeting.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'meeting'}.md`;
}

/** Structured content shared by the Markdown and print renderers. */
export interface Section { heading: string; lines: string[]; list?: boolean }

export function buildSections(
  meeting: Meeting, segments: Segment[], notes: Note[], markers: Marker[], opts: ExportOptions = DEFAULT_OPTIONS,
): Section[] {
  const out: Section[] = [];
  const s = meeting.summary;
  if (s && opts.summary && s.overview) out.push({ heading: 'Summary', lines: [s.overview] });
  if (s && opts.actions && s.actions.length) {
    out.push({ heading: 'Action items', list: true, lines: s.actions.map((a) => (a.owner ? `${a.text} (${a.owner})` : a.text)) });
  }
  if (s && opts.decisions && s.decisions.length) out.push({ heading: 'Decisions', list: true, lines: s.decisions });
  if (s && opts.summary && s.questions.length) out.push({ heading: 'Still open', list: true, lines: s.questions });
  if (opts.notes && notes.length) {
    out.push({ heading: 'Your notes', list: true, lines: [...notes].sort((a, b) => a.atMs - b.atMs).map((n) => `${formatClock(n.atMs)} ${n.text}`) });
  }
  const marked = visibleMarkers(markers).filter((m) => m.kind !== 'bookmark' || m.label);
  if (opts.notes && marked.length) {
    out.push({
      heading: 'Marked moments', list: true,
      lines: [...marked].sort((a, b) => a.atMs - b.atMs).map((m) => `${formatClock(m.atMs)} ${KIND[m.kind]}${m.label ? `: ${m.label}` : ''}`),
    });
  }
  if (opts.transcript && segments.length) {
    out.push({
      heading: 'Transcript',
      lines: [...segments].sort((a, b) => a.startMs - b.startMs).map((g) => `[${formatClock(g.startMs)}] ${speakerName(g, meeting.speakers)}: ${g.text}`),
    });
  }
  return out;
}

export function toMarkdown(
  meeting: Meeting, segments: Segment[], notes: Note[], markers: Marker[], opts: ExportOptions = DEFAULT_OPTIONS,
): string {
  const parts = [`# ${meeting.title}`, dateLine(meeting)];
  for (const sec of buildSections(meeting, segments, notes, markers, opts)) {
    const body = sec.list ? sec.lines.map((l) => `- ${l}`).join('\n') : sec.heading === 'Transcript' ? sec.lines.join('\n\n') : sec.lines.join('\n');
    parts.push(`## ${sec.heading}\n\n${body}`);
  }
  return parts.join('\n\n') + '\n';
}

export function toMailto(meeting: Meeting): { href: string; shortened: boolean } {
  const s = meeting.summary;
  const blocks: string[] = [];
  if (s?.overview) blocks.push(s.overview);
  if (s?.decisions.length) blocks.push(`Decisions\n${s.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (s?.actions.length) blocks.push(`Action items\n${s.actions.map((a) => `- ${a.text}${a.owner ? ` (${a.owner})` : ''}`).join('\n')}`);
  const wellFormed = (t: string) => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  const subject = encodeURIComponent(wellFormed(Array.from(meeting.title).slice(0, MAILTO_SUBJECT_LIMIT).join('')));
  const prefix = `mailto:?subject=${subject}&body=`;
  const full = wellFormed(blocks.join('\n\n')).replace(/\r\n|\r|\n/g, '\r\n');
  const fullEnc = encodeURIComponent(full);
  if (prefix.length + fullEnc.length <= MAILTO_URL_LIMIT) return { href: prefix + fullEnc, shortened: false };
  const tail = encodeURIComponent(`\r\n\r\n${SHORTENED_NOTE}`);
  let budget = MAILTO_URL_LIMIT - prefix.length - tail.length;
  let kept = '';
  for (const ch of full) {
    const n = encodeURIComponent(ch).length;
    if (n > budget) break;
    budget -= n; kept += ch;
  }
  return { href: prefix + encodeURIComponent(kept.trimEnd()) + tail, shortened: true };
}

export function printUrl(meetingId: string, opts: ExportOptions): string {
  const inc = (Object.keys(opts) as (keyof ExportOptions)[]).filter((k) => opts[k]).join(',');
  return `print.html?meetingId=${encodeURIComponent(meetingId)}&include=${encodeURIComponent(inc)}`;
}

export function parseInclude(value: string | null): ExportOptions {
  if (value === null) return { ...DEFAULT_OPTIONS };
  const set = new Set(value.split(','));
  return { summary: set.has('summary'), actions: set.has('actions'), decisions: set.has('decisions'), transcript: set.has('transcript'), notes: set.has('notes') };
}
