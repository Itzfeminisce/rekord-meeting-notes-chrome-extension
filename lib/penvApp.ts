/**
 * One-click Penv Cloud: OAuth 2.0 code + PKCE through `chrome.identity.launchWebAuthFlow`.
 * The `pca_` grant lives only in `browser.storage.session`, like the other secrets; `pck_` tokens are used
 * once and dropped. Never log or show a grant, token, code or code verifier.
 */
import { clearKeys, saveKeys } from './keys';
import { fetchPenvKeys, PENV_BASE_URL, PenvError, type PenvTarget } from './penv';

export const PENV_APP_CLIENT_ID = 'rekord';
export const PENV_CONNECT_URL = 'https://penv.cloud/connect';
export const PENV_APP_TOKEN_URL = `${PENV_BASE_URL}/auth/app/token`;
export const PENV_APP_URL = `${PENV_BASE_URL}/auth/app`;
export const PENV_REVOKE_URL = `${PENV_BASE_URL}/auth/revoke`;
/** Optional keys Rekord asks for on top of the ones the chosen setup needs. */
export const PENV_APP_OPTIONAL_KEYS = ['DEEPGRAM_API_KEY', 'NOTION_TOKEN'];

export const GRANT_KEY = 'penvGrant';
export const DISCONNECTED_KEY = 'penvAppDisconnected';

/** 'not-connected': window closed or access denied; 'disconnected': the grant no longer works. */
export type PenvAppErrorCode = 'not-connected' | 'state-mismatch' | 'disconnected';

export class PenvAppError extends Error {
  constructor(readonly code: PenvAppErrorCode, message: string) {
    super(message);
    this.name = 'PenvAppError';
  }
}

export interface PenvAppConnection { connectionId: string; org: string; project: string; env: string; keys: string[] }

/** Opens the approval window; resolves to the redirect URL, rejects when the window is closed. */
export type LaunchWebAuthFlow = (url: string) => Promise<string | undefined>;

export const defaultLaunch: LaunchWebAuthFlow = (url) => browser.identity.launchWebAuthFlow({ url, interactive: true });
export const redirectUri = (): string => browser.identity.getRedirectURL('penv');

// ---- Availability ----

let live = false;

/**
 * True once Penv Cloud app connections are live. A POST `{}` to the token route answers 404 until then
 * (or fails offline); any other status (e.g. 400 invalid_request) means it is live. True is kept for the session.
 */
export async function penvAppAvailable(fetchImpl: typeof fetch = fetch, timeoutMs = 2500): Promise<boolean> {
  if (live) return true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(PENV_APP_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'omit',
      signal: ctrl.signal,
    });
    live = res.status !== 404;
  } catch {
    live = false;
  } finally {
    clearTimeout(timer);
  }
  return live;
}

/** Test hook: forget a cached "live". */
export function resetPenvAppAvailable(): void {
  live = false;
}

// ---- PKCE ----

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

export function buildConnectUrl(p: { redirectUri: string; state: string; challenge: string; keys: string[] }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: PENV_APP_CLIENT_ID,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    keys: p.keys.join(','),
  });
  return `${PENV_CONNECT_URL}?${q.toString()}`;
}

/** The keys to ask for: what the chosen setup needs plus the optional ones, once each. */
export function connectKeyNames(needed: string[]): string[] {
  return [...new Set([...needed, ...PENV_APP_OPTIONAL_KEYS])];
}

// ---- Grant storage ----

export async function loadGrant(): Promise<string | undefined> {
  const v = (await browser.storage.session.get(GRANT_KEY))[GRANT_KEY];
  return typeof v === 'string' && v ? v : undefined;
}

async function saveGrant(grant: string): Promise<void> {
  await browser.storage.session.set({ [GRANT_KEY]: grant, [DISCONNECTED_KEY]: false });
}

/** True after Penv Cloud refused the grant (shows "Rekord was disconnected from Penv Cloud"). */
export async function wasDisconnected(): Promise<boolean> {
  return (await browser.storage.session.get(DISCONNECTED_KEY))[DISCONNECTED_KEY] === true;
}

async function markDisconnected(): Promise<void> {
  await browser.storage.session.remove(GRANT_KEY);
  await browser.storage.session.set({ [DISCONNECTED_KEY]: true });
  await clearKeys();
}

// ---- HTTP ----

