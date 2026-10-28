# Google setup (calendar + Google Docs)

T1 adds the build variables below. T6 completes this file with the Google Cloud console steps.

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
