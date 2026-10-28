# Rekord v3: orchestration

Scope: smart AI setup, desktop-app audio, real-time transcription (Deepgram streaming), Ask all meetings,
sharing (Google Docs, view-only link, Notion), Google Calendar, Chrome Web Store (unlisted) with What's new.
Design: the 17 `V3*.dc.html` frames in `design/frames/` (canvas row 4 and 5). `FRAMES.md` maps every frame,
control and link to a task. Nothing in it may be skipped.

Must not change: penv client behaviour (`lib/penv.ts`); keys in `chrome.storage.session` only; meetings local only
(IndexedDB), leaving the computer only when the user shares one; v1/v2 behaviour unless a spec says so.

## Order
T1 first. Then T2, T3, T5, T6, T10 in parallel. T4 after T3 (both change the offscreen recorder).
T7 and T9 after T6. T8 any time after T1. Then the final gate.
Every task runs in a fresh subagent at the model in `HANDOFF.md`; never resume a finished agent.

## Decisions
- Copy is the frames' text, verbatim. Sample data in frames (names, times, counts, emails, page titles) is data.
- Setup replaces Connect/ConnectPaste. "Free to start" = Groq for both; "Real time" = Deepgram transcription +
  Groq assistant + Groq backup; "Choose my own" = V3SetupCustom. Keys are recognized by prefix (T1 `lib/keyDetect.ts`).
- Real time: the extension mints a short-lived Deepgram token (`POST /v1/auth/grant`, `Authorization: Token <key>`)
  and opens the WebSocket with subprotocol `['bearer', <jwt>]`. Verify this against Deepgram's docs first.
  The v1 chunk recorder keeps running underneath, so a dropped stream is filled from chunks ("Nothing was missed").
- Desktop app audio: `getDisplayMedia({ video: true, audio: true, systemAudio: 'include' })` from an extension page
  (side panel, else a helper tab like the mic permission tab). Video tracks are stopped at once; only audio is kept.
- Notion has no extension-safe OAuth (the token exchange needs a client secret), so Rekord uses an internal
  integration secret: `NOTION_TOKEN` from penv or pasted (V3NotionConnect).
- Google: `chrome.identity.getAuthToken` with a Chrome-extension OAuth client. Scopes `calendar.readonly`
  (Calendar) and `drive.file` (Docs). The manifest gets a fixed `key` so the extension ID never changes.
- Ask all picks meetings by keyword and summary match within the chosen range, then sends their summaries plus
  matching excerpts within a ~60k-character budget. Citations are meeting + moment.

## Needs from the owner (blocking only the task named)
- T4: a working `DEEPGRAM_API_KEY` in penv (v2's E2E saw HTTP 401 on the current one).
- T6/T7: a Google Cloud project with the Calendar and Drive APIs on, an OAuth client of type "Chrome extension"
  for the fixed extension ID, and the owner added as a test user. T6 writes the steps into `docs/v3/GOOGLE.md`.
- T8: a Notion internal integration secret (`NOTION_TOKEN`) for testing.
- T10: a Chrome Web Store developer account (one-off fee) to upload the zip; T10 prepares everything else.

## Final gate
1. Frame parity: four fresh reviewers (sonnet), each owning a group of V3 frames, compare every visible string,
   control, state and link with the built screens and report mismatches (≤30 lines). Fixes go to fresh agents,
   then a fresh re-check. Repeat until zero mismatches.
2. Flow coverage: a fresh agent walks `FRAMES.md` row by row and confirms each flow exists in code (≤30 lines).
3. Checks: typecheck, all unit tests, build. E2E where keys allow; print counts and labels, never keys.
