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
});
