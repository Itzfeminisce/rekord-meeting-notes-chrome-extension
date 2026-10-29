# Google setup (calendar + Google Docs)

Rekord signs in with `chrome.identity.launchWebAuthFlow` against a Google OAuth client of type
**Web application**. Nothing here is secret: the extension key and the client ID are both public, and the implicit
flow uses no client secret. Never add a client secret to the repo or the build.

## What is built in
| Value | Default (public, in the repo) | Override |
|---|---|---|
| Extension key (`manifest.key`) | Rekord's public key in `wxt.config.ts`, giving the ID `flkicdahoghegnlgpkmdcemlooblblcd` | `WXT_EXTENSION_KEY` |
| OAuth client ID | `503949808619-egjguop1pgr0imp7pj7ej19g1b8afifo.apps.googleusercontent.com` in `lib/googleAuth.ts` | `WXT_GOOGLE_CLIENT_ID` |

- Every build (dev, `npm run build`, `npm run zip`) uses these defaults, so no variable is required.
- The private key that matches the public key stays with the owner; it is uploaded once, with the first Web Store zip.
- The redirect URL is `chrome.identity.getRedirectURL()` = `https://flkicdahoghegnlgpkmdcemlooblblcd.chromiumapp.org/`.
  If you override the key, the ID and the redirect URL change with it, and your own client must list that URL.

## Google Cloud console (owner, once)
1. Open the project that owns the client above (https://console.cloud.google.com → project picker).
2. **APIs & Services → Library**: enable **Google Calendar API** and **Google Drive API**.
3. **APIs & Services → Credentials** → the Web application client `503949808619-egjguop1…`:
   - **Authorized redirect URIs** → add `https://flkicdahoghegnlgpkmdcemlooblblcd.chromiumapp.org/` (with the
     trailing slash) → **Save**. No JavaScript origins are needed.
4. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - Data access → scopes `.../auth/calendar.readonly` and `.../auth/drive.file`.
   - While **Publishing status = Testing**, add each tester's Google account under **Test users** (max 100).
5. Load `.output/chrome-mv3` unpacked, check `chrome://extensions` shows the ID above, then open
   Settings → Connected apps → Connect and approve.

## Publishing later
- `calendar.readonly` is a sensitive scope: leaving Testing needs Google's OAuth verification (privacy policy URL,
  homepage, a short video of the consent flow). `drive.file` is non-sensitive.

## How Rekord uses the token
- Connect runs inside the click: Chrome first asks for `https://www.googleapis.com/*` and
  `https://oauth2.googleapis.com/*` (optional host permissions), then Google shows its consent page.
- Scopes requested match the boxes on “Connect your Google account”. The redirect's `state` must match the one sent.
- The access token and its expiry live only in `chrome.storage.session` (`googleToken`); settings keep which parts are
  on, the chosen calendar and the account email. The token is never logged or written to disk.
- When the token expires (about an hour), Rekord renews it silently (`prompt=none`, with the account email as
  `login_hint`). If Google needs the user again, Calendar shows “Reconnect”.
- A 401 drops the stored token and renews once; a second 401 shows “Rekord can’t reach your Google account anymore.”
- Disconnect: forget the stored token, revoke it at `https://oauth2.googleapis.com/revoke`, clear `settings.google`.
