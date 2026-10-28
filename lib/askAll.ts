import { listNotes, listSegments } from './db';
import { chat, LLMError, speakerName, type ChatMessage, type ChatOptions, type FetchLike } from './llm';
import { formatClock } from './time';
import type { Meeting, Note, Segment } from './types';

const DAY = 86_400_000;

export type Range = '7' | '30' | 'all';
export const RANGES: { id: Range; label: string }[] = [
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: 'all', label: 'All time' },
];

/** Most characters of meeting text sent to the model. */
export const BUDGET_CHARS = 60_000;
const MAX_EXCERPTS = 12;
const EXCERPT_CHARS = 300;

export const ASK_ALL_SYSTEM_PROMPT = [
  'You answer questions about the user’s meetings, using only the meetings you are given.',
  'Never use outside knowledge. If the meetings do not cover something, say so plainly.',
  'Cite every moment you rely on as [<meetingId>@mm:ss], using the meeting ids and timestamps you were given.',
  'Be brief. Use short sentences or a short list.',
].join(' ');

/** Questions behind the suggestion chips. The last one is incomplete, so it fills the box instead of sending. */
export const SUGGESTIONS: readonly { label: string; question: string; incomplete?: boolean }[] = [
  { label: 'Open actions', question: 'What action items are still open, and who owns them?' },
  { label: 'Decisions this month', question: 'What did we decide this month?' },
  { label: 'What’s pending with…', question: 'What’s pending with ', incomplete: true },
];

/** Meetings (finished ones only) that started inside the range. */
export function filterByRange(meetings: Meeting[], range: Range, now: number = Date.now()): Meeting[] {
  const days = range === 'all' ? Infinity : Number(range);
  return meetings.filter((m) => m.status === 'done' && now - m.startedAt <= days * DAY);
}

export function nothingFoundText(range: Range): string {
  return `None of your meetings${range === 'all' ? '' : ` from the last ${range} days`} mention this.`;
}

const STOP = new Set(
  'the and for are but not you all any can had her was one our out has have been from what when where which who whom why how did does this that with about into over than then them they their there these those will would could should your yours mine his she him its also just some more most much many very were being after before again here only own same such too off per via'.split(' '),
);

