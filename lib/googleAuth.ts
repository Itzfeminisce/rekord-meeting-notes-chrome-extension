/** Google sign-in pieces for launchWebAuthFlow (implicit flow): the consent URL, reading the redirect, token expiry. */

// Rekord's Google OAuth client (Web application, redirect https://flkicdahoghegnlgpkmdcemlooblblcd.chromiumapp.org/). It is public.
const REKORD_CLIENT_ID = '503949808619-egjguop1pgr0imp7pj7ej19g1b8afifo.apps.googleusercontent.com';
export const GOOGLE_CLIENT_ID: string = (import.meta.env.WXT_GOOGLE_CLIENT_ID as string | undefined) || REKORD_CLIENT_ID;
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
// Treat a token as gone a minute early so a request doesn't start on one about to expire.
const EARLY_MS = 60_000;

export interface GoogleToken { token: string; expiresAt: number; scopes: string[] }

export const googleConfigured = (clientId = GOOGLE_CLIENT_ID): boolean => clientId.trim().length > 0;

/** `silent` asks Google not to show any page (prompt=none), for renewing a token without the user. */
export function authUrl(clientId: string, redirectUri: string, state: string, scopes: string[], opts: { silent?: boolean; loginHint?: string } = {}): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: scopes.join(' '),
    state,
    include_granted_scopes: 'false',
  });
  if (opts.silent) q.set('prompt', 'none');
  if (opts.loginHint) q.set('login_hint', opts.loginHint);
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

/** Reads the token from the redirect's fragment; throws when Google sent an error or the state differs. */
export function parseTokenRedirect(redirected: string, state: string, requested: string[], now: number): GoogleToken {
  const hash = redirected.includes('#') ? redirected.slice(redirected.indexOf('#') + 1) : '';
  const p = new URLSearchParams(hash || (redirected.includes('?') ? redirected.slice(redirected.indexOf('?') + 1) : ''));
  const error = p.get('error');
  if (error) throw new Error(`Google sign-in failed: ${error}`);
  if (p.get('state') !== state) throw new Error('Google sign-in returned a different state');
  const token = p.get('access_token');
  if (!token) throw new Error('Google sign-in returned no token');
  const granted = p.get('scope');
  const seconds = Number(p.get('expires_in') ?? '3600');
  return {
    token,
    expiresAt: now + (Number.isFinite(seconds) ? seconds : 3600) * 1000,
    scopes: granted ? granted.split(' ').filter(Boolean) : requested,
  };
}

export const tokenUsable = (t: GoogleToken | undefined, now: number): t is GoogleToken => !!t && t.expiresAt - EARLY_MS > now;
