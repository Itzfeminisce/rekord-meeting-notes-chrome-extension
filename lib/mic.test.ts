import { describe, it, expect, vi, afterEach } from 'vitest';
import { queryMic, watchMic, requestMic } from './mic';

afterEach(() => vi.unstubAllGlobals());

function stubPermissions(state: string) {
  const listeners: (() => void)[] = [];
  const status = { state, addEventListener: (_: string, h: () => void) => listeners.push(h), removeEventListener: vi.fn() };
  vi.stubGlobal('navigator', { permissions: { query: async () => status } });
  return { status, listeners };
}

describe('mic', () => {
  it('queryMic returns state, unknown on failure', async () => {
    stubPermissions('denied');
    expect(await queryMic()).toBe('denied');
    vi.stubGlobal('navigator', { permissions: { query: async () => { throw new Error('x'); } } });
    expect(await queryMic()).toBe('unknown');
  });
  it('watchMic reports current and changed state', async () => {
    const { status, listeners } = stubPermissions('prompt');
    const cb = vi.fn();
    const off = watchMic(cb);
    await Promise.resolve(); await Promise.resolve();
    expect(cb).toHaveBeenLastCalledWith('prompt');
    status.state = 'granted';
    listeners.forEach((h) => h());
    expect(cb).toHaveBeenLastCalledWith('granted');
    off();
    expect(status.removeEventListener).toHaveBeenCalled();
  });
  it('requestMic stops tracks and reports result', async () => {
    const stop = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
    expect(await requestMic()).toBe(true);
    expect(stop).toHaveBeenCalled();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new Error('denied'); } } });
    expect(await requestMic()).toBe(false);
  });
});
