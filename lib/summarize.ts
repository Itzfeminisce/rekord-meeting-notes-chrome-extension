import { getMeeting, listMarkers, listNotes, listSegments, putMeeting } from './db';
import { chat, LLMError, transcriptLines, type FetchLike } from './llm';
import { getSettings } from './settings';
import { formatClock } from './time';
import type { Marker, Meeting, Note, Segment, Summary } from './types';

export const MAX_TRANSCRIPT_CHARS = 100_000;

export class SummarizeError extends Error {}

/** Keeps the start and end of an over-long text, dropping the middle. */
export function truncateMiddle(text: string, max = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[... middle of the transcript omitted ...]\n${text.slice(text.length - half)}`;
}

const aiExtra = (m: Marker) =>
  [m.owner && `owner: ${m.owner}`, m.due && `due: ${m.due}`].filter(Boolean).map((x) => ` (${x})`).join('');

export function buildPrompt(
  title: string, segments: Segment[], notes: Note[], markers: Marker[], speakers?: Meeting['speakers'],
): string {
  const lines = transcriptLines(segments, speakers);
  const parts = [`Meeting: ${title}`, '', 'Transcript:', truncateMiddle(lines.join('\n')) || '(no speech was transcribed)'];
  if (notes.length) {
    parts.push('', "The user's own notes:", ...notes.map((n) => `[${formatClock(n.atMs)}] ${n.text}`));
  }
  const marks = markers.filter((m) => (m.source !== 'ai' || m.status === 'accepted') && (m.kind !== 'bookmark' || m.label));
  if (marks.length) {
    parts.push('', 'Moments the user marked:', ...marks.map((m) => `[${formatClock(m.atMs)}] ${m.kind}${m.label ? `: ${m.label}` : ''}${m.source === 'ai' ? aiExtra(m) : ''}`));
  }
  return parts.join('\n');
}

const SYSTEM = [
  'You write concise meeting summaries. Reply with ONLY a JSON object, no prose, shaped as:',
  '{"overview": string (2-4 sentences), "decisions": [{"text": string, "atMs"?: number}], "actions": [{"text": string, "owner"?: string, "due"?: string}], "questions": string[]}',
  'Use "You" or "Others" as owner only when clear from the transcript. "questions" are issues still open.',
  '"atMs" is the milliseconds from the start of the meeting where the decision was made (from the [m:ss] stamps); leave it out if unsure. "due" is only a deadline that was said aloud, e.g. "Thu".',
  'Use empty arrays when there is nothing. Write in the language of the meeting.',
].join('\n');

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];

/** Old summaries hold plain strings; new ones hold {text, atMs?}. Every reader goes through this. */
export function normalizeDecisions(decisions: Summary['decisions'] | undefined): { text: string; atMs?: number }[] {
  return (decisions ?? []).flatMap((d) => {
    if (typeof d === 'string') return d.trim() ? [{ text: d.trim() }] : [];
    if (d && typeof d.text === 'string' && d.text.trim()) {
      return [typeof d.atMs === 'number' && Number.isFinite(d.atMs) && d.atMs >= 0 ? { text: d.text.trim(), atMs: d.atMs } : { text: d.text.trim() }];
    }
    return [];
  });
}

/** Parses a model reply into a Summary body; tolerates code fences and surrounding prose. maxMs drops decision moments past the meeting's end. */
export function parseSummary(raw: string, maxMs = Infinity): Omit<Summary, 'generatedAt' | 'model'> {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) text = text.slice(a, b + 1);
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new SummarizeError('The summary came back in a format Rekord could not read.'); }
  if (!obj || typeof obj !== 'object') throw new SummarizeError('The summary came back in a format Rekord could not read.');
  const o = obj as Record<string, unknown>;
  const actions = (Array.isArray(o.actions) ? o.actions : []).flatMap((x) => {
    if (typeof x === 'string') return x.trim() ? [{ text: x.trim() }] : [];
    if (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string') {
      const { text: t, owner, due } = x as { text: string; owner?: unknown; due?: unknown };
      if (!t.trim()) return [];
      return [{
        text: t.trim(),
        ...(typeof owner === 'string' && owner.trim() ? { owner: owner.trim() } : {}),
        ...(typeof due === 'string' && due.trim() ? { due: due.trim() } : {}),
      }];
    }
    return [];
  });
  const decisions = (Array.isArray(o.decisions) ? o.decisions : []).flatMap((x): Summary['decisions'] => {
    if (typeof x === 'string') return x.trim() ? [x.trim()] : [];
    if (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string') {
      const { text: t, atMs } = x as { text: string; atMs?: unknown };
      if (!t.trim()) return [];
      return [typeof atMs === 'number' && Number.isFinite(atMs) && atMs >= 0 && atMs <= maxMs ? { text: t.trim(), atMs } : { text: t.trim() }];
    }
    return [];
  });
  const overview = typeof o.overview === 'string' ? o.overview.trim() : '';
  if (!overview && !actions.length && !decisions.length && !strings(o.questions).length) {
    throw new SummarizeError('The summary came back empty.');
  }
  return { overview, decisions, actions, questions: strings(o.questions) };
}

/**
 * Writes the summary for a meeting and marks it done. If the call fails the meeting is still marked done
 * (transcript is kept) and a SummarizeError with a user-facing message is thrown.
 */
export async function summarize(meetingId: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<Meeting> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new SummarizeError('This meeting could not be found.');
  const done: Meeting = { ...meeting, status: 'done', endedAt: meeting.endedAt ?? Date.now() };
  try {
    const [settings, segments, notes, markers] = await Promise.all([
      getSettings(), listSegments(meetingId), listNotes(meetingId), listMarkers(meetingId),
    ]);
    const { model } = settings.summary;
    if (!segments.some((s) => s.text.trim()) && !notes.length) {
      done.summary = { overview: '', decisions: [], actions: [], questions: [], generatedAt: Date.now(), model };
      await putMeeting(done);
      return done;
    }

    let content: string;
    try {
      content = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt(meeting.title, segments, notes, markers, meeting.speakers) },
      ], {}, fetchFn);
    } catch (e) {
      if (e instanceof LLMError && e.code === 'no-key') {
        throw new SummarizeError('Rekord needs an AI connection to write the summary. Check Connect AI in Settings.');
      }
      throw e instanceof LLMError ? new SummarizeError(e.message) : e;
    }
    done.summary = { ...parseSummary(content, Math.max(0, ...segments.map((g) => g.endMs), ...notes.map((n) => n.atMs))), generatedAt: Date.now(), model };
    await putMeeting(done);
    return done;
  } catch (e) {
    await putMeeting(done); // keep the transcript reachable even without a summary
    throw e instanceof SummarizeError ? e : new SummarizeError('Something went wrong while writing the summary. Try again.');
  }
}
