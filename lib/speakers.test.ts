import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDB, getMeeting, listRecordingParts, listSegments, putMeeting, putRecordingPart, putSegment } from './db';
import { saveKeys } from './keys';
import { DEFAULT_SETTINGS, updateSettings } from './settings';
import { chipsFor, displayName, inviteCandidates, matchInvitee, parseSuggestions, unnamedInvitees, runSpeakerStep, saveSpeakerNames, skipSpeakers, speakerStats, suggestNames, toRecordingMs } from './speakers';

const llm = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const dg = () => new Response(JSON.stringify({ results: { utterances: [{ start: 0, end: 4, speaker: 0 }, { start: 5, end: 9, speaker: 1 }] } }));

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
    const s2 = (await listSegments('m1')).find((s) => s.id === 's2');
    if (!s2) throw new Error('fixture segment s2 missing');
    await putSegment({ ...s2, speakerLabel: 'B' });
    const f = vi.fn(async () => llm({ A: null, B: { name: 'Maria', evidenceAt: '0:00' } }));
    expect(await suggestNames('m1', f)).toEqual({ A: {}, B: { suggested: 'Maria', evidenceMs: 0 } });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toContain('[0:05] Speaker B: Sure.');
    expect((await getMeeting('m1'))?.speakers?.B?.suggested).toBe('Maria');
  });
});

