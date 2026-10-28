import { describe, expect, it } from 'vitest';
import { connectionCopy, pendingLabel, retryIn, type LostState } from './connection';

const lost = (p: Partial<LostState>): LostState => ({ ok: false, reason: 'server', pendingChunks: 8, ...p });

describe('connection copy', () => {
  it('formats pending chunks as a clock', () => {
    expect(pendingLabel(8)).toBe('1:20');
    expect(pendingLabel(-1)).toBe('0:00');
  });
  it('matches the frame for a server error', () => {
    expect(connectionCopy(lost({}), 'groq', 0).body).toBe(
      'Groq isn’t responding. Rekord is still recording and will catch up the last 1:20 as soon as it’s back.',
    );
  });
  it('covers offline, rate-limit and auth', () => {
    expect(connectionCopy(lost({ reason: 'offline' }), 'groq', 0).body).toContain('offline');
    expect(connectionCopy(lost({ reason: 'rate-limited', retryAt: 12_000 }), 'openai', 0).body).toContain('OpenAI is busy');
    expect(connectionCopy(lost({ reason: 'rate-limited', retryAt: 12_000 }), 'openai', 0).body).toContain('0:12');
    expect(connectionCopy(lost({ reason: 'auth' }), 'groq', 0).action.label).toBe('Open Settings');
  });
  it('retryIn never goes negative', () => {
    expect(retryIn(undefined, 5)).toBeNull();
    expect(retryIn(1000, 5000)).toBe('0:00');
  });
});

describe('retry guard constants', () => {
  it('guards for about two seconds', async () => {
    const { RETRY_GUARD_MS } = await import('./connection');
    expect(RETRY_GUARD_MS).toBe(2000);
  });
});
