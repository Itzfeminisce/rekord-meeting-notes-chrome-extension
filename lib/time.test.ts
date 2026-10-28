import { describe, expect, it } from 'vitest';
import { formatClock, formatDuration } from './time';

describe('time', () => {
  it('formats clock offsets', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(724_000)).toBe('12:04');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });
  it('formats durations', () => {
    expect(formatDuration(42 * 60_000)).toBe('42 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 5 min');
    expect(formatDuration(120 * 60_000)).toBe('2 h');
  });
});
