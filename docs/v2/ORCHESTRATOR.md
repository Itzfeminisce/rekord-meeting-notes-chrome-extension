# Rekord v2: orchestration

Scope: `docs/BRIEF.md` "v2 scope". Ask mid-meeting, live action-item suggestions, speaker names.
Not in scope: desktop-app audio, iPhone app, Web Store, live (streaming) diarization.
Field test: the user tests v1 and v2 together after this lands.

Must not change: penv client behaviour (`lib/penv.ts`); keys in `chrome.storage.session` only; data local only
(IndexedDB); the v1 transcription path (Groq/OpenAI chunks); no key/token ever printed, logged or committed.

## Order
T1 first (contract). Then T2, T3, T4 in parallel. T5 after T4. T6 after T5. Then the final gate.
Each task runs in a fresh subagent at the model shown in `HANDOFF.md`. Never resume a finished agent: fixes and
reviews get fresh agents.

## Decisions
- Diarization: Deepgram pre-recorded API, after the meeting only. Live labels stay You/Others (no added latency).
- Per-chunk audio can't be diarized consistently (speaker ids reset per request), so T4 keeps one continuous recording
  of the tab stream for the meeting and T5 sends it as one file.
- Audio is kept only until names are saved or skipped, unless Settings "Keep audio files" is on.
- Ask and suggestions use the summary provider/model through one shared client (`lib/llm.ts`).
- A one-hour transcript is about 12k tokens, so Ask sends the whole transcript; no search index.
- Suggestions run only while the Live screen is open (side panel). Closing it pauses them; nothing is lost.
- Every v2 feature has an off switch in Settings and fails soft: v1 behaviour continues if it errors.

## Final gate
A fresh opus agent reviews the full diff against this file and the specs (≤30-line report). Fixes go to fresh agents.
E2E: synthesize a 2-voice clip (OpenAI TTS, `OPENAI_API_KEY` from penv), run it through T5's diarize + naming with
`DEEPGRAM_API_KEY` via `penv run`, check that two labels come back. Print counts and labels only, never keys.
