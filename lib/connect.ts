/**
 * Loads API keys into session memory, from penv cloud or pasted by the user, and checks them.
 * The `pck_` token and keys live only in `browser.storage.session`. Never log or show a value.
 */
import { clearKeys, loadKeys, mergeKeys, saveKeys } from './keys';
import { fetchPenvKeys, PenvError, type PenvTarget } from './penv';
import { getSettings, PROVIDERS } from './settings';
import type { ProviderId, Settings } from './types';

const TOKEN_KEY = 'penvToken';
const TARGET_KEY = 'penvTarget';
const STATUS_KEY = 'keyStatus';

export async function saveToken(token: string): Promise<void> {
  await browser.storage.session.set({ [TOKEN_KEY]: token });
}

export async function loadToken(): Promise<string | undefined> {
  const stored = await browser.storage.session.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  return typeof token === 'string' && token ? token : undefined;
}

/** The penv environment the kept token belongs to, if any. */
export async function loadTokenTarget(): Promise<PenvTarget | undefined> {
  const stored = await browser.storage.session.get(TARGET_KEY);
  const t = stored[TARGET_KEY] as Partial<PenvTarget> | undefined;
  return t && t.org && t.project && t.env ? { org: t.org, project: t.project, env: t.env } : undefined;
}

/** Forgets the token, its environment and every key held in memory. */
export async function forgetAll(): Promise<void> {
  await browser.storage.session.remove([TOKEN_KEY, TARGET_KEY, STATUS_KEY]);
  await clearKeys();
}

/** "org/project/env" → target, or null if it is not three non-empty parts. */
export function parseEnvPath(path: string): PenvTarget | null {
  const parts = path.trim().split('/').map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  const [org = '', project = '', env = ''] = parts;
  return { org, project, env };
}

export function formatEnvPath(t: PenvTarget): string {
  return `${t.org}/${t.project}/${t.env}`;
}

/** Key names the chosen providers need (transcription first), without duplicates. */
export function requiredKeyNames(s: Pick<Settings, 'transcription' | 'summary'>): string[] {
  const ids: ProviderId[] = [s.transcription.provider, s.summary.provider];
  const names = ids.map((id) => PROVIDERS[id].keyName).filter((n): n is string => !!n);
  return [...new Set(names)];
}

/**
 * Keys that unlock extra features but are never required to connect (e.g. DEEPGRAM_API_KEY for speaker names).
 * penv keeps every key it sends; offer these as optional fields when pasting.
 */
export function optionalKeyNames(s: Pick<Settings, 'diarization'>): string[] {
  return [s.diarization.keyName];
}

/** Plain-words message for a failed connect. Never includes a token or key. */
export function connectErrorMessage(err: unknown): string {
  if (err instanceof PenvError) {
    switch (err.code) {
      case 'unauthorized':
        return 'penv didn’t accept that token. Check it’s a read-only machine token for this environment.';
      case 'not-found':
        return 'penv couldn’t find that environment. Check the org, project and environment names.';
      case 'write-only':
        return 'That penv environment is write-only, so its keys can’t be read. Pick an environment that allows reading.';
      default:
        return 'penv had a problem sending your keys. Try again in a moment.';
    }
  }
  if (err instanceof VerifyError) return err.message;
  return 'Couldn’t reach the service. Check your connection and try again.';
}

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyError';
  }
}

/** Cheap check that the transcription key works: `GET {baseUrl}/models`. Throws VerifyError. */
export async function verifyTranscriptionKey(
  settings: Pick<Settings, 'transcription'>,
  keys: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const provider = PROVIDERS[settings.transcription.provider];
  const name = provider.keyName;
  const key = name ? keys[name] : undefined;
  if (!name || !key) throw new VerifyError(`No ${name ?? 'API'} key was found. Add it, then try again.`);
  let response: Response;
  try {
    response = await fetchImpl(`${provider.baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    throw new VerifyError('Couldn’t reach the transcription service. Check your connection and try again.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new VerifyError(`The transcription service rejected ${name}. Check the key and try again.`);
  }
  if (!response.ok) {
    throw new VerifyError('The transcription service didn’t answer properly. Try again in a moment.');
  }
}

/** Fetches keys from penv, keeps the token and keys in session memory. Returns the key names found. */
export async function connectPenv(
  token: string,
  target: PenvTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const keys = await fetchPenvKeys(token, target, fetchImpl);
  await saveKeys(keys);
  await browser.storage.session.set({ [TOKEN_KEY]: token, [TARGET_KEY]: target });
  return Object.keys(keys).sort();
}

/** Saves pasted keys (blank ones dropped), merged into the keys already in memory. Returns the key names in memory. */
export async function connectPaste(keys: Record<string, string>): Promise<string[]> {
  const clean = Object.fromEntries(
    Object.entries(keys).map(([k, v]) => [k, v.trim()] as const).filter(([, v]) => v),
  );
  await mergeKeys(clean);
  return Object.keys(await loadKeys()).sort();
}

/**
 * Re-fetches penv keys with the token kept in session memory.
 * Returns the key names, or null when there is no token (the user must connect again).
 * Throws PenvError when penv refuses; show it with `connectErrorMessage`.
 */
export async function reconnect(fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const token = await loadToken();
  if (!token) return null;
  const target = (await loadTokenTarget()) ?? (await getSettings()).penv;
  return connectPenv(token, target, fetchImpl);
}

export type KeyStatus = 'ok' | 'rejected' | 'unreachable';
/** Status per key name. Never holds a key value. */
export type KeyResults = Record<string, KeyStatus>;

export const TRANSCRIPTION_ORDER: Settings['transcription']['provider'][] = ['groq', 'openai'];
export const SUMMARY_ORDER: ProviderId[] = ['groq', 'openai', 'openrouter', 'anthropic'];
const TRANSCRIPTION_MODEL: Record<Settings['transcription']['provider'], string> = {
  groq: 'whisper-large-v3-turbo',
  openai: 'whisper-1',
};
const SUMMARY_MODEL: Record<ProviderId, string> = {
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openai/gpt-oss-120b',
  ollama: 'llama3.2',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
};
const DEEPGRAM_KEY = 'DEEPGRAM_API_KEY';

/** The cheap "who am I" request for a key name, or null when Rekord doesn't know that key. */
function checkRequest(name: string, key: string): { url: string; headers: Record<string, string> } | null {
  if (name === DEEPGRAM_KEY) return { url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${key}` } };
  const provider = Object.values(PROVIDERS).find((p) => p.keyName === name);
  if (!provider) return null;
  if (provider.id === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    };
  }
  return { url: `${provider.baseUrl}/models`, headers: { Authorization: `Bearer ${key}` } };
}

