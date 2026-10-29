import { describe, expect, it } from 'vitest';
import { authUrl, GOOGLE_CLIENT_ID, googleConfigured, parseTokenRedirect, tokenUsable } from './googleAuth';

const REDIRECT = 'https://fakeextensionid.chromiumapp.org/';
const CAL = 'https://www.googleapis.com/auth/calendar.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

describe('Google sign-in', () => {
  it('asks for an implicit token with the chosen scopes', () => {
    const u = new URL(authUrl('fake-client.apps.googleusercontent.com', REDIRECT, 'state-1', [CAL, DRIVE]));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('response_type')).toBe('token');
    expect(u.searchParams.get('scope')).toBe(`${CAL} ${DRIVE}`);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('state')).toBe('state-1');
    expect(u.searchParams.has('prompt')).toBe(false);
  });

  it('renews without any page when silent', () => {
    const u = new URL(authUrl('fake-client', REDIRECT, 's', [CAL], { silent: true, loginHint: 'you@example.com' }));
    expect(u.searchParams.get('prompt')).toBe('none');
    expect(u.searchParams.get('login_hint')).toBe('you@example.com');
  });

  it('reads the token, its expiry and the granted scopes from the fragment', () => {
    const t = parseTokenRedirect(`${REDIRECT}#access_token=fake-token&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(CAL)}&state=s`, 's', [CAL, DRIVE], 1000);
    expect(t).toEqual({ token: 'fake-token', expiresAt: 1000 + 3599 * 1000, scopes: [CAL] });
  });

  it('rejects a different state, an error and a missing token', () => {
    expect(() => parseTokenRedirect(`${REDIRECT}#access_token=fake-token&state=other`, 's', [CAL], 0)).toThrow();
    expect(() => parseTokenRedirect(`${REDIRECT}#error=access_denied&state=s`, 's', [CAL], 0)).toThrow(/access_denied/);
    expect(() => parseTokenRedirect(`${REDIRECT}#state=s`, 's', [CAL], 0)).toThrow();
  });

  it('drops a token that is about to expire', () => {
    expect(tokenUsable({ token: 'fake-token', expiresAt: 10 * 60_000, scopes: [] }, 0)).toBe(true);
    expect(tokenUsable({ token: 'fake-token', expiresAt: 30_000, scopes: [] }, 0)).toBe(false);
    expect(tokenUsable(undefined, 0)).toBe(false);
  });

  it('ships with Rekord\'s public client id and is not set up without one', () => {
    expect(GOOGLE_CLIENT_ID).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(googleConfigured('')).toBe(false);
    expect(googleConfigured('fake-client.apps.googleusercontent.com')).toBe(true);
  });
});
