/**
 * Speaker names after diarization: name suggestions from the transcript, and the post-summary
 * speaker step (diarize → suggest names) that Processing runs.
 */
import { deleteRecording, getMeeting, listSegments, putMeeting, putSegment } from './db';
import { diarize } from './diarize';
import { chat, transcriptLines, type FetchLike } from './llm';
import { loadKeys } from './keys';
import { send } from './messages';
import { getSettings } from './settings';
import type { Meeting, RecordingMeta, Segment } from './types';

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
  const reply = await chat(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Labels: ${labels.join(', ')}\n\n${lines.join('\n')}` }],
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
    const labels = await diarize(meetingId, fetchFn?.deepgram);
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

/** What a speaker shows as: their saved name, else "Speaker A" for a diarized label, else "Others". You stays "You". */
export function displayName(s: Pick<Segment, 'speaker' | 'speakerLabel'>, speakers?: Meeting['speakers']): string {
  if (s.speaker === 'you') return 'You';
  if (!s.speakerLabel) return 'Others';
  return speakers?.[s.speakerLabel]?.name?.trim() || `Speaker ${s.speakerLabel}`;
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
