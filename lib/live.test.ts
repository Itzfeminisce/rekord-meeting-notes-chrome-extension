import { describe, expect, it } from 'vitest';
import { buildTimeline, elapsedMs, hostOf, levelBars, mergeSegment, nearBottom, newMarker, newNote } from './live';
import type { Segment } from './types';

const seg = (id: string, startMs: number, text = 'hi'): Segment => ({
  id, meetingId: 'm', speaker: 'you', startMs, endMs: startMs + 10, text, chunkId: 'c' + id,
});

describe('live helpers', () => {
  it('mergeSegment sorts and dedupes by id', () => {
    const a = mergeSegment(mergeSegment([], seg('2', 200)), seg('1', 100));
    expect(a.map((s) => s.id)).toEqual(['1', '2']);
    const b = mergeSegment(a, seg('1', 100, 'new'));
    expect(b).toHaveLength(2);
    expect(b[0]?.text).toBe('new');
    expect(a[0]?.text).toBe('hi');
  });

  it('buildTimeline interleaves and skips empty segments', () => {
    const t = buildTimeline(
      [seg('1', 100), seg('2', 300), seg('3', 400, '  ')],
      [{ id: 'n', meetingId: 'm', atMs: 200, text: 'x', createdAt: 0 }],
      [newMarker('m', 100, 'decision')],
    );
    expect(t.map((i) => i.kind)).toEqual(['segment', 'marker', 'note', 'segment']);
  });

  it('newNote trims and rejects blank', () => {
    expect(newNote('m', 5, '   ')).toBeNull();
    expect(newNote('m', 5, ' a ')?.text).toBe('a');
  });

  it('elapsedMs never negative', () => {
    expect(elapsedMs(1000, 500)).toBe(0);
    expect(elapsedMs(1000, 4000)).toBe(3000);
  });

  it('levelBars clamps', () => {
    expect(levelBars(0)).toEqual([4, 4, 4, 4, 4]);
    expect(Math.max(...levelBars(5))).toBe(20);
    expect(levelBars(NaN)).toHaveLength(5);
  });

  it('hostOf only for web urls', () => {
    expect(hostOf('https://meet.google.com/abc')).toBe('meet.google.com');
    expect(hostOf('chrome://extensions')).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });

  it('nearBottom', () => {
    expect(nearBottom({ scrollTop: 950, clientHeight: 50, scrollHeight: 1000 })).toBe(true);
    expect(nearBottom({ scrollTop: 0, clientHeight: 50, scrollHeight: 1000 })).toBe(false);
  });
});
