import type { ProviderConfig, ProviderId, Settings } from './types';

const STORAGE_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  transcription: { provider: 'groq', model: 'whisper-large-v3-turbo' },
  summary: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  keySource: 'penv',
  penv: { org: 'penvhq', project: 'meeting-notes-taker', env: 'testing' },
  language: 'en',
  onboarded: false,
  features: { ask: true, liveSuggestions: true, speakerNames: true },
  diarization: { provider: 'deepgram', model: 'nova-3', keyName: 'DEEPGRAM_API_KEY' },
  keepAudio: false,
  setup: 'free',
  realtimeBackup: true,
  google: { calendar: false, docs: false },
  notion: {},
};

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  groq: { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyName: 'GROQ_API_KEY' },
  openrouter: { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyName: 'OPENROUTER_API_KEY' },
  ollama: { id: 'ollama', baseUrl: 'http://localhost:11434/v1' },
  openai: { id: 'openai', baseUrl: 'https://api.openai.com/v1', keyName: 'OPENAI_API_KEY' },
  anthropic: { id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyName: 'ANTHROPIC_API_KEY' },
};

function merge(stored: Partial<Settings> | undefined): Settings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    transcription: { ...DEFAULT_SETTINGS.transcription, ...s.transcription },
    summary: { ...DEFAULT_SETTINGS.summary, ...s.summary },
    penv: { ...DEFAULT_SETTINGS.penv, ...s.penv },
    features: { ...DEFAULT_SETTINGS.features, ...s.features },
    diarization: { ...DEFAULT_SETTINGS.diarization, ...s.diarization },
    google: { ...DEFAULT_SETTINGS.google, ...s.google },
    notion: { ...DEFAULT_SETTINGS.notion, ...s.notion },
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return merge(stored[STORAGE_KEY] as Partial<Settings> | undefined);
}

/** Shallow-merges top-level fields; nested objects passed are replaced whole. Returns the new settings. */
export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...partial };
  await browser.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Calls `cb` with the full settings whenever they change. Returns an unsubscribe function. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && STORAGE_KEY in changes) cb(merge(changes[STORAGE_KEY].newValue as Partial<Settings>));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
