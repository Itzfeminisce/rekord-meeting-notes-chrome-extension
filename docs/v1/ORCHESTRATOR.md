# Rekord v1: orchestration

Scope: everything in `docs/BRIEF.md` "v1 scope" (lines 16-17). Not in scope: Ask (frame `Ask.dc.html`), live action-item
suggestions, speaker names, desktop-app audio, iPhone app, Web Store.
PR: Itzfeminisce/rekord-meeting-notes-chrome-extension#1, branch `feat/happy-babbage-xkn49d`.
Model ceiling: opus (medium effort). The user is AFK; decisions below were made without them and are listed for review.

Must not change: penv client behaviour (`lib/penv.ts`), keys in `chrome.storage.session` only, data local only (IndexedDB),
no key/token ever printed, logged or committed.

## Decisions taken while the user was away
- The penv `pck_` token is also session-only (cleared on browser restart; Settings asks to reconnect). Safe default.
- Transcription provider is Groq or OpenAI (both serve OpenAI-style `/audio/transcriptions`); the summary model can be
  any of Groq, OpenRouter, Ollama, OpenAI, Anthropic (OpenAI-compatible endpoints). The `testing` penv env only has
  `OPENAI_API_KEY` today, so OpenAI must work end to end.
- Mic permission is requested from a small extension tab, because Chrome does not show permission prompts in a side panel.
- Ask buttons/links in frames are omitted (Next scope).
