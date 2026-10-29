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
 * True once Penv Cloud app connections are live. A POST `{}` to the token route is live on a 2xx or a 4xx other
 * than 403/404 (e.g. 400 invalid_request); 403, 404, 5xx and network failures are not live. True is kept for the session.
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
    // Live: 2xx, or a 4xx other than 403/404 (400/401/405/422 mean the route exists). 403, 404, 5xx: not live.
    live = (res.status >= 200 && res.status < 300) || (res.status >= 400 && res.status < 500 && res.status !== 403 && res.status !== 404);
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

/** The stored grant, or undefined. An empty string (written by markDisconnected) means no grant. */
export async function loadGrant(): Promise<string | undefined> {
  const v = (await browser.storage.session.get(GRANT_KEY))[GRANT_KEY];
  return typeof v === 'string' && v ? v : undefined;
}

/** Issues the write in the calling tick (callers check the epoch right before calling this). */
function saveGrant(grant: string): Promise<void> {
  return browser.storage.session.set({ [GRANT_KEY]: grant, [DISCONNECTED_KEY]: false });
}

/** True after Penv Cloud refused the grant (shows "Rekord was disconnected from Penv Cloud"). */
export async function wasDisconnected(): Promise<boolean> {
  return (await browser.storage.session.get(DISCONNECTED_KEY))[DISCONNECTED_KEY] === true;
}

// ---- Epochs ----
// Every grant writer runs in the side panel's JS context, so two in-memory counters order them without reading
// storage. A writer checks its epoch and issues its storage call in the same tick (no await in between);
// chrome.storage applies calls in call order, so any later writer's call lands after it.

/**
 * Bumped by everything that replaces or forgets the stored grant: connect, disconnect and markDisconnected.
 * A load may store its rotated grant only while this is unchanged; otherwise it revokes it.
 */
let grantEpoch = 0;
/**
 * Bumped by invalidateAppLoads and with every grantEpoch bump. A load may save keys or mark the connection
 * disconnected only while this is unchanged; callers within one load epoch share one exchange.
 */
let loadEpoch = 0;

type Epochs = { grant: number; load: number };

function bumpGrantEpoch(): void {
  grantEpoch++;
  loadEpoch++;
}

/**
 * Stops every in-flight app key load from saving keys (synchronous). Call it before saving keys from another
 * source, or before forgetting the app connection. The grant is untouched: a load that rotates it meanwhile still
 * keeps the rotated grant, so the connection works if the other source fails (the token path).
 */
export function invalidateAppLoads(): void {
  loadEpoch++;
}

/**
 * Penv Cloud refused the grant a load used: forget it and the keys, and set the "disconnected" flag. Does nothing
 * when anything moved the load epoch since the load started (a reconnect, disconnect or other key source).
 */
function markDisconnected(at: Epochs): Promise<unknown> {
  if (at.load !== loadEpoch) return Promise.resolve();
  bumpGrantEpoch();
  // One write clears the grant and sets the flag together, issued in this tick with the epoch check above.
  return Promise.all([browser.storage.session.set({ [GRANT_KEY]: '', [DISCONNECTED_KEY]: true }), clearKeys()]);
}

// ---- HTTP ----

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Runs `run` with a fetch that aborts after `timeoutMs`; a stalled request (or a fetch that ignores the signal)
 * rejects with "penv could not be reached" instead of hanging.
 */
