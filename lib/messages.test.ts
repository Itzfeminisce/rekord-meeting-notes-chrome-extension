import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { onMessage, send } from './messages';

describe('messages', () => {
  beforeEach(() => fakeBrowser.reset());

  it('does not throw when nothing is listening', async () => {
    await expect(send({ type: 'recording/get-state' })).resolves.toBeUndefined();
  });

  it('delivers messages and replies', async () => {
    const off = onMessage((msg) => (msg.type === 'recording/get-state' ? { status: 'idle' } : undefined));
    expect(await send({ type: 'recording/get-state' })).toEqual({ status: 'idle' });
    off();
  });

  it('carries the v3 stream and app-audio messages', async () => {
    const seen: string[] = [];
    const off = onMessage((msg) => {
      if (msg.type === 'stream/state') seen.push(msg.state);
      else if (msg.type === 'app-audio/silent' || msg.type === 'app-audio/ended') seen.push(msg.type);
      return true;
    });
    await send({ type: 'stream/state', state: 'backup' });
    await send({ type: 'app-audio/silent' });
    await send({ type: 'app-audio/ended' });
    expect(seen).toEqual(['backup', 'app-audio/silent', 'app-audio/ended']);
    off();
  });
});
