import { describe, expect, it } from 'vitest';
import type { Chunk } from '../types';
import { Chunker, type RecorderLike } from './chunker';
import { rms, toLevel } from './levels';

function setup(opts: { minChunkMs?: number } = {}) {
  let t = 1_000;
  let n = 0;
  const saved: Chunk[] = [];
  const queued: string[] = [];
  const recorders: { started: boolean; stopped: boolean }[] = [];
  const createRecorder = (): RecorderLike => {
    const r = { started: false, stopped: false };
    recorders.push(r);
    return {
      mimeType: 'audio/webm;codecs=opus',
      start: () => { r.started = true; },
      stop: async () => { r.stopped = true; return new Blob(['x']); },
    };
  };
  const chunker = new Chunker({
    meetingId: 'm1', speaker: 'others', startedAt: 1_000, createRecorder,
    saveChunk: async (c) => { saved.push(c); },
    onPending: (c) => queued.push(c.id),
    now: () => t, newId: () => `c${++n}`, ...opts,
  });
  return { chunker, saved, queued, recorders, advance: (ms: number) => { t += ms; } };
}

describe('Chunker', () => {
  it('rotates every 10 s into standalone pending chunks and enqueues them', async () => {
    const s = setup();
    s.chunker.start();
    for (let i = 0; i < 80; i++) { s.advance(125); await s.chunker.tick(0.2); }
    expect(s.saved.map((c) => [c.startMs, c.endMs, c.status])).toEqual([[0, 10_000, 'pending']]);
    expect(s.saved[0]!.audio).toBeInstanceOf(Blob);
    expect(s.saved[0]!.speaker).toBe('others');
    expect(s.queued).toEqual(['c1']);
    expect(s.recorders).toHaveLength(2);
    expect(s.recorders[0]!.stopped).toBe(true);
    expect(s.recorders[1]!.started && !s.recorders[1]!.stopped).toBe(true);
  });

  it('saves a quiet chunk as silent with no audio and does not enqueue it', async () => {
    const s = setup();
    s.chunker.start();
    for (let i = 0; i < 80; i++) { s.advance(125); await s.chunker.tick(0.002); }
    expect(s.saved[0]!.status).toBe('silent');
    expect(s.saved[0]!.audio).toBeUndefined();
    expect(s.queued).toEqual([]);
  });

  it('one loud sample is enough to keep a chunk', async () => {
    const s = setup();
    s.chunker.start();
    for (let i = 0; i < 80; i++) { s.advance(125); await s.chunker.tick(i === 40 ? 0.05 : 0); }
    expect(s.saved[0]!.status).toBe('pending');
  });

  it('flushes the last partial chunk on stop when at least 1 s long', async () => {
    const s = setup();
    s.chunker.start();
    s.advance(2_500); await s.chunker.tick(0.3);
    await s.chunker.stop();
    expect(s.saved.map((c) => [c.startMs, c.endMs, c.status])).toEqual([[0, 2_500, 'pending']]);
    expect(s.recorders[0]!.stopped).toBe(true);
  });

  it('drops a final partial chunk shorter than 1 s but still stops the recorder', async () => {
    const s = setup();
    s.chunker.start();
    s.advance(10_000); await s.chunker.tick(0.3);
    s.advance(500); await s.chunker.tick(0.3);
    await s.chunker.stop();
    expect(s.saved).toHaveLength(1);
    expect(s.recorders.every((r) => r.stopped)).toBe(true);
    await s.chunker.tick(0.3);
    expect(s.recorders).toHaveLength(2);
  });
});

describe('levels', () => {
  it('computes rms and a clamped meter level', () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
    expect(toLevel(0)).toBe(0);
    expect(toLevel(1)).toBe(1);
    expect(toLevel(0.125)).toBeCloseTo(0.5);
  });
});
