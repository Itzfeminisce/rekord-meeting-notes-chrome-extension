import { getMeeting, listMarkers, listNotes, listSegments, putMeeting } from './db';
import { loadKeys } from './keys';
import { getSettings, PROVIDERS } from './settings';
import { formatClock } from './time';
import type { Marker, Meeting, Note, Segment, Summary } from './types';

export const MAX_TRANSCRIPT_CHARS = 100_000;

export class SummarizeError extends Error {}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Keeps the start and end of an over-long text, dropping the middle. */
export function truncateMiddle(text: string, max = MAX_TRANSCRIPT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[... middle of the transcript omitted ...]\n${text.slice(text.length - half)}`;
}

export function buildPrompt(title: string, segments: Segment[], notes: Note[], markers: Marker[]): string {
  const lines = segments
    .filter((s) => s.text.trim())
    .map((s) => `[${formatClock(s.startMs)}] ${s.speaker === 'you' ? 'You' : 'Others'}: ${s.text.trim()}`);
  const parts = [`Meeting: ${title}`, '', 'Transcript:', truncateMiddle(lines.join('\n')) || '(no speech was transcribed)'];
  if (notes.length) {
    parts.push('', "The user's own notes:", ...notes.map((n) => `[${formatClock(n.atMs)}] ${n.text}`));
  }
  const marks = markers.filter((m) => m.kind !== 'bookmark' || m.label);
  if (marks.length) {
    parts.push('', 'Moments the user marked:', ...marks.map((m) => `[${formatClock(m.atMs)}] ${m.kind}${m.label ? `: ${m.label}` : ''}`));
  }
  return parts.join('\n');
}

const SYSTEM = [
  'You write concise meeting summaries. Reply with ONLY a JSON object, no prose, shaped as:',
  '{"overview": string (2-4 sentences), "decisions": string[], "actions": [{"text": string, "owner"?: string}], "questions": string[]}',
  'Use "You" or "Others" as owner only when clear from the transcript. "questions" are issues still open.',
  'Use empty arrays when there is nothing. Write in the language of the meeting.',
].join('\n');

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];

/** Parses a model reply into a Summary body; tolerates code fences and surrounding prose. */
export function parseSummary(raw: string): Omit<Summary, 'generatedAt' | 'model'> {
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
      const { text: t, owner } = x as { text: string; owner?: unknown };
      if (!t.trim()) return [];
      return [typeof owner === 'string' && owner.trim() ? { text: t.trim(), owner: owner.trim() } : { text: t.trim() }];
    }
    return [];
  });
  const overview = typeof o.overview === 'string' ? o.overview.trim() : '';
  if (!overview && !actions.length && !strings(o.decisions).length) {
    throw new SummarizeError('The summary came back empty.');
  }
  return { overview, decisions: strings(o.decisions), actions, questions: strings(o.questions) };
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
    const [settings, keys, segments, notes, markers] = await Promise.all([
      getSettings(), loadKeys(), listSegments(meetingId), listNotes(meetingId), listMarkers(meetingId),
    ]);
    const { provider, model } = settings.summary;
    const cfg = PROVIDERS[provider];
    const baseUrl = (settings.summary.baseUrl || cfg.baseUrl).replace(/\/+$/, '');
    const key = cfg.keyName ? keys[cfg.keyName] : undefined;
    if (cfg.keyName && !key) throw new SummarizeError('Rekord needs an AI connection to write the summary. Check Connect AI in Settings.');

    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: buildPrompt(meeting.title, segments, notes, markers) },
          ],
        }),
      });
    } catch {
      throw new SummarizeError('Rekord could not reach the AI service. Check your connection and try again.');
    }
    if (res.status === 401 || res.status === 403) throw new SummarizeError('The AI service did not accept your key. Check Connect AI in Settings.');
    if (res.status === 429) throw new SummarizeError('The AI service is busy right now. Try again in a minute.');
    if (!res.ok) throw new SummarizeError(`The AI service returned an error (${res.status}). Try again.`);
    let content: unknown;
    try { content = ((await res.json()) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content; } catch { /* handled below */ }
    if (typeof content !== 'string') throw new SummarizeError('The AI service sent an unexpected reply. Try again.');
    done.summary = { ...parseSummary(content), generatedAt: Date.now(), model };
    await putMeeting(done);
    return done;
  } catch (e) {
    await putMeeting(done); // keep the transcript reachable even without a summary
    throw e instanceof SummarizeError ? e : new SummarizeError('Something went wrong while writing the summary. Try again.');
  }
}
