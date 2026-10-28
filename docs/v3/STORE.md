# Chrome Web Store: unlisted release

Status: everything below is ready except the upload, which needs the owner's Chrome Web Store developer account (one-off registration fee).

## Build the zip
1. Put `WXT_GOOGLE_CLIENT_ID` and `WXT_EXTENSION_KEY` in `.env.local` (see `docs/v3/GOOGLE.md`). A release build refuses to run without them.
2. `npm run zip`. The store-ready file is written to `.output/rekord-<version>-chrome.zip`.
3. Raise `version` in `package.json` for every upload; the store rejects a repeated version.

## Listing text (product voice)
- **Name:** Rekord
- **Summary (132 characters max):** Every meeting, written down as it happens. Live transcripts, summaries and answers from all your meetings.
- **Description:**
  Rekord transcribes your calls live, keeps your notes beside the conversation, and answers questions about what was said.

  - Works with Zoom and Teams apps, not just meetings in Chrome.
  - Real-time transcripts, with each voice labelled.
  - Ask all your meetings: find decisions and open actions across everything you've recorded.
  - Connect Google Calendar so meetings name themselves, and share to Google Docs or Notion in one tap.
  - Your recordings and notes stay in your browser. Bring your own keys, or connect Penv Cloud (https://penv.cloud) to fill them in for you.
- **Category:** Productivity. **Language:** English.
- **Visibility:** Unlisted. **Privacy policy URL:** the public URL of `docs/privacy.md` (for example its GitHub page).

## Screenshots to take (1280x800, at least one, up to five)
1. Live transcript during a meeting.
2. Summary with decisions and actions.
3. Ask all your meetings, with an answer and its moments.
4. Library with "Coming up" calendar meetings.
5. Share sheet (Google Docs and Notion).

Also required: a 128x128 store icon (the repo has no icon files yet, so add them under `public/icon/` and list them in the manifest before the first upload) and a small promo tile, 440x280.

## Permission justifications (paste one line each)
- `sidePanel`: shows Rekord beside the meeting.
- `storage`: keeps your settings and meetings on your computer.
- `tabCapture`: records the audio of the meeting tab you choose.
- `offscreen`: keeps recording and transcribing while the panel is closed.
- `activeTab`: lets Rekord record the tab you click it on.
- `identity`: signs you in to Google so Rekord can read your calendar and create Docs.
- Host access (`penv.cloud`, Groq, OpenAI, OpenRouter, Anthropic, Deepgram, Google APIs, Notion, `localhost:11434`): sends audio and text only to the service you picked, and fetches your keys from Penv Cloud.
- Single purpose: take notes of meetings.
- Remote code: none is loaded.
- Data use: disclose audio and meeting content, sent only to the services the user chooses; none sold; none used for unrelated purposes.

## Owner's upload steps
1. Register at https://chrome.google.com/webstore/devconsole and pay the one-off fee.
2. Items, then New item, then upload the zip from `.output/`.
3. Store listing tab: paste the text above, add the screenshots, icon and promo tile.
4. Privacy tab: paste the single purpose and permission justifications, tick the data-use disclosures, add the privacy policy URL.
5. Distribution tab: Visibility "Unlisted"; regions as wanted.
6. Submit for review. Once published, check the extension ID matches the one from `WXT_EXTENSION_KEY`. Share the unlisted link.
7. For each update: raise `version`, run `npm run zip`, upload the new zip under the same item, and submit.
