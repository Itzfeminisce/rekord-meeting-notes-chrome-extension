import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { connectGoogle, disconnectGoogle, getToken, googleFetch, GoogleError, SCOPES, scopesFor, type IdentityApi } from './google';
import { getSettings, updateSettings } from './settings';

const TOKEN = 'ya29.test_token';

function fakeIdentity(opts: { token?: string; granted?: string[]; fail?: boolean } = {}) {
  const identity = {
    getAuthToken: vi.fn(async (d: { interactive: boolean; scopes: string[] }) => {
      if (opts.fail) throw new Error('The user did not approve access.');
      return { token: opts.token ?? TOKEN, grantedScopes: opts.granted ?? d.scopes };
    }),
    removeCachedAuthToken: vi.fn(async () => undefined),
  } satisfies IdentityApi;
  return identity;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => fakeBrowser.reset());

describe('scopes', () => {
  it('maps the checkboxes to scopes', () => {
    expect(scopesFor({ calendar: true, docs: false })).toEqual([SCOPES.calendar]);
    expect(scopesFor({ calendar: true, docs: true })).toEqual([SCOPES.calendar, SCOPES.docs]);
    expect(scopesFor({ calendar: false, docs: false })).toEqual([]);
  });
});

describe('getToken', () => {
  it('fails as not configured without a client ID', async () => {
    await expect(getToken(true, [SCOPES.calendar], { identity: fakeIdentity(), clientId: '' })).rejects.toMatchObject({ code: 'not-configured' });
  });
  it('reports cancel for interactive and auth for silent failures', async () => {
    const identity = fakeIdentity({ fail: true });
    await expect(getToken(true, [SCOPES.calendar], { identity, clientId: 'x' })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(getToken(false, [SCOPES.calendar], { identity, clientId: 'x' })).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('googleFetch', () => {
  it('drops the cached token on 401, retries once, then reports access lost', async () => {
    const identity = fakeIdentity();
    const fetch = vi.fn(async () => json({}, 401));
    await expect(googleFetch('https://www.googleapis.com/x', [SCOPES.calendar], { identity, fetch, clientId: 'x' })).rejects.toBeInstanceOf(GoogleError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: TOKEN });
  });
  it('sends the bearer token', async () => {
    const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => json({ ok: true }));
    await googleFetch('https://www.googleapis.com/x', [SCOPES.calendar], { identity: fakeIdentity(), fetch, clientId: 'x' });
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('connectGoogle', () => {
  it('saves the granted parts and the account email', async () => {
    const fetch = vi.fn(async () => json({ items: [{ id: 'you@example.com', primary: true }] }));
    const google = await connectGoogle({ calendar: true, docs: true }, { identity: fakeIdentity({ granted: [SCOPES.calendar] }), fetch, clientId: 'x' });
    expect(google).toMatchObject({ calendar: true, docs: false, email: 'you@example.com' });
    expect((await getSettings()).google).toMatchObject({ calendar: true, docs: false });
  });
  it('stays disconnected when the user cancels', async () => {
    await expect(connectGoogle({ calendar: true, docs: false }, { identity: fakeIdentity({ fail: true }), clientId: 'x' })).rejects.toMatchObject({ code: 'cancelled' });
    expect((await getSettings()).google.calendar).toBe(false);
  });
});

describe('disconnectGoogle', () => {
  it('removes the cached token, revokes it and clears settings.google', async () => {
    await updateSettings({ google: { calendar: true, docs: true, calendarId: 'work', email: 'you@example.com' } });
    const identity = fakeIdentity();
    const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response('', { status: 200 }));
    await disconnectGoogle({ identity, fetch, clientId: 'x' });
    expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({ token: TOKEN });
    expect(fetch.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/revoke');
    expect((await getSettings()).google).toEqual({ calendar: false, docs: false });
  });
  it('clears settings even when Google is unreachable', async () => {
    await updateSettings({ google: { calendar: true, docs: false } });
    const fetch = vi.fn(async () => { throw new TypeError('offline'); });
    await disconnectGoogle({ identity: fakeIdentity(), fetch, clientId: 'x' });
    expect((await getSettings()).google).toEqual({ calendar: false, docs: false });
  });
});
