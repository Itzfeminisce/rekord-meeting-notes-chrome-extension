import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { clearKeys, loadKeys, saveKeys } from './keys';

describe('keys', () => {
  beforeEach(() => fakeBrowser.reset());

  it('round-trips keys through session storage', async () => {
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    expect(await loadKeys()).toEqual({ GROQ_API_KEY: 'gsk_test' });
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it('returns an empty map once cleared', async () => {
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    await clearKeys();
    expect(await loadKeys()).toEqual({});
  });
});
