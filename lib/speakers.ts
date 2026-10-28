/**
 * Speaker names after diarization: name suggestions from the transcript, and the post-summary
 * speaker step (diarize → suggest names) that Processing runs.
 */
import { deleteRecording, getMeeting, listSegments, putMeeting, putSegment } from './db';
import { diarize } from './diarize';
import { liveLabels } from './transcribe/stream';
import { chat, transcriptLines, type FetchLike } from './llm';
import { loadKeys } from './keys';
import { send } from './messages';
import { getSettings } from './settings';
import type { CalendarEvent, Meeting, RecordingMeta, Segment } from './types';

type Speakers = NonNullable<Meeting['speakers']>;

const SYSTEM = `You read a meeting transcript where some voices are labelled "Speaker A", "Speaker B", and so on.
For each label, give the person's name only when the transcript makes it clear: someone addresses that speaker by
name right before they talk, or the speaker says their own name. Never guess. Reply with JSON only:
{"A": {"name": "Maria", "evidenceAt": "m:ss"}, "B": null}
"evidenceAt" is the timestamp of the line that shows the name. Use null for a label without a clear name.`;

/** "m:ss" / "h:mm:ss" → ms; numbers are taken as ms. */
function parseAt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v !== 'string') return undefined;
  const m = v.trim().replace(/^\[|\]$/g, '').match(/^(?:(\d+):)?(\d+):(\d{1,2})$/);
  if (!m) return undefined;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

/** Parses the model reply into per-label suggestions (only for `labels`). Bad entries become no suggestion. */
export function parseSuggestions(reply: string, labels: string[]): Record<string, { suggested?: string; evidenceMs?: number }> {
  let obj: unknown;
  try { obj = JSON.parse(reply); } catch { return {}; }
  if (!obj || typeof obj !== 'object') return {};
  const out: Record<string, { suggested?: string; evidenceMs?: number }> = {};
  for (const l of labels) {
    const e = (obj as Record<string, unknown>)[l] ?? (obj as Record<string, unknown>)[`Speaker ${l}`];
    if (!e || typeof e !== 'object') continue;
    const { name, evidenceAt, evidenceAtMs } = e as { name?: unknown; evidenceAt?: unknown; evidenceAtMs?: unknown };
    if (typeof name !== 'string' || !name.trim() || name.trim().toLowerCase() === 'null') continue;
    const evidenceMs = parseAt(evidenceAtMs ?? evidenceAt);
    out[l] = { suggested: name.trim().slice(0, 60), ...(evidenceMs !== undefined ? { evidenceMs } : {}) };
  }
  return out;
}

export interface Invitee { name: string; email: string }

/** Display name of an attendee: their name, else the part of the email before "@". */
export function inviteeName(a: { name?: string; email: string }): string {
  return (a.name?.trim() || a.email.split('@')[0] || a.email).trim();
}

/** Invitees other than you (attendees minus self), de-duplicated by email. */
export function inviteCandidates(event: CalendarEvent | undefined): Invitee[] {
  const seen = new Set<string>();
  const out: Invitee[] = [];
  for (const a of event?.attendees ?? []) {
    const key = a.email.trim().toLowerCase();
    if (a.self || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: inviteeName(a), email: a.email });
  }
  return out;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The invitee a suggested name refers to: full name, or a first name that only one invitee has. */
export function matchInvitee(suggested: string | undefined, candidates: Invitee[]): Invitee | undefined {
  const n = norm(suggested ?? '');
  if (!n) return undefined;
  const exact = candidates.find((c) => norm(c.name) === n);
  if (exact) return exact;
  const first = n.split(' ')[0];
  const hits = candidates.filter((c) => norm(c.name).split(' ')[0] === first);
  return hits.length === 1 ? hits[0] : undefined;
}

/** Chips for a label: invitees not already used as a name on another label. */
export function chipsFor(label: string, candidates: Invitee[], names: Record<string, string>): Invitee[] {
  const used = new Set(Object.entries(names).filter(([l]) => l !== label).map(([, v]) => norm(v)).filter(Boolean));
  return candidates.filter((c) => !used.has(norm(c.name)));
}

