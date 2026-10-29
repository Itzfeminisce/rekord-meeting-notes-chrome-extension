/** Optional host permissions: which sites each feature talks to, and asking Chrome for them inside a click. */
import type { Settings } from './types';

export const PENV_HOSTS = ['https://penv.cloud/*'];
export const DEEPGRAM_HOSTS = ['https://api.deepgram.com/*', 'wss://api.deepgram.com/*'];
// oauth2.googleapis.com is only for revoking the token on disconnect.
export const GOOGLE_HOSTS = ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'];
export const NOTION_HOSTS = ['https://api.notion.com/*'];
export const OLLAMA_HOSTS = ['http://localhost:11434/*'];

const KEY_HOSTS: Record<string, string[]> = {
  GROQ_API_KEY: ['https://api.groq.com/*'],
  OPENAI_API_KEY: ['https://api.openai.com/*'],
  OPENROUTER_API_KEY: ['https://openrouter.ai/*'],
  ANTHROPIC_API_KEY: ['https://api.anthropic.com/*'],
  DEEPGRAM_API_KEY: DEEPGRAM_HOSTS,
  NOTION_TOKEN: NOTION_HOSTS,
};

/** Every host Rekord may ask for; the manifest lists exactly these as optional_host_permissions. */
export const OPTIONAL_HOSTS = [...new Set([...PENV_HOSTS, ...Object.values(KEY_HOSTS).flat(), ...GOOGLE_HOSTS, ...OLLAMA_HOSTS])];

/** Hosts for the services these key names unlock. */
export function hostsForKeys(names: string[]): string[] {
  return [...new Set(names.flatMap((n) => KEY_HOSTS[n] ?? []))];
}

/** Hosts the chosen providers talk to, plus Deepgram for speaker names when its key is among `keyNames`. */
export function hostsForSettings(s: Pick<Settings, 'transcription' | 'summary' | 'features' | 'diarization'>, keyNames: string[] = []): string[] {
  const names = [`${s.transcription.provider.toUpperCase()}_API_KEY`, `${s.summary.provider.toUpperCase()}_API_KEY`];
  if (s.features.speakerNames && keyNames.includes(s.diarization.keyName)) names.push(s.diarization.keyName);
  return [...new Set([...hostsForKeys(names), ...(s.summary.provider === 'ollama' ? OLLAMA_HOSTS : [])])];
}

/**
 * Asks Chrome for these hosts. Call it before any other await in a click handler, so the gesture still counts.
 * Hosts outside OPTIONAL_HOSTS are dropped (Chrome would refuse the whole request). Resolves false, never throws.
 */
export async function requestHosts(origins: string[]): Promise<boolean> {
  const wanted = origins.filter((o) => OPTIONAL_HOSTS.includes(o));
  if (wanted.length === 0) return true;
  try {
    return await browser.permissions.request({ origins: wanted });
  } catch {
    return false;
  }
}
