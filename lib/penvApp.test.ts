import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ensureKeys } from './connect';
import { loadKeys, saveKeys } from './keys';
import {
  buildConnectUrl,
  connectKeyNames,
  connectPenvApp,
  createPkce,
  disconnectPenvApp,
  invalidateAppLoads,
  loadGrant,
  loadPenvAppKeys,
  PenvAppError,
  penvAppAvailable,
  pkceChallenge,
  resetPenvAppAvailable,
  wasDisconnected,
} from './penvApp';
import { missingKeys } from './setup';
import { updateSettings } from './settings';

const REDIRECT = 'https://abc.chromiumapp.org/penv';
const TARGET = { org: 'acme', project: 'notes', env: 'dev' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Fake approval window: echoes the state from the URL with the given params. */
const allow = (extra: Record<string, string> = { code: 'code_test' }, stateOverride?: string) =>
  vi.fn(async (url: string) => {
    const state = stateOverride ?? new URL(url).searchParams.get('state')!;
    return `${REDIRECT}?${new URLSearchParams({ state, ...extra })}`;
  });

/** Fake Penv Cloud: code → grant; grant → pck_ + rotated grant; env read. */
function fakePenv(opts: { appStatus?: number; appBody?: unknown; keys?: { name: string; value: string }[] } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/auth/app/token')) return json({ grant: 'pca_one', connection: { id: 'c1', ...TARGET, keys: ['GROQ_API_KEY'] } });
    if (u.endsWith('/auth/app')) return json(opts.appBody ?? { token: 'pck_test', grant: 'pca_two' }, opts.appStatus ?? 200);
    if (u.endsWith('/auth/revoke')) return new Response(null, { status: 204 });
    if (u.includes('/envs/')) {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer pck_test');
      return json({ keys: opts.keys ?? [{ name: 'GROQ_API_KEY', value: 'gsk_test' }] });
    }
    return new Response(null, { status: 404 });
  });
}

const ticks = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/**
 * Storage that applies each call in call order (like chrome.storage) but resolves it a few ticks later, so
 * other writers can run in between. Returns the real set for test setup.
 */
function slowStorage() {
  const session = fakeBrowser.storage.session;
  const real = { get: session.get.bind(session), set: session.set.bind(session), remove: session.remove.bind(session) };
  const later = <T>(p: Promise<T>) => p.then(async (v) => { await ticks(3); return v; });
  vi.spyOn(session, 'get').mockImplementation(((k: never) => later(real.get(k))) as typeof session.get);
  vi.spyOn(session, 'set').mockImplementation(((v: never) => later(real.set(v))) as typeof session.set);
  vi.spyOn(session, 'remove').mockImplementation(((k: never) => later(real.remove(k))) as typeof session.remove);
  return real.set;
}

/** Fake Penv Cloud: code → pca_B; any grant G → pck_ + G2 (or invalid_grant for `refused`); env read. */
function rotatingPenv(refused: string[] = []) {
  const base = fakePenv();
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/auth/app/token')) return json({ grant: 'pca_B', connection: { id: 'c1', ...TARGET, keys: ['GROQ_API_KEY'] } });
    if (u.endsWith('/auth/app')) {
      const g = ((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').slice('Bearer '.length);
      return refused.includes(g) ? json({ error: 'invalid_grant' }, 400) : json({ token: 'pck_test', grant: `${g}2` });
    }
    return base(url, init);
  });
}

const bearers = (f: ReturnType<typeof vi.fn>, path: string) =>
  f.mock.calls.filter(([u]) => String(u).endsWith(path)).map(([, i]) => (i?.headers as Record<string, string>).Authorization);

