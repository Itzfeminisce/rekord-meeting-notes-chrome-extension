import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { DEEPGRAM_HOSTS, hostsForKeys, hostsForSettings, OLLAMA_HOSTS, requestHosts } from './hosts';

describe('hosts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps key names and providers to their hosts', () => {
    expect(hostsForKeys(['DEEPGRAM_API_KEY', 'UNKNOWN'])).toEqual(DEEPGRAM_HOSTS);
    const base = { features: DEFAULT_SETTINGS.features, diarization: DEFAULT_SETTINGS.diarization };
    const groq = { ...base, transcription: { provider: 'groq', model: 'm' }, summary: { provider: 'groq', model: 'm' } } as const;
    expect(hostsForSettings(groq)).toEqual(['https://api.groq.com/*']);
    expect(hostsForSettings({ ...base, transcription: { provider: 'deepgram', model: 'm' }, summary: { provider: 'ollama', model: 'm' } }, ['DEEPGRAM_API_KEY'])).toEqual([...DEEPGRAM_HOSTS, ...OLLAMA_HOSTS]);
  });

  it('adds Deepgram for speaker names only when that key is there and the feature is on', () => {
    const base = { features: DEFAULT_SETTINGS.features, diarization: DEFAULT_SETTINGS.diarization };
    const groq = { ...base, transcription: { provider: 'groq', model: 'm' }, summary: { provider: 'groq', model: 'm' } } as const;
    expect(hostsForSettings(groq, ['GROQ_API_KEY', 'DEEPGRAM_API_KEY'])).toEqual(['https://api.groq.com/*', ...DEEPGRAM_HOSTS]);
    expect(hostsForSettings({ ...groq, features: { ...base.features, speakerNames: false } }, ['DEEPGRAM_API_KEY'])).toEqual(['https://api.groq.com/*']);
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
