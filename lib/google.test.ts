import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { connectGoogle, disconnectGoogle, getToken, googleFetch, GoogleError, SCOPES, scopesFor, type IdentityApi } from './google';
import { getSettings, updateSettings } from './settings';

const TOKEN = 'ya29.test_token';

const REDIRECT = 'https://fakeextensionid.chromiumapp.org/';

/** Answers launchWebAuthFlow like Google: a token for the asked (or `granted`) scopes, echoing the state. */
function fakeIdentity(opts: { token?: string; granted?: string[]; fail?: boolean } = {}) {
  const identity = {
    launchWebAuthFlow: vi.fn(async (d: { url: string; interactive: boolean }) => {
      if (opts.fail) throw new Error('The user did not approve access.');
      const q = new URL(d.url).searchParams;
      const scope = (opts.granted ?? q.get('scope')!.split(' ')).join(' ');
      return `${REDIRECT}#${new URLSearchParams({ access_token: opts.token ?? TOKEN, expires_in: '3599', scope, state: q.get('state')! })}`;
    }),
    getRedirectURL: vi.fn(() => REDIRECT),
  } satisfies IdentityApi;
  return identity;
}

const allow = async () => true;

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
  it('drops the stored token on 401, renews silently once, then reports access lost', async () => {
    const identity = fakeIdentity();
    const fetch = vi.fn(async () => json({}, 401));
    await expect(googleFetch('https://www.googleapis.com/x', [SCOPES.calendar], { identity, fetch, clientId: 'x' })).rejects.toBeInstanceOf(GoogleError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(identity.launchWebAuthFlow).toHaveBeenCalledTimes(2);
    expect(identity.launchWebAuthFlow.mock.calls[0]![0]).toMatchObject({ interactive: false });
    expect(new URL(identity.launchWebAuthFlow.mock.calls[0]![0].url).searchParams.get('prompt')).toBe('none');
  });
  it('reuses the stored token while it lasts', async () => {
    const identity = fakeIdentity();
    const fetch = vi.fn(async () => json({ ok: true }));
    await googleFetch('https://www.googleapis.com/x', [SCOPES.calendar], { identity, fetch, clientId: 'x' });
    await googleFetch('https://www.googleapis.com/y', [SCOPES.calendar], { identity, fetch, clientId: 'x' });
    expect(identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
  });
  it('sends the bearer token', async () => {
    const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => json({ ok: true }));
    await googleFetch('https://www.googleapis.com/x', [SCOPES.calendar], { identity: fakeIdentity(), fetch, clientId: 'x' });
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('reports a turned-off API as a server problem, not lost access', async () => {
    const off = vi.fn(async () => json({ error: { errors: [{ reason: 'accessNotConfigured' }] } }, 403));
    await expect(googleFetch('https://www.googleapis.com/x', [SCOPES.calendar], { identity: fakeIdentity(), fetch: off, clientId: 'x' })).rejects.toMatchObject({ code: 'server' });
    const denied = vi.fn(async () => json({ error: { errors: [{ reason: 'forbidden' }] } }, 403));
    await expect(googleFetch('https://www.googleapis.com/x', [SCOPES.calendar], { identity: fakeIdentity(), fetch: denied, clientId: 'x' })).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('connectGoogle', () => {
  it('saves the granted parts and the account email', async () => {
    const fetch = vi.fn(async () => json({ items: [{ id: 'you@example.com', primary: true }] }));
    const google = await connectGoogle({ calendar: true, docs: true }, { identity: fakeIdentity({ granted: [SCOPES.calendar] }), fetch, clientId: 'x', requestHosts: allow });
    expect(google).toMatchObject({ calendar: true, docs: false, email: 'you@example.com' });
    expect((await getSettings()).google).toMatchObject({ calendar: true, docs: false });
  });
  it('stays disconnected when the user cancels', async () => {
    await expect(connectGoogle({ calendar: true, docs: false }, { identity: fakeIdentity({ fail: true }), clientId: 'x', requestHosts: allow })).rejects.toMatchObject({ code: 'cancelled' });
    expect((await getSettings()).google.calendar).toBe(false);
  });
  it('asks Chrome for Google\'s hosts first and stops when they are refused', async () => {
    const identity = fakeIdentity();
    const ask = vi.fn(async () => false);
    await expect(connectGoogle({ calendar: true, docs: false }, { identity, clientId: 'x', requestHosts: ask })).rejects.toMatchObject({ code: 'cancelled' });
    expect(ask).toHaveBeenCalledWith(['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*']);
    expect(identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });
  it('rejects a redirect whose state does not match', async () => {
    const identity = fakeIdentity();
    identity.launchWebAuthFlow.mockResolvedValueOnce(`${REDIRECT}#access_token=${TOKEN}&state=someone-else`);
    await expect(connectGoogle({ calendar: true, docs: false }, { identity, clientId: 'x', requestHosts: allow })).rejects.toMatchObject({ code: 'cancelled' });
    expect(await fakeBrowser.storage.session.get('googleToken')).toEqual({});
  });
  it('signs in with the redirect URL for this extension id', async () => {
    const identity = fakeIdentity();
    const fetch = vi.fn(async () => json({ items: [] }));
    await connectGoogle({ calendar: true, docs: false }, { identity, fetch, clientId: 'x', requestHosts: allow });
    const url = new URL(identity.launchWebAuthFlow.mock.calls[0]![0].url);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe(SCOPES.calendar);
    expect(identity.launchWebAuthFlow.mock.calls[0]![0]).toMatchObject({ interactive: true });
  });
});

describe('disconnectGoogle', () => {
  it('forgets the stored token, revokes it and clears settings.google', async () => {
    await updateSettings({ google: { calendar: true, docs: true, calendarId: 'work', email: 'you@example.com' } });
    await getToken(false, [SCOPES.calendar], { identity: fakeIdentity(), clientId: 'x' });
    const fetch = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response('', { status: 200 }));
    await disconnectGoogle({ fetch, clientId: 'x' });
    expect(fetch.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(fetch.mock.calls[0]![1]!.body)).toBe(`token=${TOKEN}`);
    expect(await fakeBrowser.storage.session.get('googleToken')).toEqual({});
    expect((await getSettings()).google).toEqual({ calendar: false, docs: false });
  });
  it('clears settings even when Google is unreachable', async () => {
    await updateSettings({ google: { calendar: true, docs: false } });
    const fetch = vi.fn(async () => { throw new TypeError('offline'); });
    await disconnectGoogle({ fetch, clientId: 'x' });
    expect((await getSettings()).google).toEqual({ calendar: false, docs: false });
  });
});
