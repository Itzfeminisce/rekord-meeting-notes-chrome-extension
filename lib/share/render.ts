import { buildSections, dateLine, DEFAULT_OPTIONS, type ExportOptions } from '../export';
import type { Marker, Meeting, Note, Segment } from '../types';

export const escapeHtml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The meeting as simple HTML (Google turns it into a Doc). Same content rules as the Markdown export. */
export function toHtml(
  meeting: Meeting, segments: Segment[], notes: Note[], markers: Marker[], opts: ExportOptions = DEFAULT_OPTIONS,
): string {
  const parts = [`<h1>${escapeHtml(meeting.title)}</h1>`, `<p>${escapeHtml(dateLine(meeting))}</p>`];
  for (const sec of buildSections(meeting, segments, notes, markers, opts)) {
    parts.push(`<h2>${escapeHtml(sec.heading)}</h2>`);
    if (sec.list) parts.push(`<ul>${sec.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`);
    else parts.push(...sec.lines.map((l) => `<p>${escapeHtml(l)}</p>`));
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(meeting.title)}</title></head><body>${parts.join('')}</body></html>`;
}
