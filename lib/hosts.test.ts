import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEEPGRAM_HOSTS, hostsForKeys, hostsForSettings, OLLAMA_HOSTS, requestHosts } from './hosts';

describe('hosts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps key names and providers to their hosts', () => {
    expect(hostsForKeys(['DEEPGRAM_API_KEY', 'UNKNOWN'])).toEqual(DEEPGRAM_HOSTS);
    expect(hostsForSettings({ transcription: { provider: 'groq', model: 'm' }, summary: { provider: 'groq', model: 'm' } })).toEqual(['https://api.groq.com/*']);
    expect(hostsForSettings({ transcription: { provider: 'deepgram', model: 'm' }, summary: { provider: 'ollama', model: 'm' } })).toEqual([...DEEPGRAM_HOSTS, ...OLLAMA_HOSTS]);
  });

  it('asks only for hosts the manifest lists, and never throws', async () => {
    const request = vi.fn(async () => true);
    (browser as unknown as { permissions: { request: typeof request } }).permissions = { ...browser.permissions, request };
    expect(await requestHosts(['https://api.notion.com/*', 'http://localhost:9999/*'])).toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.notion.com/*'] });
    expect(await requestHosts(['http://localhost:9999/*'])).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error('needs a user gesture'));
    expect(await requestHosts(['https://api.notion.com/*'])).toBe(false);
  });
});
