/**
 * Smart setup: what each preset means for settings, which keys it needs, and how a pasted key is described.
 * No key value is ever returned or logged here; keys only go to the existing in-memory key store.
 */
import {
  checkKeys,
  connectPaste,
  loadKeyStatus,
  saveKeyStatus,
  summaryFor,
  transcriptionFor,
  transcriptionKeyName,
  type KeyStatus,
} from './connect';
import { detectKey, jobsFor, serviceLabel, type KeyJob, type KeyName } from './keyDetect';
import { PROVIDERS } from './settings';
import type { SetupPreset, Settings } from './types';

export const PENV_CLOUD_URL = 'https://penv.cloud';

export type PresetFields = Pick<Settings, 'setup' | 'transcription' | 'summary' | 'realtimeBackup'>;

/** The settings a preset stands for. `custom` keeps the current choices (V3SetupCustom edits them). */
export function applyPreset(preset: SetupPreset, current: Omit<PresetFields, 'setup'>): PresetFields {
  if (preset === 'free') {
    return {
      setup: 'free',
      transcription: transcriptionFor('groq', current.transcription),
      summary: summaryFor('groq', current.summary),
      realtimeBackup: current.realtimeBackup,
    };
  }
  if (preset === 'realtime') {
    return {
      setup: 'realtime',
      transcription: transcriptionFor('deepgram', current.transcription),
      summary: summaryFor('groq', current.summary),
      realtimeBackup: true,
    };
  }
  return { setup: 'custom', transcription: current.transcription, summary: current.summary, realtimeBackup: current.realtimeBackup };
}

/** Key names the chosen services need, transcription first, without duplicates. Ollama needs none. */
export function neededKeys(s: Pick<Settings, 'transcription' | 'summary'>): KeyName[] {
  const names = [transcriptionKeyName(s.transcription.provider), PROVIDERS[s.summary.provider].keyName];
  return [...new Set(names.filter((n): n is KeyName => !!n))];
}

/** The needed keys that are not loaded yet. */
export function missingKeys(needed: string[], loaded: string[]): string[] {
  return needed.filter((n) => !loaded.includes(n));
}

export type RowStatus = KeyStatus | 'checking';

export const STATUS_WORD: Record<RowStatus, string> = {
  ok: 'Ready',
  checking: 'Checking…',
  rejected: 'Rejected',
  unreachable: 'Couldn’t check',
};

/** "transcription and the assistant": what a key covers, in words. */
export function jobsPhrase(name: KeyName): string {
  const jobs: KeyJob[] = jobsFor(name);
  if (jobs.length === 2) return 'transcription and the assistant';
  if (jobs[0] === 'transcription') return 'transcription';
  if (jobs[0] === 'assistant') return 'the assistant';
  return 'sharing meetings to Notion';
}

export type PasteClass =
  | { kind: 'empty' }
  | { kind: 'known'; name: KeyName; title: string; jobs: string }
  | { kind: 'unknown' };

/** What a pasted value is: a recognised key (with row wording), or one Rekord can't place. */
export function classifyPaste(value: string): PasteClass {
  if (!value.trim()) return { kind: 'empty' };
  const name = detectKey(value);
  if (!name) return { kind: 'unknown' };
  return { kind: 'known', name, title: `This is a ${serviceLabel(name)} key`, jobs: jobsPhrase(name) };
}

/** The second line of a recognised key row. */
export function rowDetail(name: KeyName, status: RowStatus): string {
  if (status === 'ok') return `Ready for ${jobsPhrase(name)}`;
  if (status === 'checking') return `Checking for ${jobsPhrase(name)}`;
  if (status === 'rejected') return `${serviceLabel(name)} didn’t accept this key`;
  return 'Check your connection and try again';
}

/** Services offered as chips when a pasted key isn't recognised. */
export const SERVICE_CHOICES: KeyName[] = [
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'DEEPGRAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
];

/** Where a user creates a new key for a service. */
export const KEY_PAGE: Record<KeyName, string> = {
  GROQ_API_KEY: 'https://console.groq.com/keys',
  OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
  DEEPGRAM_API_KEY: 'https://console.deepgram.com/',
  ANTHROPIC_API_KEY: 'https://console.anthropic.com/settings/keys',
  OPENROUTER_API_KEY: 'https://openrouter.ai/keys',
  NOTION_TOKEN: 'https://www.notion.so/profile/integrations',
};

type StatusMap = Record<string, RowStatus | undefined>;

/** "Start using Rekord" is allowed once every needed key is loaded and none was rejected or is still being checked. */
export function canStart(needed: string[], loaded: string[], status: StatusMap): boolean {
  return missingKeys(needed, loaded).length === 0 && needed.every((n) => status[n] === 'ok' || status[n] === 'unreachable');
}

/** The hint under a disabled "Start using Rekord". */
export function startHint(needed: string[], loaded: string[], status: StatusMap): string {
  const missing = missingKeys(needed, loaded);
  if (missing.length > 0) return `Add your ${missing.map(serviceLabel).join(' and ')} key to continue.`;
  const rejected = needed.filter((n) => status[n] === 'rejected');
  if (rejected.length > 0) return `${rejected.map(serviceLabel).join(' and ')} didn’t accept the key. Replace it to continue.`;
  return 'Rekord is checking your keys…';
}

/** What a loaded key is used for under the current settings ("assistant and backup", "not in use"). */
export function keyUse(name: string, s: Pick<Settings, 'transcription' | 'summary' | 'realtimeBackup' | 'features'>): string {
  const roles: string[] = [];
  if (transcriptionKeyName(s.transcription.provider) === name) roles.push('transcription');
  if (PROVIDERS[s.summary.provider].keyName === name) roles.push('assistant');
  if (name === 'GROQ_API_KEY' && s.transcription.provider === 'deepgram' && s.realtimeBackup) roles.push('backup');
  if (name === 'DEEPGRAM_API_KEY' && s.features.speakerNames && !roles.includes('transcription')) roles.push('speaker names');
  if (name === 'NOTION_TOKEN') roles.push('sharing');
  return roles.length === 0 ? 'not in use' : roles.join(' and ');
}

/** Saves a key the user pasted for a known service, checks it, and remembers the result. Returns the status. */
export async function addKey(name: KeyName, value: string, fetchImpl: typeof fetch = fetch): Promise<KeyStatus> {
  const v = value.trim();
  await connectPaste({ [name]: v });
  const status = (await checkKeys({ [name]: v }, fetchImpl))[name] ?? 'ok';
  await saveKeyStatus({ ...(await loadKeyStatus()), [name]: status });
  return status;
}
