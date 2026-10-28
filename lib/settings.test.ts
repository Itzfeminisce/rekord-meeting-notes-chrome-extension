import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, PROVIDERS, getSettings, onSettingsChanged, updateSettings } from './settings';

describe('settings', () => {
  beforeEach(() => fakeBrowser.reset());

  it('returns defaults when nothing is stored', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.transcription.model).toBe('whisper-large-v3-turbo');
    expect(s.onboarded).toBe(false);
  });

  it('persists partial updates in local storage', async () => {
    await updateSettings({ onboarded: true, language: 'auto' });
    const s = await getSettings();
    expect(s.onboarded).toBe(true);
    expect(s.language).toBe('auto');
    expect(s.summary).toEqual(DEFAULT_SETTINGS.summary);
  });

  it('notifies listeners and unsubscribes', async () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    await updateSettings({ onboarded: true });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ onboarded: true }));
    off();
    await updateSettings({ onboarded: false });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('has a base URL for every provider', () => {
    expect(PROVIDERS.groq.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(PROVIDERS.ollama.keyName).toBeUndefined();
  });

  it('has v2 defaults and merges them into old saved settings', async () => {
    const d = await getSettings();
    expect(d.features).toEqual({ ask: true, liveSuggestions: true, speakerNames: true });
    expect(d.diarization).toEqual({ provider: 'deepgram', model: 'nova-3', keyName: 'DEEPGRAM_API_KEY' });
    expect(d.keepAudio).toBe(false);

    const { features: _f, diarization: _d, keepAudio: _k, ...v1 } = DEFAULT_SETTINGS;
    await fakeBrowser.storage.local.set({ settings: { ...v1, onboarded: true } });
    const s = await getSettings();
    expect(s.onboarded).toBe(true);
    expect(s.features.ask).toBe(true);
    expect(s.diarization.model).toBe('nova-3');
    expect(s.keepAudio).toBe(false);

    await fakeBrowser.storage.local.set({ settings: { ...v1, features: { ask: false } } });
    expect((await getSettings()).features).toEqual({ ask: false, liveSuggestions: true, speakerNames: true });
  });
});
