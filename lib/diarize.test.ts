import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDB, getMeeting, listSegments, putMeeting, putRecordingMeta, putRecordingPart, putSegment } from './db';
import { assignLabels, diarize, DiarizeError, toMeetingMs } from './diarize';
import { saveKeys } from './keys';
import type { Segment } from './types';

const seg = (id: string, startMs: number, endMs: number, speaker: Segment['speaker'] = 'others'): Segment =>
  ({ id, meetingId: 'm1', speaker, startMs, endMs, text: id, chunkId: 'c' });
const dg = (utterances: { start: number; end: number; speaker: number }[]) =>
  new Response(JSON.stringify({ results: { utterances } }), { status: 200 });

beforeEach(async () => {
  fakeBrowser.reset();
  await closeDB();
  globalThis.indexedDB = new IDBFactory();
  await saveKeys({ DEEPGRAM_API_KEY: 'dg_test' });
  await putMeeting({ id: 'm1', title: 'T', startedAt: 0, status: 'done', language: 'en', speakerStep: 'pending' });
  await putRecordingPart({ id: 'p2', meetingId: 'm1', seq: 1, blob: new Blob(['b']), mimeType: 'audio/webm;codecs=opus' });
  await putRecordingPart({ id: 'p1', meetingId: 'm1', seq: 0, blob: new Blob(['a']), mimeType: 'audio/webm;codecs=opus' });
});

describe('toMeetingMs', () => {
  it('adds the durations of pauses at or before the recording time', () => {
    const pauses = [{ atMs: 10_000, durationMs: 5_000 }, { atMs: 20_000, durationMs: 1_000 }];
    expect(toMeetingMs(5_000, pauses)).toBe(5_000);
    expect(toMeetingMs(10_000, pauses)).toBe(15_000);
    expect(toMeetingMs(25_000, pauses)).toBe(31_000);
  });
});

describe('assignLabels', () => {
  it('picks the most-overlapping speaker, needs 30%, relabels by first appearance, skips "you"', () => {
    const segs = [seg('s3', 20_000, 30_000), seg('s1', 0, 10_000), seg('y', 0, 10_000, 'you'), seg('s2', 10_000, 20_000), seg('s4', 30_000, 40_000)];
    const turns = [
      { startMs: 0, endMs: 3_000, speaker: 0 }, { startMs: 3_000, endMs: 10_000, speaker: 4 },
      { startMs: 10_000, endMs: 20_000, speaker: 0 }, { startMs: 20_000, endMs: 30_000, speaker: 4 },
      { startMs: 30_000, endMs: 32_000, speaker: 0 },
    ];
    const l = assignLabels(segs, turns);
    expect(l.get('s1')).toBe('A'); // speaker 4 has 70% of the first segment
    expect(l.get('s2')).toBe('B');
    expect(l.get('s3')).toBe('A');
    expect(l.get('s4')).toBeUndefined(); // 20% overlap
    expect(l.has('y')).toBe(false);
  });
});

describe('diarize', () => {
  it('posts the joined recording to Deepgram and saves labels in meeting time', async () => {
    await putRecordingMeta({ meetingId: 'm1', pauses: [{ atMs: 5_000, durationMs: 60_000 }] });
    await putSegment(seg('s1', 0, 4_000));
    await putSegment(seg('s2', 66_000, 70_000)); // after the pause in meeting time
    await putSegment(seg('y', 0, 4_000, 'you'));
    const f = vi.fn(async () => dg([{ start: 0, end: 4, speaker: 1 }, { start: 6, end: 10, speaker: 1 }]));
    expect(await diarize('m1', f)).toEqual(['A']);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(u.searchParams)).toEqual({ model: 'nova-3', diarize: 'true', utterances: 'true', punctuate: 'true', language: 'en' });
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Token dg_test', 'Content-Type': 'audio/webm;codecs=opus' });
    expect(await (init.body as Blob).text()).toBe('ab');
    const segs = await listSegments('m1');
    expect(segs.map((s) => [s.id, s.speakerLabel])).toEqual([['s1', 'A'], ['y', undefined], ['s2', 'A']]);
    expect((await getMeeting('m1'))?.speakers).toEqual({ A: {} });
  });

  it('fails without a key, without audio, and on an HTTP error', async () => {
    const f = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(diarize('m1', f)).rejects.toMatchObject({ code: 'auth' });
    await saveKeys({});
    await expect(diarize('m1', f)).rejects.toBeInstanceOf(DiarizeError);
    await expect(diarize('nope', f)).rejects.toMatchObject({ code: 'missing' });
  });
});
