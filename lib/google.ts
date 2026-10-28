/**
 * Google sign-in through chrome.identity: get a token for the scopes the user allowed, call Google APIs with it,
 * and disconnect (forget the cached token, revoke it, clear settings.google). Tokens are never stored or logged.
 */
import { getSettings, updateSettings } from './settings';
import type { Settings } from './types';

export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  docs: 'https://www.googleapis.com/auth/drive.file',
} as const;

export type GoogleScope = keyof typeof SCOPES;
export type GoogleSettings = Settings['google'];

export const DISCONNECTED: GoogleSettings = { calendar: false, docs: false };

/** The part of chrome.identity Rekord uses; injected in tests. */
export interface IdentityApi {
  getAuthToken(details: { interactive: boolean; scopes: string[] }): Promise<{ token?: string; grantedScopes?: string[] } | string | undefined>;
  removeCachedAuthToken(details: { token: string }): Promise<void>;
}

export interface GoogleDeps {
  identity?: IdentityApi;
  fetch?: typeof fetch;
  /** OAuth client ID from the manifest; empty means this build can't sign in to Google. */
  clientId?: string;
}

export type GoogleErrorCode = 'not-configured' | 'cancelled' | 'auth' | 'offline' | 'server';

const MESSAGES: Record<GoogleErrorCode, string> = {
  'not-configured': 'Google sign-in isn’t set up in this version of Rekord yet.',
  cancelled: 'Google didn’t connect. Try again when you’re ready.',
  auth: 'Rekord can’t reach your Google account anymore. Connect it again.',
  offline: 'Rekord couldn’t reach Google. Check your connection and try again.',
  server: 'Google didn’t answer. Try again in a moment.',
};

export class GoogleError extends Error {
  constructor(public code: GoogleErrorCode) {
    super(MESSAGES[code]);
    this.name = 'GoogleError';
  }
}

function identityOf(deps: GoogleDeps): IdentityApi {
  return deps.identity ?? (browser.identity as unknown as IdentityApi);
}

function clientIdOf(deps: GoogleDeps): string {
  if (deps.clientId !== undefined) return deps.clientId;
  try {
    const m = browser.runtime.getManifest() as { oauth2?: { client_id?: string } };
    return m.oauth2?.client_id ?? '';
  } catch {
    return '';
  }
}

/** Scope URLs for the chosen parts. */
export function scopesFor(choice: { calendar: boolean; docs: boolean }): string[] {
  return (Object.keys(SCOPES) as GoogleScope[]).filter((k) => choice[k]).map((k) => SCOPES[k]);
}

/** Gets an access token. Non-interactive calls fail with 'auth' when Google would need to ask the user. */
export async function getToken(interactive: boolean, scopes: string[], deps: GoogleDeps = {}): Promise<string> {
  if (!clientIdOf(deps)) throw new GoogleError('not-configured');
  let result: Awaited<ReturnType<IdentityApi['getAuthToken']>>;
  try {
    result = await identityOf(deps).getAuthToken({ interactive, scopes });
  } catch {
    throw new GoogleError(interactive ? 'cancelled' : 'auth');
  }
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new GoogleError(interactive ? 'cancelled' : 'auth');
  return token;
}

/**
 * Calls a Google API with a token for `scopes`. On 401 the cached token is dropped and one fresh token is tried;
 * a second 401 (access revoked) throws GoogleError('auth').
 */
export async function googleFetch(url: string, scopes: string[], deps: GoogleDeps = {}, init: RequestInit = {}): Promise<Response> {
  const f = deps.fetch ?? fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(false, scopes, deps);
    let res: Response;
    try {
      res = await f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
    } catch {
      throw new GoogleError('offline');
    }
    if (res.status !== 401) {
      if (res.status === 403) throw new GoogleError('auth');
      if (!res.ok) throw new GoogleError('server');
      return res;
    }
    await identityOf(deps).removeCachedAuthToken({ token }).catch(() => undefined);
  }
  throw new GoogleError('auth');
}

/** The signed-in account's email: the primary calendar's ID, or Drive's account info. Empty if neither answers. */
export async function accountEmail(choice: { calendar: boolean; docs: boolean }, deps: GoogleDeps = {}): Promise<string> {
  const scopes = scopesFor(choice);
  try {
    if (choice.calendar) {
      const res = await googleFetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', scopes, deps);
      const body = (await res.json()) as { items?: { id: string; primary?: boolean }[] };
      const primary = body.items?.find((c) => c.primary);
      if (primary?.id) return primary.id;
    }
    if (choice.docs) {
      const res = await googleFetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', scopes, deps);
      const body = (await res.json()) as { user?: { emailAddress?: string } };
      if (body.user?.emailAddress) return body.user.emailAddress;
    }
  } catch { /* the email is only a label */ }
  return '';
}

/** Asks Google for consent (interactive), then saves which parts are connected. */
export async function connectGoogle(choice: { calendar: boolean; docs: boolean }, deps: GoogleDeps = {}): Promise<GoogleSettings> {
  const scopes = scopesFor(choice);
  if (scopes.length === 0) throw new GoogleError('cancelled');
  const result = await (async () => {
    if (!clientIdOf(deps)) throw new GoogleError('not-configured');
    try {
      return await identityOf(deps).getAuthToken({ interactive: true, scopes });
    } catch {
      throw new GoogleError('cancelled');
    }
  })();
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new GoogleError('cancelled');
  const granted = typeof result === 'object' && result?.grantedScopes ? result.grantedScopes : scopes;
  const connected = { calendar: choice.calendar && granted.includes(SCOPES.calendar), docs: choice.docs && granted.includes(SCOPES.docs) };
  if (!connected.calendar && !connected.docs) throw new GoogleError('cancelled');
  const prev = (await getSettings()).google;
  const email = await accountEmail(connected, deps);
  const google: GoogleSettings = {
    ...connected,
    calendarId: connected.calendar ? prev.calendarId : undefined,
    email: email || prev.email,
  };
  await updateSettings({ google });
  return google;
}

/** Forgets the token in Chrome, revokes it at Google (best effort) and clears settings.google. */
export async function disconnectGoogle(deps: GoogleDeps = {}): Promise<void> {
  const prev = (await getSettings()).google;
  const scopes = scopesFor(prev);
  let token = '';
  if (scopes.length) {
    try { token = await getToken(false, scopes, deps); } catch { /* nothing cached */ }
  }
  if (token) {
    await identityOf(deps).removeCachedAuthToken({ token }).catch(() => undefined);
    const f = deps.fetch ?? fetch;
    await f('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => undefined);
  }
  await updateSettings({ google: { ...DISCONNECTED } });
}