/** Invitees whose name no label carries (they didn't speak, or weren't picked out). */
export function unnamedInvitees(candidates: Invitee[], names: Record<string, string>): Invitee[] {
  const used = new Set(Object.values(names).map(norm).filter(Boolean));
  return candidates.filter((c) => !used.has(norm(c.name)));
}

/** Asks the summary model for a name per speaker label; stores `suggested`/`evidenceMs` on `meeting.speakers`. */
export async function suggestNames(meetingId: string, fetchFn?: FetchLike): Promise<Speakers> {
  const [meeting, segments] = await Promise.all([getMeeting(meetingId), listSegments(meetingId)]);
  if (!meeting) throw new Error('This meeting is no longer on this computer.');
  const speakers: Speakers = { ...(meeting.speakers ?? {}) };
  const labels = Object.keys(speakers);
  if (!labels.length) return speakers;
  const named: Speakers = {};
  for (const l of labels) named[l] = { name: `Speaker ${l}` };
  const lines = transcriptLines(segments, named);
  const invitees = inviteCandidates(meeting.event).map((c) => c.name);
  const reply = await chat(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Labels: ${labels.join(', ')}\n${invitees.length ? `People invited (use these names when they fit): ${invitees.join(', ')}\n` : ''}\n${lines.join('\n')}` }],
    { json: true, maxTokens: 400, temperature: 0 },
    fetchFn,
  );
  const found = parseSuggestions(reply, labels);
  for (const l of labels) {
    const { suggested: _s, evidenceMs: _e, ...rest } = speakers[l] ?? {};
    speakers[l] = { ...rest, ...(found[l] ?? {}) };
  }
  const latest = (await getMeeting(meetingId)) ?? meeting;
  await putMeeting({ ...latest, speakers });
  return speakers;
}

async function setStep(meetingId: string, step: NonNullable<Meeting['speakerStep']>): Promise<void> {
  const m = await getMeeting(meetingId);
  if (m) await putMeeting({ ...m, speakerStep: step });
  await send({ type: 'speakers/progress', meetingId, step });
}

/** Speaker steps running in this panel, per meeting. A persisted 'running' with no entry here is stale. */
const inFlight = new Map<string, Promise<Meeting['speakerStep']>>();

async function skip(meetingId: string, keepAudio: boolean): Promise<'skipped'> {
  await setStep(meetingId, 'skipped');
  if (!keepAudio) await deleteRecording(meetingId).catch(() => undefined);
  return 'skipped';
}

async function runOnce(
  meetingId: string,
  fetchFn?: { deepgram?: FetchLike; llm?: FetchLike },
): Promise<Meeting['speakerStep']> {
  try {
    const meeting = await getMeeting(meetingId);
    const step = meeting?.speakerStep;
    // 'running' here is stale (left by a panel that closed mid-run): run again.
    if (!meeting || (step !== 'pending' && step !== 'failed' && step !== 'running')) return undefined;
    const settings = await getSettings();
    if (!settings.features.speakerNames || !(await loadKeys())[settings.diarization.keyName]?.trim()) return await skip(meetingId, settings.keepAudio);
    if (!(await listSegments(meetingId)).some((s) => s.speaker === 'others')) return await skip(meetingId, settings.keepAudio);
    await setStep(meetingId, 'running');
    // v3: transcribed in real time → the live labels stand; no Deepgram pass after the meeting.
    const labels = meeting.realtime ? await liveLabels(meetingId) : await diarize(meetingId, fetchFn?.deepgram);
    if (!labels.length) throw new Error('No voices could be told apart.');
    // Name suggestions are optional: labels are saved, so the user can name speakers by hand.
    await suggestNames(meetingId, fetchFn?.llm).catch(() => undefined);
    await setStep(meetingId, 'ready');
    return 'ready';
  } catch {
    try { await setStep(meetingId, 'failed'); } catch { /* fail soft */ }
    return 'failed';
  }
}

/**
 * Runs diarize → suggestNames for a meeting whose speakerStep is 'pending', 'failed' (retry) or a stale
 * 'running'. Resolves to the final step: 'ready', 'failed', 'skipped' (switch off or no 'others' speech),
 * or undefined (nothing to do). A call while this panel already runs the step joins that run.
 * Never throws: any error (or no labels found) marks the step 'failed' and You/Others stays.
 */
export function runSpeakerStep(
  meetingId: string,
  fetchFn?: { deepgram?: FetchLike; llm?: FetchLike },
): Promise<Meeting['speakerStep']> {
  const running = inFlight.get(meetingId);
  if (running) return running;
  const run = runOnce(meetingId, fetchFn).finally(() => inFlight.delete(meetingId));
  inFlight.set(meetingId, run);
  return run;
}

import { displayName } from './llm';
export { displayName };

/** Live line name: "You", a saved name, else the invitee a suggested name matches (calendar event), else "Speaker A". */
export function liveLineName(s: Pick<Segment, 'speaker' | 'speakerLabel'>, speakers: Meeting['speakers'], candidates: Invitee[]): string {
  const base = displayName(s, speakers);
  if (s.speaker === 'you' || !s.speakerLabel || speakers?.[s.speakerLabel]?.name?.trim()) return base;
  return matchInvitee(speakers?.[s.speakerLabel]?.suggested, candidates)?.name ?? base;
}

export interface SpeakerStats { label: string; talkMs: number; lines: number; quote: Segment | undefined }

/** Per diarized label: talk time, line count and the longest line (the quote), in label order. */
export function speakerStats(segments: Segment[]): SpeakerStats[] {
  const by = new Map<string, SpeakerStats>();
  for (const g of segments) {
    if (g.speaker !== 'others' || !g.speakerLabel) continue;
    const st = by.get(g.speakerLabel) ?? { label: g.speakerLabel, talkMs: 0, lines: 0, quote: undefined };
    st.talkMs += Math.max(0, g.endMs - g.startMs);
    if (g.text.trim()) {
      st.lines += 1;
      if (!st.quote || g.text.trim().length > st.quote.text.trim().length) st.quote = g;
    }
    by.set(g.speakerLabel, st);
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Meeting time → time in the recording file (the recording skips paused stretches). */
export function toRecordingMs(meetingMs: number, pauses: RecordingMeta['pauses'] = []): number {
  let rec = meetingMs;
  for (const p of [...pauses].sort((a, b) => a.atMs - b.atMs)) if (p.atMs < rec) rec -= p.durationMs;
  return Math.max(0, rec);
}

export interface SpeakerEdits {
  /** Typed name per label; blank leaves "Speaker X". */
  names: Record<string, string>;
  /** `merges[from] = into`: "from" and "into" are the same person. */
  merges?: Record<string, string>;
}

async function finishStep(meetingId: string, step: 'saved' | 'skipped'): Promise<void> {
  const m = await getMeeting(meetingId);
  if (m) await putMeeting({ ...m, speakerStep: step });
  const { keepAudio } = await getSettings();
  if (!keepAudio) await deleteRecording(meetingId).catch(() => undefined);
  await send({ type: 'speakers/progress', meetingId, step });
}

/** Saves typed names (and merged labels) to the meeting, marks the step 'saved', and drops the audio unless kept. */
export async function saveSpeakerNames(meetingId: string, edits: SpeakerEdits): Promise<void> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error('This meeting is no longer on this computer.');
  const merges = edits.merges ?? {};
  const root = (l: string): string => { let x = l; for (let i = 0; i < 26 && merges[x] && merges[x] !== x; i++) x = merges[x]!; return x; };
  const speakers: NonNullable<Meeting['speakers']> = {};
  for (const [label, prev] of Object.entries(meeting.speakers ?? {})) {
    if (root(label) !== label) continue;
    const name = (edits.names[label] ?? '').trim().slice(0, 60);
    const { name: _old, ...rest } = prev;
    speakers[label] = { ...rest, ...(name ? { name } : {}) };
  }
  if (Object.keys(merges).length) {
    for (const g of await listSegments(meetingId)) {
      if (g.speakerLabel && root(g.speakerLabel) !== g.speakerLabel) await putSegment({ ...g, speakerLabel: root(g.speakerLabel) });
    }
  }
  await putMeeting({ ...((await getMeeting(meetingId)) ?? meeting), speakers });
  await finishStep(meetingId, 'saved');
}

/** Skip: keeps "Speaker A" labels, marks the step 'skipped', and drops the audio unless kept. */
export async function skipSpeakers(meetingId: string): Promise<void> {
  await finishStep(meetingId, 'skipped');
}
