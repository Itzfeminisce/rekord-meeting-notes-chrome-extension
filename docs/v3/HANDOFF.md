# Rekord v3 handoff

## Rules
- Same rules and conventions as `docs/v1/HANDOFF.md` "Rules" and "Conventions" and `docs/v2/HANDOFF.md`
  "Conventions" (read those sections only). Types: `docs/v3/CONTRACT.md`.
- Your frames are listed in your spec and in `docs/v3/FRAMES.md`. Open only those. Copy every visible string,
  label, aria-label, placeholder and hint verbatim. Build every control, link and state your rows in FRAMES.md list.
  If a frame shows something you can't build, stop and report it; never drop it silently.
- Sample data in frames (names, times, counts, emails) comes from real data at runtime.
- Touch only the paths your spec lists. Need another file changed? Stop and report it.
- Tests use fake keys (`gsk_test`, `dg_test`, `ntn_test`) and injected fetch; no network in unit tests.
- Never print, log or commit a key or token.
- Checks: `npm run compile 2>&1 | head -20`, `npx vitest run <your tests> 2>&1 | tail -15`.
- Commit `v3 T<n>: <summary>` on the v3 branch. Do not push. Tick your task, add one log line (≤120 chars),
  report ≤10 lines including any FRAMES.md row you could not complete.

## Tasks
- [x] T1 v3 core: types, settings, key detection, manifest (identity, hosts, fixed key) — opus — specs/T1.md
- [ ] T2 Smart setup, How it works, Settings AI — sonnet — specs/T2.md (after T1)
- [ ] T3 Desktop-app audio and its states — opus — specs/T3.md (after T1)
- [ ] T4 Real-time transcription with Deepgram, backup to Groq — opus — specs/T4.md (after T3)
- [ ] T5 Ask all meetings and the Library entry — sonnet — specs/T5.md (after T1)
- [ ] T6 Google connect and Calendar — opus — specs/T6.md (after T1)
- [ ] T7 Share to Google Docs and view-only link — sonnet — specs/T7.md (after T6)
- [ ] T8 Notion connect, page choice, share — sonnet — specs/T8.md (after T1)
- [ ] T9 Name speakers from the invite — sonnet — specs/T9.md (after T6)
- [x] T10 What's new and Chrome Web Store packaging — sonnet — specs/T10.md (after T1)
- [ ] T11 Connect Penv Cloud with one click — opus — specs/T11.md (after T2 and Penv Cloud app connections)

## Log
- T1 done: v3 types, settings merge, keyDetect, manifest identity/oauth2/key; deepgram chunk fallback to Groq.
- T10 done: What's new + onInstalled, STORE.md, privacy.md. Blocked: store upload (owner account), icons missing.
