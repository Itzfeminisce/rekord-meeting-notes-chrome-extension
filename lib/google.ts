/**
 * Google sign-in through chrome.identity.launchWebAuthFlow (Web application client, implicit flow): get a token for
 * the scopes the user allowed, call Google APIs with it, and disconnect (revoke it, clear settings.google).
 * The token lives only in storage.session with its expiry; it is never logged.
 */
import { GOOGLE_CLIENT_ID, authUrl, parseTokenRedirect, tokenUsable, type GoogleToken } from './googleAuth';
import { GOOGLE_HOSTS, requestHosts } from './hosts';
import { getSettings, updateSettings } from './settings';
import type { Settings } from './types';

export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  docs: 'https://www.googleapis.com/auth/drive.file',
} as const;

export type GoogleScope = keyof typeof SCOPES;
export type GoogleSettings = Settings['google'];

export const DISCONNECTED: GoogleSettings = { calendar: false, docs: false };

const TOKEN_KEY = 'googleToken';
let renewing: Promise<GoogleToken> | undefined;

/** The part of chrome.identity Rekord uses; injected in tests. */
export interface IdentityApi {
  launchWebAuthFlow(details: { url: string; interactive: boolean; abortOnLoadForNonInteractive?: boolean; timeoutMsForNonInteractive?: number }): Promise<string | undefined>;
  getRedirectURL(path?: string): string;
}

export interface GoogleDeps {
  identity?: IdentityApi;
  fetch?: typeof fetch;
  /** OAuth client ID; empty means this build can't sign in to Google. */
  clientId?: string;
  /** Asks Chrome for Google's hosts; injected in tests. */
  requestHosts?: (origins: string[]) => Promise<boolean>;
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

const clientIdOf = (deps: GoogleDeps): string => deps.clientId ?? GOOGLE_CLIENT_ID;

async function storedToken(): Promise<GoogleToken | undefined> {
  return (await browser.storage.session.get(TOKEN_KEY))[TOKEN_KEY] as GoogleToken | undefined;
}

const forgetToken = (): Promise<void> => browser.storage.session.remove(TOKEN_KEY);

/** Scope URLs for the chosen parts. */
export function scopesFor(choice: { calendar: boolean; docs: boolean }): string[] {
  return (Object.keys(SCOPES) as GoogleScope[]).filter((k) => choice[k]).map((k) => SCOPES[k]);
}

/** Runs Google's consent page (or, silently, prompt=none) and keeps the token in storage.session. */
async function authorize(interactive: boolean, scopes: string[], deps: GoogleDeps, loginHint?: string): Promise<GoogleToken> {
  const clientId = clientIdOf(deps);
  if (!clientId) throw new GoogleError('not-configured');
  const fail = new GoogleError(interactive ? 'cancelled' : 'auth');
  const identity = identityOf(deps);
  const state = crypto.randomUUID();
  let redirected: string | undefined;
  try {
    redirected = await identity.launchWebAuthFlow({
      url: authUrl(clientId, identity.getRedirectURL(), state, scopes, { silent: !interactive, loginHint }),
      interactive,
      // prompt=none answers through a redirect chain; give it a moment instead of stopping at the first page load.
      ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 5000 }),
    });
  } catch {
    throw fail;
  }
  if (!redirected) throw fail;
  let t: GoogleToken;
  try {
    t = parseTokenRedirect(redirected, state, scopes, Date.now());
  } catch {
    throw fail;
  }
  await browser.storage.session.set({ [TOKEN_KEY]: t });
  return t;
}

/**
 * Gets an access token: the stored one while it lasts and covers `scopes`, otherwise a new one.
 * Non-interactive calls renew silently and fail with 'auth' when Google would need to ask the user.
 */
export async function getToken(interactive: boolean, scopes: string[], deps: GoogleDeps = {}): Promise<string> {
  if (!clientIdOf(deps)) throw new GoogleError('not-configured');
  const stored = await storedToken();
  if (tokenUsable(stored, Date.now()) && scopes.every((x) => stored.scopes.includes(x))) return stored.token;
  if (interactive) return (await authorize(true, scopes, deps)).token;
  // Calendar and Docs can ask at once; one silent renewal for every connected part serves both,
  // unless it was started without a scope this caller needs.
  const inFlight = renewing && (await renewing.catch(() => undefined));
  if (inFlight && scopes.every((x) => inFlight.scopes.includes(x))) return inFlight.token;
  renewing ??= getSettings()
    .then((st) => authorize(false, [...new Set([...scopesFor(st.google), ...scopes])], deps, st.google.email))
    .finally(() => { renewing = undefined; });
  return (await renewing).token;
}

/**
 * Calls a Google API with a token for `scopes`. On 401 the stored token is dropped and one fresh token is tried;
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
    await forgetToken().catch(() => undefined);
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

/** Runs in a click: asks Chrome for Google's hosts, then Google for consent, then saves which parts are connected. */
export async function connectGoogle(choice: { calendar: boolean; docs: boolean }, deps: GoogleDeps = {}): Promise<GoogleSettings> {
  const scopes = scopesFor(choice);
  if (scopes.length === 0) throw new GoogleError('cancelled');
  if (!clientIdOf(deps)) throw new GoogleError('not-configured');
  // First await keeps the click's user gesture for Chrome's permission prompt.
  if (!(await (deps.requestHosts ?? requestHosts)(GOOGLE_HOSTS))) throw new GoogleError('cancelled');
  const { scopes: granted } = await authorize(true, scopes, deps);
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

/** Forgets the stored token, revokes it at Google (best effort) and clears settings.google. */
export async function disconnectGoogle(deps: GoogleDeps = {}): Promise<void> {
  const token = (await storedToken().catch(() => undefined))?.token;
  await forgetToken().catch(() => undefined);
  if (token) {
    const f = deps.fetch ?? fetch;
    await f('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => undefined);
  }
  await updateSettings({ google: { ...DISCONNECTED } });
}