async function checkOne(
  req: { url: string; headers: Record<string, string> },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<KeyStatus> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'unreachable'>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve('unreachable');
    }, timeoutMs);
  });
  const call = fetchImpl(req.url, { headers: req.headers, signal: ctrl.signal }).then(
    (res): KeyStatus => (res.status === 401 || res.status === 403 ? 'rejected' : res.ok ? 'ok' : 'unreachable'),
    (): KeyStatus => 'unreachable',
  );
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks every loaded key against its own provider, in parallel. Keys Rekord doesn't know are skipped.
 * 'rejected' = 401/403; 'unreachable' = network error, other failure or no answer within ~8 s.
 */
export async function checkKeys(
  keys: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<KeyResults> {
  const entries = await Promise.all(
    Object.entries(keys).map(async ([name, value]) => {
      const req = value?.trim() ? checkRequest(name, value.trim()) : null;
      return req ? ([name, await checkOne(req, fetchImpl, timeoutMs)] as const) : null;
    }),
  );
  return Object.fromEntries(entries.filter((e): e is readonly [string, KeyStatus] => !!e));
}

/** True when the provider can be used with these results (Ollama needs no key). */
export function providerWorks(id: ProviderId, results: KeyResults): boolean {
  const name = PROVIDERS[id].keyName;
  return !name || results[name] === 'ok';
}

export function transcriptionFor(
  id: Settings['transcription']['provider'],
  current: Settings['transcription'],
): Settings['transcription'] {
  return id === current.provider ? current : { provider: id, model: TRANSCRIPTION_MODEL[id] };
}

export function summaryFor(id: ProviderId, current: Settings['summary']): Settings['summary'] {
  return id === current.provider ? current : { provider: id, model: SUMMARY_MODEL[id] };
}

/**
 * Picks providers whose keys work: the current one if its key is ok, else the first ok in order.
 * Keeps the current one when nothing works. Speaker names stay on only if the Deepgram key is ok.
 * Returns full nested objects (updateSettings replaces them whole).
 */
export function pickProviders(
  results: KeyResults,
  settings: Pick<Settings, 'transcription' | 'summary' | 'features'>,
): Pick<Settings, 'transcription' | 'summary' | 'features'> {
  const t = providerWorks(settings.transcription.provider, results)
    ? settings.transcription.provider
    : TRANSCRIPTION_ORDER.find((id) => providerWorks(id, results)) ?? settings.transcription.provider;
  const s = providerWorks(settings.summary.provider, results)
    ? settings.summary.provider
    : SUMMARY_ORDER.find((id) => providerWorks(id, results)) ?? settings.summary.provider;
  return {
    transcription: transcriptionFor(t, settings.transcription),
    summary: summaryFor(s, settings.summary),
    features: { ...settings.features, speakerNames: settings.features.speakerNames && results[DEEPGRAM_KEY] === 'ok' },
  };
}

/** Remembers the last check (names and statuses only) for this browser session. */
export async function saveKeyStatus(results: KeyResults): Promise<void> {
  await browser.storage.session.set({ [STATUS_KEY]: results });
}

export async function loadKeyStatus(): Promise<KeyResults> {
  const stored = await browser.storage.session.get(STATUS_KEY);
  return (stored[STATUS_KEY] as KeyResults | undefined) ?? {};
}

/**
 * True when the chosen transcription key was rejected. Only re-checks (one cheap call) when the last check
 * rejected it, so a key fixed in Settings since then clears the warning.
 */
export async function transcriptionKeyRejected(
  settings?: Pick<Settings, 'transcription'>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const s = settings ?? (await getSettings());
  const name = PROVIDERS[s.transcription.provider].keyName;
  const status = await loadKeyStatus();
  if (!name || status[name] !== 'rejected') return false;
  const key = (await loadKeys())[name];
  if (!key) return false;
  const now = (await checkKeys({ [name]: key }, fetchImpl))[name] ?? 'unreachable';
  await saveKeyStatus({ ...(await loadKeyStatus()), [name]: now });
  return now === 'rejected';
}

/**
 * Call when the side panel opens. 'ready' if keys are in memory (re-fetching them from penv when only
 * the token is left); 'reconnect' when the user has to connect again (e.g. after a browser restart).
 */
export async function ensureKeys(fetchImpl: typeof fetch = fetch): Promise<'ready' | 'reconnect'> {
  const keys = await loadKeys();
  if (Object.keys(keys).length > 0) return 'ready';
  try {
    return (await reconnect(fetchImpl)) ? 'ready' : 'reconnect';
  } catch {
    return 'reconnect';
  }
}
