import { getMeeting, listAsks, listMarkers, listNotes, listSegments, putAsk, putNote } from './db';
import { chat, LLMError, type ChatMessage, type ChatOptions, type FetchLike } from './llm';
import { buildPrompt } from './summarize';
import { formatClock } from './time';
import type { AskTurn, Marker, Meeting, Note, Segment } from './types';

export const ASK_SYSTEM_PROMPT = [
  'You answer questions about one meeting, using only the transcript, notes and marked moments you are given.',
  'Never use outside knowledge. If the meeting did not cover something, say so plainly.',
  'Cite the moments you rely on as [mm:ss] (or [h:mm:ss]) using the timestamps in the transcript.',
  'Be brief. Use short sentences or a short list.',
].join(' ');

export const QUICK_PROMPTS = [
  { label: 'Catch me up', question: 'Catch me up on the last 5 minutes of this meeting.' },
  { label: 'Open questions', question: 'What questions are still open?' },
  { label: 'Actions so far', question: 'What action items have come up so far, and who owns them?' },
] as const;

const MAX_HISTORY_TURNS = 4;

/** Pulls [m:ss] / [h:mm:ss] citations out of an answer, as unique atMs values in order of appearance. */
export function parseCitations(answer: string): number[] {
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]/g)) {
    const secs = m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
    const ms = secs * 1000;
    if (!out.includes(ms)) out.push(ms);
  }
  return out;
}

export interface AskContext {
  meeting?: Pick<Meeting, 'title' | 'speakers'>;
  segments: Segment[];
  notes: Note[];
  markers: Marker[];
  history: AskTurn[];
}

/** System + context + earlier turns + the new question. */
export function buildAskMessages(ctx: AskContext, question: string): ChatMessage[] {
  const title = ctx.meeting?.title ?? 'Untitled meeting';
  const nowMs = ctx.segments.reduce((mx, s) => Math.max(mx, s.endMs), 0);
  const context = `${buildPrompt(title, ctx.segments, ctx.notes, ctx.markers, ctx.meeting?.speakers)}\n\nThe meeting has reached [${formatClock(nowMs)}] so far.`;
  const messages: ChatMessage[] = [
    { role: 'system', content: ASK_SYSTEM_PROMPT },
    { role: 'user', content: context },
  ];
  for (const t of ctx.history.filter((h) => h.answer && !h.error).slice(-MAX_HISTORY_TURNS)) {
    messages.push({ role: 'user', content: t.question }, { role: 'assistant', content: t.answer as string });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

export interface AskDeps {
  fetch?: FetchLike;
  config?: ChatOptions['config'];
  /** Re-run an existing (failed) turn instead of creating a new one. */
  turnId?: string;
  signal?: AbortSignal;
}

/**
 * Asks about a meeting. Saves the turn first, then updates it with the answer (and citations) or the error.
 * Never throws for model/connection errors: they land on the returned turn's `error`.
 */
export async function ask(meetingId: string, question: string, deps: AskDeps = {}): Promise<AskTurn> {
  const q = question.trim();
  const existing = deps.turnId ? (await listAsks(meetingId)).find((t) => t.id === deps.turnId) : undefined;
  const turn: AskTurn = existing
    ? { id: existing.id, meetingId, createdAt: existing.createdAt, question: existing.question }
    : { id: crypto.randomUUID(), meetingId, createdAt: Date.now(), question: q };
  await putAsk(turn);
  try {
    const [meeting, segments, notes, markers, asks] = await Promise.all([
      getMeeting(meetingId), listSegments(meetingId), listNotes(meetingId), listMarkers(meetingId), listAsks(meetingId),
    ]);
    const history = asks.filter((a) => a.id !== turn.id && a.createdAt < turn.createdAt);
    const answer = (await chat(
      buildAskMessages({ meeting, segments, notes, markers, history }, turn.question),
      { temperature: 0.2, maxTokens: 700, signal: deps.signal, config: deps.config },
      deps.fetch,
    )).trim();
    if (!answer) throw new LLMError('The AI service sent an unexpected reply. Try again.', 'bad-reply');
    const done: AskTurn = { ...turn, answer, citations: parseCitations(answer) };
    await putAsk(done);
    return done;
  } catch (e) {
    const failed: AskTurn = { ...turn, error: e instanceof Error && e.message ? e.message : 'Something went wrong while answering. Try again.' };
    await putAsk(failed).catch(() => {});
    return failed;
  }
}

/** Saves an answer as a note at its newest cited moment, else at `nowMs`. */
export async function saveAnswerAsNote(turn: AskTurn, nowMs: number): Promise<Note> {
  const cited = turn.citations?.length ? Math.max(...turn.citations) : undefined;
  const note: Note = {
    id: crypto.randomUUID(), meetingId: turn.meetingId, atMs: cited ?? nowMs,
    text: (turn.answer ?? '').trim(), createdAt: Date.now(),
  };
  await putNote(note);
  return note;
}
