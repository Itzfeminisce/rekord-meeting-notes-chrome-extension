# Rekord

Rekord is a Chrome side-panel extension that records your meetings, transcribes them and writes the notes for you.

## What it does

- Records a meeting in a Chrome tab or in a desktop app such as Zoom or Teams, with your microphone if you choose.
- Shows a live transcript while people talk. With a Deepgram key it appears as people speak and labels each voice.
- Lets you type notes and add markers during the meeting.
- Writes a summary and action items.
- Lets you ask questions about one meeting, while it is running or after, and across all your meetings with "Ask all meetings".
- Suggests speaker names and lets you correct them (needs a Deepgram key).
- Exports a meeting as Markdown or PDF, or shares it to Google Docs or Notion. Google Calendar names your meetings.

## Install from source

You need Node.js and npm. The repo does not pin a Node version.

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
   - **Free to start**: one Groq key does everything. Your transcript appears a few seconds after people speak.
   - **Real time**: a Deepgram key and a Groq key. Words appear as people speak. Deepgram is a paid service.
   - **Choose my own**: pick the service for transcription and for the assistant.
3. Add your keys in one of two ways:
   - Paste a key. Rekord recognises Groq, OpenAI, Anthropic, OpenRouter, Deepgram and Notion keys.
   - Connect [Penv Cloud](https://penv.cloud). In a build from source, choose **Use a token instead** and paste a Penv Cloud token. One-click connect works only in the published extension.

You can get a free Groq key at https://console.groq.com/keys.

## Optional: Google Calendar and Docs

Google sign-in is off until you build Rekord with your own Google OAuth client. Without it, everything else still works.

1. Set `WXT_EXTENSION_KEY` (keeps the extension ID stable) and `WXT_GOOGLE_CLIENT_ID` (an OAuth client of type "Chrome extension") in `.env.local`.
2. In Google Cloud, create a project, enable the Calendar and Drive APIs, set up the consent screen with yourself as a test user, and create the OAuth client for your extension ID.
3. Run `npm run build`, reload the extension, then open Settings and connect Google.

The full steps are in [docs/v3/GOOGLE.md](docs/v3/GOOGLE.md). `npm run zip` makes a release build and fails unless both variables are set.

## Optional: Notion

Create an internal integration at https://www.notion.so/profile/integrations and paste its secret into Rekord. If you use Penv Cloud, store it there as `NOTION_TOKEN`.

## Development

```bash
npm test
npm run compile
```

`npm test` runs the unit tests. `npm run compile` type-checks the code.

## Privacy

Your meetings, transcripts and settings stay in your browser (IndexedDB). They leave your computer only to reach the services you chose, and when you share a meeting. Your API keys are kept in session storage, so they are cleared when you close the browser. Rekord has no tracking or analytics. Read [docs/privacy.md](docs/privacy.md) for details.