/** Lower-cased words worth searching for. */
export function queryWords(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const w = raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

export interface MeetingData { meeting: Meeting; segments: Segment[]; notes: Note[] }
export interface Candidate extends MeetingData { score: number }

const decisionTexts = (m: Meeting): string[] => (m.summary?.decisions ?? []).map((d) => (typeof d === 'string' ? d : d.text));

function summaryText(m: Meeting): string {
  const s = m.summary;
  if (!s) return '';
  return [s.overview, ...decisionTexts(m), ...s.actions.map((a) => a.text), ...s.questions].join('\n');
}

const count = (hay: string, w: string): number => (hay.length ? hay.split(w).length - 1 : 0);

/** Scores one meeting for a question: title, summary, notes and transcript words, plus summary parts the question asks for. */
export function scoreMeeting(d: MeetingData, query: string): number {
  const words = queryWords(query);
  const title = d.meeting.title.toLowerCase();
  const summary = summaryText(d.meeting).toLowerCase();
  const notes = d.notes.map((n) => n.text).join('\n').toLowerCase();
  const transcript = d.segments.map((s) => s.text).join('\n').toLowerCase();
  let score = 0;
  for (const w of words) {
    score += Math.min(count(title, w), 2) * 5;
    score += Math.min(count(summary, w), 3) * 3;
    score += Math.min(count(notes, w), 3) * 2;
    score += Math.min(count(transcript, w), 5);
  }
  const q = query.toLowerCase();
  const s = d.meeting.summary;
  if (s) {
    if (/action|to-?do|task|owner|follow/.test(q) && s.actions.length) score += 3;
    if (/decid|decision|agree/.test(q) && s.decisions.length) score += 3;
    if (/pending|open|question|unresolved|outstanding/.test(q) && (s.questions.length || s.actions.length)) score += 3;
  }
  return score;
}

/** "mm:ss" (or "h:mm:ss") as used in citations. */
export function citationClock(ms: number): string {
  const c = formatClock(ms);
  return c.length === 4 ? `0${c}` : c;
}

function block(c: Candidate, query: string, withExcerpts: boolean): string {
  const m = c.meeting;
  const words = queryWords(query);
  const lines = [`## Meeting ${m.id}: ${m.title || 'Untitled meeting'} (${new Date(m.startedAt).toISOString().slice(0, 10)})`];
  const s = m.summary;
  if (s) {
    lines.push(`Summary: ${s.overview}`);
    const decisions = decisionTexts(m);
    if (decisions.length) lines.push(`Decisions: ${decisions.join('; ')}`);
    if (s.actions.length) lines.push(`Actions: ${s.actions.map((a) => `${a.text}${a.owner ? ` (${a.owner})` : ''}`).join('; ')}`);
    if (s.questions.length) lines.push(`Open questions: ${s.questions.join('; ')}`);
  }
  if (withExcerpts) {
    const hits: string[] = [];
    for (const n of c.notes) {
      if (words.some((w) => n.text.toLowerCase().includes(w))) hits.push(`[${citationClock(n.atMs)}] Your note: ${n.text.slice(0, EXCERPT_CHARS)}`);
    }
    for (const seg of c.segments) {
      if (hits.length >= MAX_EXCERPTS) break;
      if (words.some((w) => seg.text.toLowerCase().includes(w))) {
        hits.push(`[${citationClock(seg.startMs)}] ${speakerName(seg, m.speakers)}: ${seg.text.trim().slice(0, EXCERPT_CHARS)}`);
      }
    }
    if (hits.length) lines.push('Excerpts:', ...hits.slice(0, MAX_EXCERPTS));
  }
  return lines.join('\n');
}

/** Candidates with a score above zero, best first (newest first on ties). */
export function rankCandidates(data: MeetingData[], query: string): Candidate[] {
  return data
    .map((d) => ({ ...d, score: scoreMeeting(d, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.meeting.startedAt - a.meeting.startedAt);
}

/**
 * Takes the best meetings until the character budget is used: summary first, then matching excerpts.
 * A meeting that does not fit with excerpts is tried with its summary alone.
 */
export function pickContext(ranked: Candidate[], query: string, budget: number = BUDGET_CHARS): { text: string; included: Candidate[] } {
  const parts: string[] = [];
  const included: Candidate[] = [];
  let used = 0;
  for (const c of ranked) {
    let b = block(c, query, true);
    if (used + b.length + 2 > budget) b = block(c, query, false);
    if (used + b.length + 2 > budget) {
      if (included.length) continue;
      b = b.slice(0, Math.max(0, budget - 2));
    }
    parts.push(b);
    included.push(c);
    used += b.length + 2;
  }
  return { text: parts.join('\n\n'), included };
}

export function buildAskAllMessages(context: string, question: string): ChatMessage[] {
  return [
    { role: 'system', content: ASK_ALL_SYSTEM_PROMPT },
    { role: 'user', content: `Your meetings:\n\n${context}` },
    { role: 'user', content: question },
  ];
}

export interface Source { meetingId: string; title: string; startedAt: number; atMs: number }

const CITE = /\[([^\]@\s]+)@(\d{1,3}):(\d{2})(?::(\d{2}))?\]/g;

/** One source per cited meeting, with its first cited moment, in order of first mention. Unknown ids are ignored. */
export function parseSources(answer: string, meetings: Pick<Meeting, 'id' | 'title' | 'startedAt'>[]): Source[] {
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const out: Source[] = [];
  for (const m of answer.matchAll(CITE)) {
    const meeting = byId.get(m[1] ?? "");
    if (!meeting || out.some((s) => s.meetingId === meeting.id)) continue;
    const [a, b, c] = [Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : undefined];
    if (c !== undefined ? b >= 60 || c >= 60 : b >= 60) continue;
    const sec = c !== undefined ? a * 3600 + b * 60 + c : a * 60 + b;
    out.push({ meetingId: meeting.id, title: meeting.title || 'Untitled meeting', startedAt: meeting.startedAt, atMs: sec * 1000 });
  }
  return out;
}

/** The answer text without citation markers. */
export function stripCitations(answer: string): string {
  return answer.replace(CITE, '').replace(/[ \t]+([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').trim();
}

export interface AskAllResult {
  question: string;
  range: Range;
  status: 'answer' | 'none' | 'error';
  answer?: string;
  sources?: Source[];
  error?: string;
}

export interface AskAllDeps {
  fetch?: FetchLike;
  config?: ChatOptions['config'];
  signal?: AbortSignal;
  now?: number;
  /** Loads a meeting's transcript and notes (defaults to the database). */
  load?: (m: Meeting) => Promise<MeetingData>;
}

const loadFromDb = async (meeting: Meeting): Promise<MeetingData> => ({
  meeting, segments: await listSegments(meeting.id), notes: await listNotes(meeting.id),
});

/** Answers a question from the saved meetings in the range. Never throws: model errors land on the result. */
export async function askAll(question: string, range: Range, all: Meeting[], deps: AskAllDeps = {}): Promise<AskAllResult> {
  const q = question.trim();
  try {
    const data = await Promise.all(filterByRange(all, range, deps.now).map(deps.load ?? loadFromDb));
    const picked = pickContext(rankCandidates(data, q), q);
    if (!picked.included.length) return { question: q, range, status: 'none' };
    const answer = (await chat(
      buildAskAllMessages(picked.text, q),
      { temperature: 0.2, maxTokens: 700, signal: deps.signal, config: deps.config },
      deps.fetch,
    )).trim();
    if (!answer) throw new LLMError('The AI service sent an unexpected reply. Try again.', 'bad-reply');
    return { question: q, range, status: 'answer', answer: stripCitations(answer), sources: parseSources(answer, picked.included.map((c) => c.meeting)) };
  } catch (e) {
    return { question: q, range, status: 'error', error: e instanceof Error && e.message ? e.message : 'Something went wrong while answering. Try again.' };
  }
}

const APP_NAMES = { meet: 'Meet', zoom: 'Zoom', teams: 'Teams' } as const;

/** Library card line: "With Priya, Sam and Leo · Teams app" from the matched event; undefined when there is none. */
export function attendeeLine(m: Pick<Meeting, 'event' | 'source'>): string | undefined {
  const ev = m.event;
  if (!ev) return undefined;
  const names = ev.attendees
    .filter((a) => !a.self)
    .map((a) => a.name?.trim() || a.email.split('@')[0])
    .filter(Boolean);
  const who = names.length === 0 ? '' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const app = m.source === 'app' && ev.app ? `${APP_NAMES[ev.app]} app` : '';
  if (!who && !app) return undefined;
  return [who ? `With ${who}` : '', app].filter(Boolean).join(' · ');
}

/** Answers kept while the side panel is open; never stored. */
export const askAllSession: { range: Range; turns: AskAllResult[] } = { range: '30', turns: [] };