async function withTimeout<T>(fetchImpl: typeof fetch, timeoutMs: number, run: (f: typeof fetch) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_res, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new PenvError('http', 'penv could not be reached.'));
    }, timeoutMs);
  });
  const f = ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, { ...init, signal: ctrl.signal })) as typeof fetch;
  try {
    return await Promise.race([run(f), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
  bearer?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  return withTimeout(fetchImpl, timeoutMs, async (f) => {
    let res: Response;
    try {
      res = await f(url, {
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
  });
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
  timeoutMs?: number;
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
  if (params.get('error')) throw new PenvAppError('not-connected', 'Access was not allowed.');
  if (params.get('state') !== state) throw new PenvAppError('state-mismatch', 'Penv Cloud sent back an unexpected answer.');
  const code = params.get('code');
  if (!code) throw new PenvAppError('not-connected', 'No code came back.');

  let data: Record<string, unknown>;
  try {
    data = await postJson(
      PENV_APP_TOKEN_URL,
      { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: PENV_APP_CLIENT_ID, redirect_uri: redirect },
      fetchImpl,
      undefined,
      opts.timeoutMs,
    );
  } catch (err) {
    // A refused code (expired or used) means this attempt didn't connect; try again.
    if (err instanceof PenvAppError && err.code === 'disconnected') throw new PenvAppError('not-connected', 'The code was not accepted.');
    throw err;
  }
  const grant = str(data.grant) || str(data.refresh_token);
  const conn = readConnection(data, opts.keys);
  if (!grant.startsWith('pca_') || !conn) throw new PenvError('bad-response', 'penv sent a response Rekord does not understand.');
  bumpGrantEpoch(); // loads still running with the previous grant must not overwrite this one
  await saveGrant(grant); // issued in the same tick as the bump
  return conn;
}

/**
 * Trades the grant for a short-lived `pck_` token (keeping the rotated grant), reads the environment and keeps
 * the keys in memory. Returns the key names, or null without a grant (or when invalidated meanwhile). Throws
 * PenvAppError('disconnected') on invalid_grant (grant and keys are cleared first).
 */
export function loadPenvAppKeys(target: PenvTarget, fetchImpl: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string[] | null> {
  // The grant rotates on every use, so overlapping callers of one load epoch share one exchange; a newer epoch
  // waits for the previous exchange to settle (it is time-limited) and then starts its own.
  if (inflight && inflight.epoch === loadEpoch) return inflight.run;
  const at: Epochs = { grant: grantEpoch, load: loadEpoch };
  const prev = inflight?.run;
  const start = () => loadPenvAppKeysOnce(target, fetchImpl, at, timeoutMs);
  const run = (prev ? prev.catch(() => null).then(start) : start()).finally(() => {
    if (inflight?.run === run) inflight = null;
  });
  inflight = { epoch: at.load, run };
  return run;
}

let inflight: { epoch: number; run: Promise<string[] | null> } | null = null;
const REVOKE_TIMEOUT_MS = 5000;

/** Best-effort server revoke of a grant, with a timeout. True when the server confirmed it. */
async function revokeGrant(grant: string, fetchImpl: typeof fetch, timeoutMs = REVOKE_TIMEOUT_MS): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(PENV_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${grant}` },
      body: JSON.stringify({ client_id: PENV_APP_CLIENT_ID }),
      credentials: 'omit',
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false; // Offline or timed out: still forgotten here; it can also be removed on Penv Cloud.
  } finally {
    clearTimeout(timer);
  }
}

async function loadPenvAppKeysOnce(target: PenvTarget, fetchImpl: typeof fetch, at: Epochs, timeoutMs: number): Promise<string[] | null> {
  if (at.load !== loadEpoch) return null;
  // Issued after any earlier disconnect's remove, so a load started after a disconnect finds no grant.
  let grant = await loadGrant();
  if (!grant) return null;
  let data: Record<string, unknown>;
  for (let retried = false; ; retried = true) {
    try {
      data = await postJson(PENV_APP_URL, { client_id: PENV_APP_CLIENT_ID }, fetchImpl, grant, timeoutMs);
      break;
    } catch (err) {
      if (err instanceof PenvAppError && err.code === 'disconnected' && at.load === loadEpoch) {
        // A newer grant may have been stored meanwhile (rotated elsewhere): retry once with that one.
        const current = retried ? undefined : await loadGrant();
        if (current && current !== grant && at.load === loadEpoch) {
          grant = current;
          continue;
        }
        await markDisconnected(at); // epoch-checked: a reconnect meanwhile is left alone
      }
      throw err;
    }
  }
  const token = str(data.token) || str(data.access_token);
  const rotated = str(data.grant) || str(data.refresh_token);
  const rotatedOk = rotated.startsWith('pca_');
  // The used grant is spent now. Keep the rotated one unless the grant was replaced or forgotten meanwhile, in
  // which case revoke it. Check and write share this tick.
  let saved: Promise<void> | undefined;
  if (rotatedOk && at.grant === grantEpoch) saved = saveGrant(rotated);
  else if (rotatedOk) void revokeGrant(rotated, fetchImpl).catch(() => false);
  await saved;
  if (at.load !== loadEpoch) return null;
  if (!rotatedOk) {
    // An empty or invalid rotated grant leaves nothing usable: treat it as invalid_grant.
    await markDisconnected(at);
    throw new PenvAppError('disconnected', 'Penv Cloud no longer accepts this connection.');
  }
  if (!token.startsWith('pck_')) throw new PenvError('bad-response', 'penv sent a response Rekord does not understand.');
  const keys = await withTimeout(fetchImpl, timeoutMs, (f) => fetchPenvKeys(token, target, f));
  if (at.load !== loadEpoch) return null;
  await saveKeys(keys); // issued in the same tick as the check
  return Object.keys(keys).sort();
}

/**
 * Invalidates in-flight key loads, forgets the grant and (unless `keepKeys`) the keys locally, then revokes the
 * forgotten grant on Penv Cloud. Never waits for an in-flight load: one that later gets a rotated grant revokes it
 * itself, and a load started after this finds no grant. `keepKeys` is for switching to another source that saves
 * its own keys. Resolves to true when the server confirmed the revoke (or there was no grant), false otherwise.
 */
export async function disconnectPenvApp(fetchImpl: typeof fetch = fetch, opts: { keepKeys?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
  bumpGrantEpoch();
  // Read and forget are issued in this tick, in this order: the read sees the grant being forgotten, and any
  // later read (a new load) runs after the remove.
  const read = loadGrant();
  const forgot = browser.storage.session.remove([GRANT_KEY, DISCONNECTED_KEY]);
  const cleared = opts.keepKeys ? undefined : clearKeys();
  const [grant] = await Promise.all([read, forgot, cleared]);
  return grant ? revokeGrant(grant, fetchImpl, opts.timeoutMs) : true;
}
