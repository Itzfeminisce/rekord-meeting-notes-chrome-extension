/**
 * Speaker diarization after the meeting: sends the continuous tab recording to Deepgram's pre-recorded API
 * and labels 'others' segments 'A', 'B', ... by the Deepgram speaker that overlaps them most.
 * Never logs or returns a key.
 */
import { getMeeting, getRecordingMeta, listRecordingParts, listSegments, putMeeting, putSegment } from './db';
import { loadKeys } from './keys';
import type { FetchLike } from './llm';
import { getSettings } from './settings';
import type { Meeting, RecordingMeta, Segment } from './types';

export type DiarizeErrorCode = 'no-audio' | 'no-key' | 'offline' | 'auth' | 'server' | 'bad-reply' | 'missing';

export class DiarizeError extends Error {
  constructor(message: string, readonly code: DiarizeErrorCode) {
    super(message);
    this.name = 'DiarizeError';
  }
}

/** One Deepgram utterance in meeting time. */
export interface Turn { startMs: number; endMs: number; speaker: number }

const MIN_OVERLAP = 0.3;

/** Recording time → meeting time: add the durations of pauses at or before that recording time. */
export function toMeetingMs(recMs: number, pauses: RecordingMeta['pauses'] = []): number {
  return recMs + pauses.reduce((sum, p) => (p.atMs <= recMs ? sum + p.durationMs : sum), 0);
}

/**
 * Picks the Deepgram speaker with the most overlap for each 'others' segment (≥30% of the segment, else
 * unlabeled) and relabels speakers 'A', 'B', ... by first appearance in the transcript.
 * Returns label per segment id (undefined = unlabeled).
 */
export function assignLabels(segments: Segment[], turns: Turn[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const names = new Map<number, string>();
  for (const s of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (s.speaker !== 'others') continue;
    const len = s.endMs - s.startMs;
    const overlap = new Map<number, number>();
    for (const t of turns) {
      const o = Math.min(s.endMs, t.endMs) - Math.max(s.startMs, t.startMs);
      if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
    }
    let best: number | undefined;
    let bestMs = 0;
    for (const [sp, ms] of overlap) if (ms > bestMs) { best = sp; bestMs = ms; }
    if (best === undefined || len <= 0 || bestMs / len < MIN_OVERLAP) { out.set(s.id, undefined); continue; }
    if (!names.has(best)) names.set(best, labelFor(names.size));
    out.set(s.id, names.get(best));
  }
  return out;
}

function labelFor(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function parseTurns(body: unknown, pauses: RecordingMeta['pauses']): Turn[] {
  const utts = (body as { results?: { utterances?: unknown } } | null)?.results?.utterances;
  if (!Array.isArray(utts)) throw new DiarizeError('The voice service sent an unexpected reply.', 'bad-reply');
  return utts
    .filter((u): u is { start: number; end: number; speaker: number } =>
      !!u && typeof u.start === 'number' && typeof u.end === 'number' && typeof u.speaker === 'number')
    .map((u) => ({
      startMs: toMeetingMs(Math.round(u.start * 1000), pauses),
      endMs: toMeetingMs(Math.round(u.end * 1000), pauses),
      speaker: u.speaker,
    }));
}

/**
 * Diarizes a meeting's recording with Deepgram, saves `speakerLabel` on 'others' segments and
 * `meeting.speakers` = {A: {}, B: {}, ...}. Returns the labels found. Throws DiarizeError.
 */
export async function diarize(meetingId: string, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<string[]> {
  const [settings, keys, parts, meta, meeting] = await Promise.all([
    getSettings(), loadKeys(), listRecordingParts(meetingId), getRecordingMeta(meetingId), getMeeting(meetingId),
  ]);
  if (!meeting) throw new DiarizeError('This meeting is no longer on this computer.', 'missing');
  if (!parts.length) throw new DiarizeError('There is no recording to tell voices apart.', 'no-audio');
  const key = keys[settings.diarization.keyName];
  if (!key) throw new DiarizeError('Rekord needs a Deepgram key to tell voices apart.', 'no-key');

  const blob = new Blob(parts.map((p) => p.blob), { type: parts[0].mimeType });
  const q = new URLSearchParams({
    model: settings.diarization.model || 'nova-3',
    diarize: 'true', utterances: 'true', punctuate: 'true',
    language: (meeting.language ?? settings.language) === 'en' ? 'en' : 'multi',
  });
  let res: Response;
  try {
    res = await fetchFn(`https://api.deepgram.com/v1/listen?${q}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
  } catch {
    throw new DiarizeError('Rekord could not reach the voice service.', 'offline');
  }
  if (res.status === 401 || res.status === 403) throw new DiarizeError('The voice service did not accept your key.', 'auth');
  if (!res.ok) throw new DiarizeError(`The voice service returned an error (${res.status}).`, 'server');
  let body: unknown;
  try { body = await res.json(); } catch { throw new DiarizeError('The voice service sent an unexpected reply.', 'bad-reply'); }
  const turns = parseTurns(body, meta?.pauses ?? []);

  const segments = await listSegments(meetingId);
  const labels = assignLabels(segments, turns);
  for (const s of segments) {
    if (s.speaker !== 'others') continue;
    const label = labels.get(s.id);
    if (label !== s.speakerLabel) {
      const next: Segment = { ...s };
      if (label) next.speakerLabel = label; else delete next.speakerLabel;
      await putSegment(next);
    }
  }
  const found = [...new Set([...labels.values()].filter((l): l is string => !!l))]; // first-appearance order
  const speakers: NonNullable<Meeting['speakers']> = {};
  for (const l of found) speakers[l] = {};
  const latest = (await getMeeting(meetingId)) ?? meeting;
  await putMeeting({ ...latest, speakers });
  return found;
}
