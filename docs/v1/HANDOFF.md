# Rekord v1 handoff

## Rules
- Brief: `docs/BRIEF.md`; read only the lines your spec points to. Design: your frame in `design/frames/` only.
- Shared types: `docs/v1/CONTRACT.md` (T1 turns it into `lib/types.ts`; later tasks import from there, never redefine).
- Touch only the paths your task lists. Need another file changed? Stop and report it.
- Never print, log or commit an API key or token. Tests use fake keys like `gsk_test`.
- Copy is the product speaking to the user: copy text from the frame exactly; no lorem, no dev jargon in UI.
- Every screen handles empty, loading and error states, is keyboard reachable, and has labelled controls.
- Checks before you report: `npm run compile 2>&1 | head -20` and `npx vitest run <your test files> 2>&1 | tail -15`.
- Commit only your paths: `git add <paths> && git commit -m "T<n>: <summary>"`. Do not push.
- Tick your task, add one log line (≤120 chars). Report in ≤10 lines.

## Conventions (T1 fills this, ≤6 lines)
- Import types from `@/lib/types`; data via `@/lib/db` (put/get/list<X>/delete<X>, listMeetings, deleteMeeting, pendingChunks).
- Settings: `getSettings`/`updateSettings(partial)` (nested objects replaced whole), `PROVIDERS` in `@/lib/settings`.
- Messages: `send(msg)` (resolves undefined if no listener) / `onMessage(h)` (return a value or promise to reply; returns off()).
- Screens: default-export a no-prop component in `entrypoints/sidepanel/screens/`; use `useRouter()` → route.params, navigate/replace/back.
- UI: `TopBar, Button(variant, block), Card, Tag(kind, onDark), Spinner(label), EmptyState` from `../components`; CSS vars in style.css.
- Tests: vitest + `fakeBrowser.reset()`; IndexedDB tests import `fake-indexeddb/auto`, then `closeDB()` + new `IDBFactory()` per test.

## Tasks
- [x] T1 core: types, IndexedDB, settings, messages, router, shared UI — opus — specs/T1.md
- [ ] T2 audio capture: offscreen doc, tab + mic, 10 s chunks, silence skip — opus — specs/T2.md
- [ ] T3 transcription: provider client, rate-limit queue, catch-up — opus — specs/T3.md
- [ ] T4 onboarding: Mic access screen + permission tab — sonnet — specs/T4.md
- [ ] T5 Connect AI + Settings screens, key loading (penv / paste) — opus — specs/T5.md
- [ ] T6 Start + Live screens: transcript, notes, markers — sonnet — specs/T6.md
- [ ] T7 Wrapping up + Summary: LLM summary — sonnet — specs/T7.md
- [ ] T8 Library + Transcript screens — sonnet — specs/T8.md
- [ ] T9 Export: Markdown, PDF, email draft — sonnet — specs/T9.md
- [ ] T10 Connection-lost state — sonnet — specs/T10.md

## Log
- T1 done: types, db (idb), settings, messages, time, router + 11 placeholder screens, shared UI; 22 tests pass.
