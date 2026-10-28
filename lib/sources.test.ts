import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCES, isLastSource, resolveSources, toggleSource } from './sources';

describe('sources', () => {
  it('defaults to both on', () => {
    expect(DEFAULT_SOURCES).toEqual({ mic: true, tab: true });
    expect(resolveSources()).toEqual({ mic: true, tab: true });
    expect(resolveSources({ mic: false })).toEqual({ mic: false, tab: true });
  });
  it('never allows both off', () => {
    expect(resolveSources({ mic: false, tab: false })).toEqual({ mic: true, tab: true });
    const micOnly = toggleSource(DEFAULT_SOURCES, 'tab');
    expect(micOnly).toEqual({ mic: true, tab: false });
    expect(toggleSource(micOnly, 'mic')).toEqual(micOnly);
    expect(toggleSource(micOnly, 'tab')).toEqual(DEFAULT_SOURCES);
  });
  it('flags the last remaining source', () => {
    expect(isLastSource(DEFAULT_SOURCES, 'mic')).toBe(false);
    expect(isLastSource({ mic: true, tab: false }, 'mic')).toBe(true);
    expect(isLastSource({ mic: true, tab: false }, 'tab')).toBe(false);
  });
});
