/**
 * Loads API keys into session memory, from penv cloud or pasted by the user, and checks them.
 * The `pck_` token and keys live only in `browser.storage.session`. Never log or show a value.
 */
import { clearKeys, loadKeys, saveKeys } from './keys';
import { fetchPenvKeys, PenvError, type PenvTarget } from './penv';
import { getSettings, PROVIDERS } from './settings';
import type { ProviderId, Settings } from './types';

const TOKEN_KEY = 'penvToken';

export async function saveToken(token: string): Promise<void> {
  await browser.storage.session.set({ [TOKEN_KEY]: token });
}

export async function loadToken(): Promise<string | undefined> {
  const stored = await browser.storage.session.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  return typeof token === 'string' && token ? token : undefined;
}

/** Forgets the token and every key held in memory. */
export async function forgetAll(): Promise<void> {
  await browser.storage.session.remove(TOKEN_KEY);
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
  await saveToken(token);
  return Object.keys(keys).sort();
}

/** Saves pasted keys (blank ones dropped) to session memory. Returns the key names saved. */
export async function connectPaste(keys: Record<string, string>): Promise<string[]> {
  const clean = Object.fromEntries(
    Object.entries(keys).map(([k, v]) => [k, v.trim()] as const).filter(([, v]) => v),
  );
  await saveKeys(clean);
  return Object.keys(clean).sort();
}

/**
 * Re-fetches penv keys with the token kept in session memory.
 * Returns the key names, or null when there is no token (the user must connect again).
 * Throws PenvError when penv refuses; show it with `connectErrorMessage`.
 */
export async function reconnect(fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const token = await loadToken();
  if (!token) return null;
  const settings = await getSettings();
  return connectPenv(token, settings.penv, fetchImpl);
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