describe('penvApp', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); // slowStorage spies
    fakeBrowser.reset();
    resetPenvAppAvailable();
  });

  it('makes a PKCE S256 pair and the connect URL', async () => {
    const { verifier, challenge } = await createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(await pkceChallenge(verifier));
    // RFC 7636 appendix B example
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const url = new URL(buildConnectUrl({ redirectUri: REDIRECT, state: 'st', challenge, keys: connectKeyNames(['GROQ_API_KEY']) }));
    expect(url.origin + url.pathname).toBe('https://penv.cloud/connect');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('rekord');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe(challenge);
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('state')).toBe('st');
    expect(q.get('keys')).toBe('GROQ_API_KEY,DEEPGRAM_API_KEY,NOTION_TOKEN');
  });

  it('rejects a state mismatch and keeps no grant', async () => {
    const fetchImpl = fakePenv();
    await expect(connectPenvApp({ keys: ['GROQ_API_KEY'], launch: allow(undefined, 'other'), fetchImpl, redirect: REDIRECT }))
      .rejects.toMatchObject({ code: 'state-mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await loadGrant()).toBeUndefined();
  });

  it('exchanges the code with the verifier, then rotates the grant when loading keys', async () => {
    const fetchImpl = fakePenv();
    const launch = allow();
    const conn = await connectPenvApp({ keys: ['GROQ_API_KEY'], launch, fetchImpl, redirect: REDIRECT });
    expect(conn).toEqual({ connectionId: 'c1', ...TARGET, keys: ['GROQ_API_KEY'] });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    const challenge = new URL(launch.mock.calls[0]![0]).searchParams.get('code_challenge');
    expect(sent).toMatchObject({ grant_type: 'authorization_code', code: 'code_test', client_id: 'rekord', redirect_uri: REDIRECT });
    expect(await pkceChallenge(sent.code_verifier)).toBe(challenge);
    expect(await loadGrant()).toBe('pca_one');

    expect(await loadPenvAppKeys(TARGET, fetchImpl)).toEqual(['GROQ_API_KEY']);
    const appCall = fetchImpl.mock.calls.find(([u]) => String(u).endsWith('/auth/app'))!;
    expect((appCall[1]?.headers as Record<string, string>).Authorization).toBe('Bearer pca_one');
    expect(await loadGrant()).toBe('pca_two');
    expect(await loadKeys()).toEqual({ GROQ_API_KEY: 'gsk_test' });
  });

  it('invalid_grant clears the grant and keys and marks disconnected', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_old' });
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    const fetchImpl = fakePenv({ appStatus: 400, appBody: { error: 'invalid_grant' } });
    await expect(loadPenvAppKeys(TARGET, fetchImpl)).rejects.toMatchObject({ code: 'disconnected' });
    expect(await loadGrant()).toBeUndefined();
    expect(await loadKeys()).toEqual({});
    expect(await wasDisconnected()).toBe(true);

    // ensureKeys on Start: the penv-app source with no keys and a refused grant → reconnect
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_old' });
    await updateSettings({ keySource: 'penv-app', penvApp: { connectionId: 'c1', ...TARGET, keys: [] } });
    expect(await ensureKeys(fetchImpl)).toBe('reconnect');
    expect(await ensureKeys(fakePenv())).toBe('reconnect'); // grant is gone
  });

  it('closed window or access_denied → not connected', async () => {
    const closed = vi.fn(async () => { throw new Error('The user did not approve access.'); });
    await expect(connectPenvApp({ keys: [], launch: closed, fetchImpl: fakePenv(), redirect: REDIRECT }))
      .rejects.toMatchObject({ code: 'not-connected' });
    const denied = allow({ error: 'access_denied' });
    const err = await connectPenvApp({ keys: [], launch: denied, fetchImpl: fakePenv(), redirect: REDIRECT }).catch((e) => e);
    expect(err).toBeInstanceOf(PenvAppError);
    expect(err.code).toBe('not-connected');
    expect(await loadGrant()).toBeUndefined();
  });

  it('shared keys missing what the setup needs are detected', async () => {
    const fetchImpl = fakePenv({ keys: [{ name: 'NOTION_TOKEN', value: 'ntn_test' }] });
    await connectPenvApp({ keys: ['GROQ_API_KEY'], launch: allow(), fetchImpl, redirect: REDIRECT });
    const names = await loadPenvAppKeys(TARGET, fetchImpl);
    expect(missingKeys(['GROQ_API_KEY'], names!)).toEqual(['GROQ_API_KEY']);
  });

  it('disconnect revokes the grant as bearer and clears keys', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    const fetchImpl = fakePenv();
    expect(await disconnectPenvApp(fetchImpl)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://penv.cloud/api/v1/auth/revoke');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer pca_one');
    expect(await loadGrant()).toBeUndefined();
    expect(await loadKeys()).toEqual({});
  });

  it('disconnect still clears locally when the revoke fails, and says so', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    expect(await disconnectPenvApp(vi.fn(async () => { throw new TypeError('offline'); }))).toBe(false);
    expect(await loadGrant()).toBeUndefined();
    expect(await loadKeys()).toEqual({});
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    expect(await disconnectPenvApp(vi.fn(async () => new Response(null, { status: 500 })))).toBe(false);
    expect(await loadGrant()).toBeUndefined();
  });

  it('forgets the grant before revoking it', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    let during: string | undefined = 'unset';
    let auth: string | undefined;
    await disconnectPenvApp(vi.fn(async (_u: unknown, init?: RequestInit) => {
      during = await loadGrant();
      auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    expect(during).toBeUndefined();
    expect(auth).toBe('Bearer pca_one');
  });

  it('a reconnect during an in-flight load keeps the new grant and revokes the rotated old one', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_A' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fakePenv();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/auth/app')) {
        const bearer = (init?.headers as Record<string, string>).Authorization;
        if (bearer === 'Bearer pca_A') {
          await gate;
          return json({ token: 'pck_test', grant: 'pca_A2' });
        }
        return json({ token: 'pck_test', grant: 'pca_B2' });
      }
      if (String(url).endsWith('/auth/token') || String(url).endsWith('/auth/app/token')) return json({ grant: 'pca_B', connection: { id: 'c1', ...TARGET, keys: ['GROQ_API_KEY'] } });
      return base(url, init);
    });
    const oldLoad = loadPenvAppKeys(TARGET, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    await connectPenvApp({ keys: ['GROQ_API_KEY'], launch: allow(), fetchImpl, redirect: REDIRECT });
    expect(await loadGrant()).toBe('pca_B');
    const newLoad = loadPenvAppKeys(TARGET, fetchImpl); // fresh run, not the old in-flight one
    release();
    await oldLoad;
    await newLoad;
    await new Promise((r) => setTimeout(r, 0));
    expect(await loadGrant()).toBe('pca_B2');
    const revoked = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/auth/revoke'))
      .map(([, i]) => (i?.headers as Record<string, string>).Authorization);
    expect(revoked).toEqual(['Bearer pca_A2']);
  });

  it('connect during an in-flight load keeps the new grant, whatever the interleaving', async () => {
    const realSet = slowStorage();
    for (let d = 0; d < 30; d++) {
      await realSet({ penvGrant: 'pca_A', penvAppDisconnected: false });
      const fetchImpl = rotatingPenv();
      const load = loadPenvAppKeys(TARGET, fetchImpl).catch(() => null); // its storage read returns pca_A
      await ticks(d);
      await connectPenvApp({ keys: ['GROQ_API_KEY'], launch: allow(), fetchImpl, redirect: REDIRECT });
      await load;
      await ticks(10);
      expect(await loadGrant()).toBe('pca_B');
      expect(await wasDisconnected()).toBe(false);
      expect(bearers(fetchImpl, '/auth/app')[0]).toBe('Bearer pca_A');
    }
  });

  it('markDisconnected racing a connect never deletes the new grant or flags a valid one', async () => {
    const realSet = slowStorage();
    for (let d = 0; d < 30; d++) {
      await realSet({ penvGrant: 'pca_A', penvAppDisconnected: false });
      const fetchImpl = rotatingPenv(['pca_A']); // pca_A is refused with invalid_grant
      const load = loadPenvAppKeys(TARGET, fetchImpl).catch(() => null);
      await ticks(d);
      const connected = connectPenvApp({ keys: ['GROQ_API_KEY'], launch: allow(), fetchImpl, redirect: REDIRECT });
      await Promise.all([load, connected]);
      await ticks(10);
      const grant = await loadGrant();
      expect(grant).toBe('pca_B');
      expect(await wasDisconnected()).toBe(false);
    }
  });

  it('connect, load, and the next load uses the rotated grant', async () => {
    slowStorage();
    const fetchImpl = rotatingPenv();
    await connectPenvApp({ keys: ['GROQ_API_KEY'], launch: allow(), fetchImpl, redirect: REDIRECT });
    expect(await loadPenvAppKeys(TARGET, fetchImpl)).toEqual(['GROQ_API_KEY']);
    expect(await loadPenvAppKeys(TARGET, fetchImpl)).toEqual(['GROQ_API_KEY']);
    expect(bearers(fetchImpl, '/auth/app')).toEqual(['Bearer pca_B', 'Bearer pca_B2']);
    expect(await loadGrant()).toBe('pca_B22');
  });

  it('a disconnect during an in-flight load returns without waiting, and the load saves nothing', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fakePenv();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/auth/app')) await gate;
      return base(url, init);
    });
    const load = loadPenvAppKeys(TARGET, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    expect(await disconnectPenvApp(fetchImpl)).toBe(true); // the load is still stalled
    expect(await loadGrant()).toBeUndefined();
    release();
    expect(await load).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await loadGrant()).toBeUndefined();
    expect(await loadKeys()).toEqual({});
    const revoked = fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/auth/revoke'))
      .map(([, i]) => (i?.headers as Record<string, string>).Authorization);
    expect(revoked).toEqual(['Bearer pca_one', 'Bearer pca_two']);
  });

  it('a load started during the revoke finds no grant', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fakePenv();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/auth/revoke')) await gate;
      return base(url, init);
    });
    const disc = disconnectPenvApp(fetchImpl);
    const early = loadPenvAppKeys(TARGET, fetchImpl); // started before the local forget finished
    await new Promise((r) => setTimeout(r, 0));
    expect(await early).toBeNull();
    expect(await loadPenvAppKeys(TARGET, fetchImpl)).toBeNull();
    release();
    await disc;
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/auth/app'))).toHaveLength(0);
    expect(await loadGrant()).toBeUndefined();
    expect(await loadKeys()).toEqual({});
  });

  it('a stalled grant exchange or env read times out', async () => {
    const stall = (match: string) => {
      const base = fakePenv();
      return vi.fn((url: string | URL | Request, init?: RequestInit) =>
        String(url).includes(match) ? new Promise<Response>(() => undefined) : base(url, init)) as unknown as typeof fetch;
    };
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    await expect(loadPenvAppKeys(TARGET, stall('/auth/app'), 20)).rejects.toMatchObject({ code: 'http' });
    expect(await loadGrant()).toBe('pca_one');
    await expect(loadPenvAppKeys(TARGET, stall('/envs/'), 20)).rejects.toMatchObject({ code: 'http' });
    expect(await loadKeys()).toEqual({});
  });

  it('token path: invalidating first keeps the new keys, and the grant still works if the connect fails', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fakePenv();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/auth/app')) await gate;
      return base(url, init);
    });
    const load = loadPenvAppKeys(TARGET, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    invalidateAppLoads();
    await saveKeys({ OPENAI_API_KEY: 'sk_test' }); // what connectPenv saves
    release();
    expect(await load).toBeNull();
    expect(await loadKeys()).toEqual({ OPENAI_API_KEY: 'sk_test' });
    // Not forgotten (the connect might still fail): the rotated grant is kept, and a new load works.
    expect(await loadGrant()).toBe('pca_two');
    expect(await wasDisconnected()).toBe(false);
    expect(await loadPenvAppKeys(TARGET, fakePenv())).toEqual(['GROQ_API_KEY']);
  });

  it('pickPaste: invalidate, clear keys, then a keepKeys disconnect leaves nothing behind', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fakePenv();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/auth/app')) await gate;
      return base(url, init);
    });
    const load = loadPenvAppKeys(TARGET, fetchImpl);
    await new Promise((r) => setTimeout(r, 0));
    invalidateAppLoads();
    await saveKeys({});
    const disc = disconnectPenvApp(fetchImpl, { keepKeys: true });
    release();
    expect(await load).toBeNull();
    await disc;
    await new Promise((r) => setTimeout(r, 0));
    expect(await loadKeys()).toEqual({});
    expect(await loadGrant()).toBeUndefined();
  });

  it('keepKeys revokes and forgets the grant but leaves the keys', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    await disconnectPenvApp(fakePenv(), { keepKeys: true });
    expect(await loadGrant()).toBeUndefined();
    expect(await loadKeys()).toEqual({ GROQ_API_KEY: 'gsk_test' });
  });

  it('the revoke times out instead of hanging', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    const fetchImpl = vi.fn((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    expect(await disconnectPenvApp(fetchImpl as unknown as typeof fetch, { timeoutMs: 20 })).toBe(false);
    expect(await loadGrant()).toBeUndefined();
  });

  it('concurrent key loads share one exchange', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_one' });
    const fetchImpl = fakePenv();
    const [a, b, c] = await Promise.all([
      loadPenvAppKeys(TARGET, fetchImpl), loadPenvAppKeys(TARGET, fetchImpl), loadPenvAppKeys(TARGET, fetchImpl),
    ]);
    expect(a).toEqual(['GROQ_API_KEY']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).endsWith('/auth/app'))).toHaveLength(1);
    expect(await loadGrant()).toBe('pca_two');
  });

  it('a refused stale grant retries once with the newer stored grant instead of disconnecting', async () => {
    await fakeBrowser.storage.session.set({ penvGrant: 'pca_old' });
    const base = fakePenv();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (String(url).endsWith('/auth/app') && auth === 'Bearer pca_old') {
        await fakeBrowser.storage.session.set({ penvGrant: 'pca_new' }); // rotated by someone else meanwhile
        return json({ error: 'invalid_grant' }, 400);
      }
      return base(url, init);
    });
    expect(await loadPenvAppKeys(TARGET, fetchImpl)).toEqual(['GROQ_API_KEY']);
    expect(await wasDisconnected()).toBe(false);
    expect(await loadGrant()).toBe('pca_two');
  });

  it('access_denied is reported before the state is checked, and a code never needs exchanging', async () => {
    const fetchImpl = fakePenv();
    const err = await connectPenvApp({ keys: [], launch: allow({ error: 'access_denied' }, 'other'), fetchImpl, redirect: REDIRECT }).catch((e) => e);
    expect(err.code).toBe('not-connected');
    expect(fetchImpl).not.toHaveBeenCalled();
    const bad = await connectPenvApp({ keys: [], launch: allow({ code: 'c' }, 'other'), fetchImpl, redirect: REDIRECT }).catch((e) => e);
    expect(bad.code).toBe('state-mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('detects whether app connections are live', async () => {
    const f404 = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await penvAppAvailable(f404)).toBe(false);
    const [url, init] = f404.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://penv.cloud/api/v1/auth/app/token');
    expect(init).toMatchObject({ method: 'POST', body: '{}', credentials: 'omit' });
    expect(await penvAppAvailable(vi.fn(async () => { throw new TypeError('offline'); }))).toBe(false);
    for (const status of [403, 500, 404]) {
      expect(await penvAppAvailable(vi.fn(async () => new Response(null, { status })))).toBe(false);
    }
    expect(await penvAppAvailable(vi.fn(async () => json({ error: 'invalid_request' }, 400)))).toBe(true);
    // true is kept for the session
    const again = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await penvAppAvailable(again)).toBe(true);
    expect(again).not.toHaveBeenCalled();
  });
});