describe('runSpeakerStep', () => {
  it('diarizes, suggests names and marks the step ready', async () => {
    const step = await runSpeakerStep('m1', { deepgram: async () => dg(), llm: async () => llm({ A: null, B: { name: 'Maria', evidenceAt: '0:00' } }) });
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

  it('keeps the labels and marks the step ready when name suggestions fail', async () => {
    const step = await runSpeakerStep('m1', { deepgram: async () => dg(), llm: async () => new Response('x', { status: 500 }) });
    expect(step).toBe('ready');
    const m = await getMeeting('m1');
    expect(m?.speakerStep).toBe('ready');
    expect(m?.speakers).toEqual({ A: {}, B: {} });
    expect((await listSegments('m1')).map((s) => s.speakerLabel)).toEqual(['A', 'B']);
  });

  it('reruns a stale running step, and joins a run already in flight', async () => {
    await putMeeting({ ...(await getMeeting('m1'))!, speakerStep: 'running' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const deepgram = vi.fn(async () => { await gate; return dg(); });
    const llmFn = async () => llm({});
    const first = runSpeakerStep('m1', { deepgram, llm: llmFn });
    const second = runSpeakerStep('m1', { deepgram, llm: llmFn });
    release();
    expect(await first).toBe('ready');
    expect(await second).toBe('ready');
    expect(deepgram).toHaveBeenCalledTimes(1);
  });

  it('skips and deletes the audio when there is no "others" speech', async () => {
    for (const s of await listSegments('m1')) await putSegment({ ...s, speaker: 'you' });
    const f = vi.fn();
    expect(await runSpeakerStep('m1', { deepgram: f })).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
    expect((await getMeeting('m1'))?.speakerStep).toBe('skipped');
    expect(await listRecordingParts('m1')).toHaveLength(0);
  });

  it('keeps the audio on skip when Settings keepAudio is on', async () => {
    await updateSettings({ keepAudio: true });
    for (const s of await listSegments('m1')) await putSegment({ ...s, speaker: 'you' });
    expect(await runSpeakerStep('m1')).toBe('skipped');
    expect(await listRecordingParts('m1')).toHaveLength(1);
  });

  it('fails when no segment gets a label, keeping You/Others', async () => {
    const none = new Response(JSON.stringify({ results: { utterances: [{ start: 20, end: 21, speaker: 0 }] } }));
    const llmFn = vi.fn();
    expect(await runSpeakerStep('m1', { deepgram: async () => none, llm: llmFn })).toBe('failed');
    expect(llmFn).not.toHaveBeenCalled();
    expect((await getMeeting('m1'))?.speakerStep).toBe('failed');
    expect((await listSegments('m1')).every((s) => !s.speakerLabel)).toBe(true);
  });
});

describe('speaker screen helpers', () => {
  const label = async () => {
    const [s1, s2] = await listSegments('m1');
    await putSegment({ ...s1!, speakerLabel: 'A' });
    await putSegment({ ...s2!, speakerLabel: 'B' });
    await putMeeting({ ...(await getMeeting('m1'))!, speakerStep: 'ready', speakers: { A: { suggested: 'Maria' }, B: {} } });
  };

  it('resolves display names: name, else Speaker X, else Others; You stays You', () => {
    const sp = { A: { name: ' Maria ' }, B: {} };
    expect(displayName({ speaker: 'others', speakerLabel: 'A' }, sp)).toBe('Maria');
    expect(displayName({ speaker: 'others', speakerLabel: 'B' }, sp)).toBe('Speaker B');
    expect(displayName({ speaker: 'others' }, sp)).toBe('Others');
    expect(displayName({ speaker: 'you', speakerLabel: 'A' }, sp)).toBe('You');
  });

  it('computes talk time, lines and the longest line per label', async () => {
    await label();
    const st = speakerStats(await listSegments('m1'));
    expect(st.map((x) => [x.label, x.talkMs, x.lines, x.quote?.id])).toEqual([['A', 4000, 1, 's1'], ['B', 4000, 1, 's2']]);
  });

  it('maps meeting time back to recording time across pauses', () => {
    expect(toRecordingMs(70_000, [{ atMs: 30_000, durationMs: 10_000 }])).toBe(60_000);
    expect(toRecordingMs(20_000, [{ atMs: 30_000, durationMs: 10_000 }])).toBe(20_000);
  });

  it('save stores typed names, marks saved and deletes the audio', async () => {
    await label();
    await saveSpeakerNames('m1', { names: { A: ' Priya ', B: '' } });
    const m = await getMeeting('m1');
    expect(m?.speakerStep).toBe('saved');
    expect(m?.speakers).toEqual({ A: { suggested: 'Maria', name: 'Priya' }, B: {} });
    expect(await listRecordingParts('m1')).toEqual([]);
  });

  it('save keeps the audio when Keep audio files is on', async () => {
    await label();
    await updateSettings({ keepAudio: true });
    await saveSpeakerNames('m1', { names: {} });
    expect(await listRecordingParts('m1')).toHaveLength(1);
  });

  it('merge relabels segments into one speaker', async () => {
    await label();
    await saveSpeakerNames('m1', { names: { A: 'Priya', B: 'x' }, merges: { B: 'A' } });
    const m = await getMeeting('m1');
    expect(Object.keys(m?.speakers ?? {})).toEqual(['A']);
    expect(m?.speakers?.A?.name).toBe('Priya');
    expect((await listSegments('m1')).map((g) => g.speakerLabel)).toEqual(['A', 'A']);
  });

  it('skip marks skipped, keeps labels and deletes the audio', async () => {
    await label();
    await skipSpeakers('m1');
    expect((await getMeeting('m1'))?.speakerStep).toBe('skipped');
    expect((await getMeeting('m1'))?.speakers?.A?.name).toBeUndefined();
    expect(await listRecordingParts('m1')).toEqual([]);
  });
});

describe('runSpeakerStep without a Deepgram key', () => {
  it('skips quietly and drops the audio', async () => {
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    expect(await runSpeakerStep('m1')).toBe('skipped');
    expect(await listRecordingParts('m1')).toEqual([]);
  });
});

describe('invite matching', () => {
  const event = { id: 'e', title: 'T', start: 0, end: 1, attendees: [
    { email: 'me@x.com', name: 'Me', self: true }, { email: 'priya@x.com', name: 'Priya Shah' },
    { email: 'sam@x.com' }, { email: 'leo@x.com', name: 'Leo' }, { email: 'SAM@x.com' },
  ] };
  const cands = inviteCandidates(event);

  it('drops you and duplicates, naming email-only invitees from the email', () => {
    expect(cands.map((c) => c.name)).toEqual(['Priya Shah', 'sam', 'Leo']);
    expect(inviteCandidates(undefined)).toEqual([]);
  });
  it('matches a suggested name to an invitee by full or unique first name', () => {
    expect(matchInvitee('Priya', cands)?.email).toBe('priya@x.com');
    expect(matchInvitee('leo', cands)?.email).toBe('leo@x.com');
    expect(matchInvitee('Maria', cands)).toBeUndefined();
    expect(matchInvitee('Priya', [...cands, { name: 'Priya Rao', email: 'r@x.com' }])).toBeUndefined();
  });
  it('leaves out names already chosen on other labels from the chips', () => {
    expect(chipsFor('B', cands, { A: 'Priya Shah', B: 'Leo' }).map((c) => c.name)).toEqual(['sam', 'Leo']);
  });
  it('lists invitees nobody was named as', () => {
    expect(unnamedInvitees(cands, { A: 'Priya Shah', B: 'Leo' }).map((c) => c.name)).toEqual(['sam']);
  });
});
