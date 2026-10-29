# Rekord

Rekord is a Chrome side-panel extension for meetings.
Rekord records your meetings, transcribes them and writes the notes for you.

## What Rekord does

- Rekord records a meeting in a Chrome tab or in a desktop app such as Zoom or Teams.
- Rekord can also record your microphone if you choose.
- Rekord shows a live transcript while people talk.
- With a Deepgram key, the transcript appears as people speak and labels each voice.
- You can type notes and add markers during the meeting.
- Rekord writes a summary and action items.
- You can ask questions about one meeting, while the meeting is running or after.
- You can ask questions across all your meetings with "Ask all meetings".
- Rekord suggests speaker names and lets you correct them.
- Speaker names need a Deepgram key.
- You can export a meeting as Markdown or PDF.
- You can share a meeting to Google Docs or Notion.
- Google Calendar names your meetings.

## Install from source

You need Node.js and npm.
The repo does not pin a Node version.

```bash
npm install
npm run build
```

Then load the build in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose `.output/chrome-mv3`.

To work on Rekord, run `npm run dev` instead of `npm run build`.

## First run

1. Click the Rekord icon to open the side panel.
2. Pick a setup:
   - **Free to start**: one Groq key does everything.
   - With **Free to start**, your transcript appears a few seconds after people speak.
   - **Real time**: you need a Deepgram key and a Groq key.
   - With **Real time**, words appear as people speak.
   - Deepgram is a paid service.
   - **Choose my own**: you pick the service for transcription and for the assistant.
3. Add your keys in one of two ways:
   - Paste a key.
   - Rekord recognises Groq, OpenAI, Anthropic, OpenRouter, Deepgram and Notion keys.
   - Or connect [Penv Cloud](https://penv.cloud).
   - In a build from source, choose **Use a token instead** and paste a Penv Cloud token.
   - One-click connect works only in the published extension.

You can get a free Groq key at https://console.groq.com/keys.

## Optional: Google Calendar and Docs

Google sign-in is off until you build Rekord with your own Google OAuth client.
Everything else in Rekord still works without Google sign-in.

1. Set `WXT_EXTENSION_KEY` and `WXT_GOOGLE_CLIENT_ID` in `.env.local`.
   - `WXT_EXTENSION_KEY` keeps the extension ID stable.
   - `WXT_GOOGLE_CLIENT_ID` is an OAuth client of type "Chrome extension".
2. In Google Cloud, create a project.
   - Enable the Calendar and Drive APIs.
   - Set up the consent screen with yourself as a test user.
   - Create the OAuth client for your extension ID.
3. Run `npm run build`, reload the extension, then open Settings and connect Google.

The full steps are in [docs/v3/GOOGLE.md](docs/v3/GOOGLE.md).
`npm run zip` makes a release build.
`npm run zip` fails unless both variables are set.

## Optional: Notion

Create an internal integration at https://www.notion.so/profile/integrations.
Paste the integration's secret into Rekord.
If you use Penv Cloud, store the secret there as `NOTION_TOKEN`.

## Development

```bash
npm test
npm run compile
```

- `npm test` runs the unit tests.
- `npm run compile` type-checks the code.

## Privacy

- Your meetings, transcripts and settings stay in your browser (IndexedDB).
- Your data leaves your computer only to reach the services you chose, and when you share a meeting.
- Your API keys are kept in session storage.
- Session storage is cleared when you close the browser.
- Rekord has no tracking or analytics.

Read [docs/privacy.md](docs/privacy.md) for details.