async function postJson(url: string, body: unknown, fetchImpl: typeof fetch, bearer?: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
      credentials: 'omit',
    });
  } catch {
    throw new PenvError('http', 'penv could not be reached.');
  }
  const data = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (data.error === 'invalid_grant' || res.status === 401) throw new PenvAppError('disconnected', 'Penv Cloud no longer accepts this connection.');
  if (!res.ok) throw new PenvError('http', `penv returned HTTP ${res.status}.`, res.status);
  return data;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function readConnection(d: Record<string, unknown>, fallbackKeys: string[]): PenvAppConnection | null {
  const c = (d.connection && typeof d.connection === 'object' ? d.connection : d) as Record<string, unknown>;
  const org = str(c.org), project = str(c.project), env = str(c.env);
  if (!org || !project || !env) return null;
  const keys = Array.isArray(c.keys) ? c.keys.filter((k): k is string => typeof k === 'string') : fallbackKeys;
  return { connectionId: str(c.id) || str(c.connection_id) || str(c.connectionId), org, project, env, keys };
}

// ---- Flows ----

/**
 * Runs the approval window, checks state, exchanges the code for the `pca_` grant and keeps it in session
 * memory. Returns the connection (no secrets).
 */
export async function connectPenvApp(opts: {
  keys: string[];
  launch?: LaunchWebAuthFlow;
  fetchImpl?: typeof fetch;
  redirect?: string;
}): Promise<PenvAppConnection> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const redirect = opts.redirect ?? redirectUri();
  const { verifier, challenge } = await createPkce();
  const state = randomString(16);
  let back: string | undefined;
  try {
    back = await (opts.launch ?? defaultLaunch)(buildConnectUrl({ redirectUri: redirect, state, challenge, keys: opts.keys }));
  } catch {
    throw new PenvAppError('not-connected', 'The window was closed.');
  }
  if (!back) throw new PenvAppError('not-connected', 'The window was closed.');
  const params = new URL(back).searchParams;
  if (params.get('state') !== state) throw new PenvAppError('state-mismatch', 'Penv Cloud sent back an unexpected answer.');
  if (params.get('error')) throw new PenvAppError('not-connected', 'Access was not allowed.');
  const code = params.get('code');
  if (!code) throw new PenvAppError('not-connected', 'No code came back.');

  let data: Record<string, unknown>;
  try {
    data = await postJson(
      PENV_APP_TOKEN_URL,
      { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: PENV_APP_CLIENT_ID, redirect_uri: redirect },
      fetchImpl,
    );
  } catch (err) {
    // A refused code (expired or used) means this attempt didn't connect; try again.
    if (err instanceof PenvAppError && err.code === 'disconnected') throw new PenvAppError('not-connected', 'The code was not accepted.');
    throw err;
  }
  const grant = str(data.grant) || str(data.refresh_token);
  const conn = readConnection(data, opts.keys);
  if (!grant.startsWith('pca_') || !conn) throw new PenvError('bad-response', 'penv sent a response Rekord does not understand.');
  await saveGrant(grant);
  return conn;
}

/**
 * Trades the grant for a short-lived `pck_` token (keeping the rotated grant), reads the environment and keeps
 * the keys in memory. Returns the key names, or null without a grant. Throws PenvAppError('disconnected') on
 * invalid_grant (grant and keys are cleared first).
 */
export async function loadPenvAppKeys(target: PenvTarget, fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const grant = await loadGrant();
  if (!grant) return null;
  let data: Record<string, unknown>;
  try {
    data = await postJson(PENV_APP_URL, { client_id: PENV_APP_CLIENT_ID }, fetchImpl, grant);
  } catch (err) {
    if (err instanceof PenvAppError && err.code === 'disconnected') await markDisconnected();
    throw err;
  }
  const token = str(data.token) || str(data.access_token);
  const rotated = str(data.grant) || str(data.refresh_token);
  if (rotated.startsWith('pca_')) await saveGrant(rotated);
  if (!token.startsWith('pck_')) throw new PenvError('bad-response', 'penv sent a response Rekord does not understand.');
  const keys = await fetchPenvKeys(token, target, fetchImpl);
  await saveKeys(keys);
  return Object.keys(keys).sort();
}

/** Revokes the grant on Penv Cloud (best effort) and forgets it and the keys. */
export async function disconnectPenvApp(fetchImpl: typeof fetch = fetch): Promise<void> {
  const grant = await loadGrant();
  await browser.storage.session.remove([GRANT_KEY, DISCONNECTED_KEY]);
  await clearKeys();
  if (!grant) return;
  try {
    await fetchImpl(PENV_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${grant}` },
      body: JSON.stringify({ client_id: PENV_APP_CLIENT_ID }),
      credentials: 'omit',
    });
  } catch {
    // Offline: the grant is already forgotten here; it can also be removed on Penv Cloud.
  }
}
