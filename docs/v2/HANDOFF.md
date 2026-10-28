# Rekord v2 handoff

## Rules
- Same rules and conventions as `docs/v1/HANDOFF.md` "Rules" and "Conventions" (read those two sections only).
- Types: `docs/v2/CONTRACT.md`. Design: only your frame(s) in `design/frames/`.
- Touch only the paths your spec lists. Need another file changed? Stop and report it.
- Tests use fake keys (`dg_test`, `gsk_test`) and injected fetch; no network in unit tests.
- Each v2 feature checks its Settings switch and fails soft (v1 behaviour continues).
- Commit `T<n>: <summary>` on the v2 branch. Do not push. Tick your task, add one log line (≤120 chars), report ≤10 lines.

## Conventions (v2, from T1)
- LLM: `chat(messages, {json?, maxTokens?, temperature?, signal?, config?}, fetch?)` in lib/llm.ts → text; throws `LLMError`
  (.code no-key|offline|auth|rate-limited|server|bad-reply, user-facing message). Offscreen: pass `config:{settings,keys}`.
- `transcriptLines(segments, meeting.speakers)` / `speakerName(seg, speakers)` in lib/llm.ts for "[m:ss] Name: text".
- DB v2 helpers: putAsk/listAsks, putRecordingPart/listRecordingParts, get/putRecordingMeta, deleteRecording.
- `updateSettings` replaces nested objects whole: pass the full `features` object when changing one switch.

## Tasks
- [x] T1 v2 core: types, DB migration, settings, shared LLM client — opus — specs/T1.md
- [x] T2 Ask mid-meeting and after — sonnet — specs/T2.md (after T1)
- [x] T3 Live action-item suggestions — sonnet — specs/T3.md (after T1)
- [x] T4 Continuous tab recording for diarization — opus — specs/T4.md (after T1)
- [x] T5 Diarize with Deepgram + suggest names — opus — specs/T5.md (after T4)
- [x] T6 Name speakers screen, display names, Settings switches — sonnet — specs/T6.md (after T5)
- [x] T7 Connect never blocks on a bad key — opus — specs/T7.md
- [x] T8 Frame parity: build what the original frames show — sonnet — specs/T8.md

## Log
- T1 done: types, DB v2 (asks/recordings/recordingMeta), settings v2, lib/llm chat()+transcriptLines; 102 tests pass
- T4 done: lib/audio/recording.ts continuous tab parts (30s) + pause meta; offscreen writes IDB; speakerStep pending
- T2 done: lib/ask (ask, citations, save-as-note), Ask screen + Live Ask tab + Summary button, router 'ask'; 6 tests
- T3 done: lib/suggest (60s scheduler, dedupe, cursor), SuggestionCard in Live, accepted AI actions in summary; 8 tests
- T5 done: lib/diarize (Deepgram, overlap≥30%, A/B by first use), lib/speakers suggestNames+runSpeakerStep; 9 tests
- T6 done: Speakers screen (names/merge/sample), displayName, Settings switches, Deepgram paste field, keys merge; export/summarize still say Others
- Final gate: 1 finding (speaker step stuck after panel close) fixed e87d4dc. E2E blocked: penv DEEPGRAM_API_KEY returns 401.
- T7 done: checkKeys (all keys, 8s) + pickProviders fallback, Connect rows/pickers/Continue anyway, Start rejected banner
- T8: source checkboxes, offline waiting row, decision moments + due, find placeholder, curly apostrophes; item 5 already matched.
