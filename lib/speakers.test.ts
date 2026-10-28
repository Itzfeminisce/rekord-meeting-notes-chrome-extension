import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDB, getMeeting, listRecordingParts, listSegments, putMeeting, putRecordingPart, putSegment } from './db';
import { saveKeys } from './keys';
import { DEFAULT_SETTINGS, updateSettings } from './settings';
import { parseSuggestions, runSpeakerStep, suggestNames } from './speakers';

const llm = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const dg = new Response(JSON.stringify({ results: { utterances: [{ start: 0, end: 4, speaker: 0 }, { start: 5, end: 9, speaker: 1 }] } }));

beforeEach(async () => {
  fakeBrowser.reset();
  await closeDB();
  globalThis.indexedDB = new IDBFactory();
  await saveKeys({ DEEPGRAM_API_KEY: 'dg_test', GROQ_API_KEY: 'gsk_test' });
  await putMeeting({ id: 'm1', title: 'T', startedAt: 0, status: 'done', language: 'en', speakerStep: 'pending' });
  await putRecordingPart({ id: 'p1', meetingId: 'm1', seq: 0, blob: new Blob(['a']), mimeType: 'audio/webm' });
  await putSegment({ id: 's1', meetingId: 'm1', speaker: 'others', startMs: 0, endMs: 4_000, text: 'Thanks Maria, over to you.', chunkId: 'c' });
  await putSegment({ id: 's2', meetingId: 'm1', speaker: 'others', startMs: 5_000, endMs: 9_000, text: 'Sure.', chunkId: 'c' });
});

describe('parseSuggestions', () => {
  it('keeps clear names with evidence and drops nulls, junk and unknown labels', () => {
    expect(parseSuggestions(JSON.stringify({ A: { name: ' Maria ', evidenceAt: '1:05' }, B: null, C: { name: 'X' }, D: { name: '' } }), ['A', 'B', 'D']))
      .toEqual({ A: { suggested: 'Maria', evidenceMs: 65_000 } });
    expect(parseSuggestions(JSON.stringify({ 'Speaker A': { name: 'Li', evidenceAtMs: 1200 } }), ['A'])).toEqual({ A: { suggested: 'Li', evidenceMs: 1200 } });
    expect(parseSuggestions('not json', ['A'])).toEqual({});
  });
});

describe('suggestNames', () => {
  it('sends labelled transcript lines and stores suggestions', async () => {
    await putMeeting({ ...(await getMeeting('m1'))!, speakers: { A: {}, B: {} } });
    await putSegment({ ...(await listSegments('m1'))[1], speakerLabel: 'B' });
    const f = vi.fn(async () => llm({ A: null, B: { name: 'Maria', evidenceAt: '0:00' } }));
    expect(await suggestNames('m1', f)).toEqual({ A: {}, B: { suggested: 'Maria', evidenceMs: 0 } });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toContain('[0:05] Speaker B: Sure.');
    expect((await getMeeting('m1'))?.speakers?.B?.suggested).toBe('Maria');
  });
});

describe('runSpeakerStep', () => {
  it('diarizes, suggests names and marks the step ready', async () => {
    const step = await runSpeakerStep('m1', { deepgram: async () => dg, llm: async () => llm({ A: null, B: { name: 'Maria', evidenceAt: '0:00' } }) });
    expect(step).toBe('ready');
    const m = await getMeeting('m1');
    expect(m?.speakerStep).toBe('ready');
    expect(m?.speakers).toEqual({ A: {}, B: { suggested: 'Maria', evidenceMs: 0 } });
  });

  it('marks the step failed on any error and keeps the transcript unlabelled', async () => {
    const step = await runSpeakerStep('m1', { deepgram: async () => new Response('x', { status: 500 }) });
    expect(step).toBe('failed');
    expect((await getMeeting('m1'))?.speakerStep).toBe('failed');
    expect((await listSegments('m1')).every((s) => !s.speakerLabel)).toBe(true);
    expect(await listRecordingParts('m1')).toHaveLength(1); // kept for retry
  });

  it('skips when the switch is off, and does nothing unless pending', async () => {
    await updateSettings({ features: { ...DEFAULT_SETTINGS.features, speakerNames: false } });
    const f = vi.fn();
    expect(await runSpeakerStep('m1', { deepgram: f })).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
    expect(await listRecordingParts('m1')).toHaveLength(0);
    expect(await runSpeakerStep('m1')).toBeUndefined();
  });
});
