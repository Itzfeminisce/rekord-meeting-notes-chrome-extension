/**
 * Speaker names after diarization: name suggestions from the transcript, and the post-summary
 * speaker step (diarize → suggest names) that Processing runs.
 */
import { deleteRecording, getMeeting, listSegments, putMeeting } from './db';
import { diarize } from './diarize';
import { chat, transcriptLines, type FetchLike } from './llm';
import { send } from './messages';
import { getSettings } from './settings';
import type { Meeting } from './types';

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

/**
 * Runs diarize → suggestNames for a meeting whose speakerStep is 'pending' (or 'failed', for retry).
 * Resolves to the final step: 'ready', 'failed', 'skipped' (switch off), or undefined (nothing to do).
 * Never throws: any error marks the step 'failed' and You/Others stays.
 */
export async function runSpeakerStep(
  meetingId: string,
  fetchFn?: { deepgram?: FetchLike; llm?: FetchLike },
): Promise<Meeting['speakerStep']> {
  try {
    const meeting = await getMeeting(meetingId);
    const step = meeting?.speakerStep;
    if (!meeting || (step !== 'pending' && step !== 'failed')) return undefined;
    const settings = await getSettings();
    if (!settings.features.speakerNames) {
      await setStep(meetingId, 'skipped');
      if (!settings.keepAudio) await deleteRecording(meetingId).catch(() => undefined);
      return 'skipped';
    }
    await setStep(meetingId, 'running');
    await diarize(meetingId, fetchFn?.deepgram);
    await suggestNames(meetingId, fetchFn?.llm);
    await setStep(meetingId, 'ready');
    return 'ready';
  } catch {
    try { await setStep(meetingId, 'failed'); } catch { /* fail soft */ }
    return 'failed';
  }
}
