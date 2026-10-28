# Rekord: project brief

Personal AI meeting note taker. A Chrome extension (side panel) for Windows first; an iPhone app later.

## Design
Canvas with 41 frames (13 v1, 2 v2, 7 built states, 19 v3): https://claude.ai/artifact/Pwphr5xv9NLL2jd2c2HeSe
Frame sources, one screen per file (`Main` = Welcome): `design/frames/*.dc.html`. Open only the frame you are building. The canvas is the source of truth; copy changes from it into the frames.
Look: Geist / Geist Mono, grey ground `#F6F6F7`, ink `#111114`, accent indigo `#4F46E5`, recording red only on the record dot. Copy is the product speaking to the user.

## Stack
- WXT + React + TypeScript, Manifest V3, `chrome.sidePanel`.
- Audio: `chrome.tabCapture` for the meeting tab ("Others") plus `getUserMedia` for the mic ("You"), recorded in an offscreen document.
- Storage: IndexedDB, local only. No account, no sync.
- Providers: any OpenAI-compatible API, chosen in Settings (Groq, OpenRouter, Ollama, OpenAI, Anthropic).

## v1 scope
In: onboarding (Welcome, Mic access, Connect AI), Start, Live transcript, notes and moment markers (Decision, Action, Question, Bookmark), Wrapping up, Summary, Library, Transcript, Export (Markdown, PDF, email draft), Settings, Connection-lost state.

## v2 scope (field test v1 and v2 together)
Ask mid-meeting, live action-item suggestions, speaker names (Deepgram diarization after the meeting). Specs: `docs/v2/`.

## v3 scope
Smart AI setup, desktop-app audio, real-time transcription (Deepgram streaming), Ask all meetings, sharing (Google Docs, view-only link, Notion), Google Calendar, Chrome Web Store (unlisted). Specs and flow map: `docs/v3/`.

## Later
Expo iPhone app, sync across devices.

## Transcription
- Groq free tier, `whisper-large-v3-turbo`. Mic and tab are separate streams.
- About 10 s chunks (minimum billing is 10 s; 20 requests/min), skip silent chunks, so the transcript runs about 10 s behind.
- Free limits: about 7,200 audio s/hour and 28,800/day. When a limit is hit, keep recording and catch up later.
- Default language English, auto-detect as a setting.
- Speakers: live labels stay "You" and "Others". After the meeting, Deepgram (`nova-3`, `diarize=true`, key `DEEPGRAM_API_KEY`) splits Others into Speaker A/B from one continuous tab recording, the LLM suggests names, and the user confirms.

## Keys (penv)
- Settings key source: "Penv Cloud" (links to https://penv.cloud) or "Paste a key".
- penv: a read-only `pck_` machine token scoped to one environment. `GET https://penv.cloud/api/v1/envs/{org}/{project}/{env}` with `Authorization: Bearer`. Keys are held in memory only (`chrome.storage.session`).
- The penv environment must not be write-only (it would return `redacted`).
- Unverified: that penv.cloud accepts a `pck_` token as a bearer on `GET /envs`. Test it first, printing key names and status codes, never values.
- Dev container: `PENV_TOKEN` is an environment secret. Run tests with `penv run -- npm test`. Never print, log or commit a key.

## Delivery
Build to a zip, load it unpacked at `chrome://extensions` (Developer mode), and reload it after each update.

## Working rules (always take priority)
- Match each subagent and its effort to the complexity of the task it is given.
- Never resume an agent or subagent after its first piece of work. Every new task, implementation or review runs in a fresh subagent.
- No agent or subagent reads a large document from top to bottom.
- Agents read only the specific lines they need, and respond in 30 lines or fewer.
