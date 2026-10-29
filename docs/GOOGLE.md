# Google setup (calendar + Google Docs)

Rekord signs in with `chrome.identity.getAuthToken`. Until the steps below are done, Google features show
“Google sign-in isn’t set up in this version of Rekord yet.” and everything else keeps working.

## Build variables
Put them in `.env.local` (git-ignored) or the shell environment. Never commit their values.

| Variable | What it is | Used for |
|---|---|---|
| `WXT_GOOGLE_CLIENT_ID` | OAuth client ID of type "Chrome extension" (`….apps.googleusercontent.com`) | `oauth2.client_id` in the manifest, used by `chrome.identity` |
| `WXT_EXTENSION_KEY` | Base64 public key of the extension (the `key` manifest field) | Keeps the extension ID stable, so the OAuth client matches it |

- Scopes requested: `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/drive.file`.
- Dev builds (`npm run dev`, `npm run build`) work without either variable; Google features then can't sign in.
- Release builds (`npm run zip`, or `wxt build --mode release`) stop with a clear error when either is missing.

## Getting the extension key (summary)
1. Pack the extension once in `chrome://extensions` (Pack extension) to get a `.pem` private key; keep it secret.
2. Derive the public key: `openssl rsa -in key.pem -pubout -outform DER | base64 -w0` → `WXT_EXTENSION_KEY`.
3. Load the build with that key; the extension ID shown is the one to register on the OAuth client.

## Google Cloud console (owner, once)
1. Fix the extension ID first (section above): build with `WXT_EXTENSION_KEY`, load `.output/chrome-mv3` unpacked,
   and copy the ID from `chrome://extensions`. The Web Store item must use the same key.
2. https://console.cloud.google.com → project picker → **New project** (e.g. "Rekord") → select it.
3. **APIs & Services → Library**: enable **Google Calendar API** and **Google Drive API**
   (also **Google Docs API** if T7 writes Docs through it).
4. **APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):
   - User type **External**; app name "Rekord"; support and developer email = the owner's address.
   - Data access → Add scopes: `.../auth/calendar.readonly` and `.../auth/drive.file`.
   - Audience: leave **Publishing status = Testing**; under **Test users** add the owner's Google account
     (and anyone else who will try it; max 100). Tokens for test apps expire after 7 days; reconnecting is normal.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Chrome extension**; Item ID = the extension ID from step 1.
   - Copy the client ID (`….apps.googleusercontent.com`) into `.env.local` as `WXT_GOOGLE_CLIENT_ID=…`.
6. Rebuild (`npm run build`), reload the extension, open Settings → Connected apps → Connect, and approve.
   Chrome must be signed in to a Google account that is a test user.

## Publishing later
- `calendar.readonly` is a sensitive scope: leaving Testing needs Google's OAuth verification (privacy policy URL,
  homepage, a short video of the consent flow). `drive.file` is non-sensitive.

## How Rekord uses the token
- Scopes requested match the boxes on “Connect your Google account”; settings keep only which parts are on,
  the chosen calendar and the account email (never the token; Chrome caches it).
- Calendar: events from 15 minutes ago to the end of today on the chosen calendar (`primary` by default).
- A 401 drops the cached token and retries once; a second 401 shows “Rekord can’t see your calendar anymore.”
- Disconnect: `removeCachedAuthToken`, revoke at `https://oauth2.googleapis.com/revoke`, clear `settings.google`.
  Revoke needs `https://oauth2.googleapis.com/*` in `host_permissions`; without it the token simply expires.
