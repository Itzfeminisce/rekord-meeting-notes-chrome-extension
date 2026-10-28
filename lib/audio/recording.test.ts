import { describe, expect, it } from 'vitest';
import { ContinuousRecording, PART_MS, shouldRecord, type SliceRecorder } from './recording';
import type { RecordingMeta, RecordingPart, Settings, TranscriberConfig } from '../types';

function setup(opts: { failPart?: boolean } = {}) {
  let t = 1_000;
  let n = 0;
  const parts: RecordingPart[] = [];
  const metas: RecordingMeta[] = [];
  const calls: string[] = [];
  const deleted: string[] = [];
  let emit: (b: Blob) => void = () => undefined;
  const rec = new ContinuousRecording({
    meetingId: 'm1', startedAt: 1_000,
    now: () => t, newId: () => `p${n++}`,
    createRecorder: (onData) => {
      emit = onData;
      const r: SliceRecorder = {
        mimeType: 'audio/webm;codecs=opus',
        start: (ms) => calls.push(`start:${ms}`),
        pause: () => calls.push('pause'),
        resume: () => calls.push('resume'),
        stop: async () => { calls.push('stop'); emit(new Blob(['last'])); },
      };
      return r;
    },
    savePart: async (p) => { if (opts.failPart && p.seq === 0) throw new Error('disk'); parts.push(p); },
    saveMeta: async (m) => { metas.push(m); },
    deleteRecording: async (id) => { deleted.push(id); },
  });
  return { rec, parts, metas, calls, deleted, emit: (s: string) => emit(new Blob([s])), at: (ms: number) => (t = 1_000 + ms) };
}

const settings = (speakerNames: boolean) =>
  ({ features: { ask: true, liveSuggestions: true, speakerNames }, diarization: { provider: 'deepgram', model: 'nova-3', keyName: 'DEEPGRAM_API_KEY' } }) as unknown as Settings;
const config = (speakerNames: boolean, keys: Record<string, string>): TranscriberConfig => ({ settings: settings(speakerNames), keys });

describe('shouldRecord', () => {
  it('records only with tab audio, the switch on and a Deepgram key', () => {
    expect(shouldRecord(config(true, { DEEPGRAM_API_KEY: 'dg_test' }), true)).toBe(true);
    expect(shouldRecord(config(false, { DEEPGRAM_API_KEY: 'dg_test' }), true)).toBe(false);
    expect(shouldRecord(config(true, { GROQ_API_KEY: 'gsk_test' }), true)).toBe(false);
    expect(shouldRecord(config(true, { DEEPGRAM_API_KEY: 'dg_test' }), false)).toBe(false);
    expect(shouldRecord(undefined, true)).toBe(false);
  });
});

describe('ContinuousRecording', () => {
  it('saves each slice as a part in seq order, flushing the last one on stop', async () => {
    const { rec, parts, metas, calls, emit } = setup();
    rec.start();
    expect(calls).toEqual([`start:${PART_MS}`]);
    emit('a');
    emit('');           // empty slices are skipped
    emit('b');
    expect(await rec.stop()).toBe(true);
    expect(parts.map((p) => [p.seq, p.id, p.meetingId, p.mimeType])).toEqual([
      [0, 'p0', 'm1', 'audio/webm;codecs=opus'],
      [1, 'p1', 'm1', 'audio/webm;codecs=opus'],
      [2, 'p2', 'm1', 'audio/webm;codecs=opus'],
    ]);
    expect(await parts[2]!.blob.text()).toBe('last');
    expect(metas[0]).toEqual({ meetingId: 'm1', pauses: [] });
    expect(calls.at(-1)).toBe('stop');
  });

  it('records pauses in recording time and closes an open pause on stop', async () => {
    const { rec, metas, calls, at } = setup();
    rec.start();
    at(10_000); rec.pause();
    rec.pause(); // no-op while paused
    at(15_000); rec.resume();
    at(25_000); rec.pause();
    at(28_000); await rec.stop();
    expect(calls).toEqual([`start:${PART_MS}`, 'pause', 'resume', 'pause', 'stop']);
    expect(metas.at(-1)).toEqual({ meetingId: 'm1', pauses: [{ atMs: 10_000, durationMs: 5_000 }, { atMs: 20_000, durationMs: 3_000 }] });
  });

  it('drops the recording when a part fails to save, and reports nothing recorded without parts', async () => {
    const a = setup({ failPart: true });
    a.rec.start();
    a.emit('x');
    expect(await a.rec.stop()).toBe(false);
    expect(a.parts).toEqual([]);
    expect(a.deleted).toEqual(['m1']);

    const b = new ContinuousRecording({
      meetingId: 'm2', startedAt: 0, savePart: async () => undefined, saveMeta: async () => undefined,
      createRecorder: () => ({ mimeType: '', start: () => undefined, pause: () => undefined, resume: () => undefined, stop: async () => undefined }),
    });
    b.start();
    expect(await b.stop()).toBe(false);
  });

  it('returns false and deletes saved parts when a later savePart rejects once', async () => {
    const parts: number[] = [];
    const deleted: string[] = [];
    let fail = true;
    let emit: (b: Blob) => void = () => undefined;
    const rec = new ContinuousRecording({
      meetingId: 'm3', startedAt: 0, saveMeta: async () => undefined,
      savePart: async (p) => { if (p.seq === 1 && fail) { fail = false; throw new Error('disk'); } parts.push(p.seq); },
      deleteRecording: async (id) => { deleted.push(id); },
      createRecorder: (onData) => { emit = onData; return { mimeType: '', start: () => undefined, pause: () => undefined, resume: () => undefined, stop: async () => { onData(new Blob(['last'])); } }; },
    });
    rec.start();
    emit(new Blob(['a']));
    expect(await rec.stop()).toBe(false);
    expect(parts).toEqual([0]);
    expect(deleted).toEqual(['m3']);
  });
});
