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

  it('has v3 defaults and keeps a saved v2 Groq user working', async () => {
    const d = await getSettings();
    expect(d.setup).toBe('free');
    expect(d.realtimeBackup).toBe(true);
    expect(d.google).toEqual({ calendar: false, docs: false });
    expect(d.notion).toEqual({});

    const { setup: _s, realtimeBackup: _r, google: _g, notion: _n, ...v2 } = DEFAULT_SETTINGS;
    await fakeBrowser.storage.local.set({
      settings: { ...v2, onboarded: true, keySource: 'paste', summary: { provider: 'groq', model: 'llama-3.3-70b-versatile' } },
    });
    const s = await getSettings();
    expect(s.onboarded).toBe(true);
    expect(s.keySource).toBe('paste');
    expect(s.transcription).toEqual({ provider: 'groq', model: 'whisper-large-v3-turbo' });
    expect(s.setup).toBe('free');
    expect(s.realtimeBackup).toBe(true);
    expect(s.google).toEqual({ calendar: false, docs: false });
    expect(s.notion).toEqual({});

    await fakeBrowser.storage.local.set({ settings: { ...v2, google: { calendar: true }, notion: { pageId: 'p1' } } });
    const partial = await getSettings();
    expect(partial.google).toEqual({ calendar: true, docs: false });
    expect(partial.notion).toEqual({ pageId: 'p1' });
  });
});
