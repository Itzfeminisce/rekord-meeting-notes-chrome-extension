# Rekord v2 handoff

## Rules
- Same rules and conventions as `docs/v1/HANDOFF.md` "Rules" and "Conventions" (read those two sections only).
- Types: `docs/v2/CONTRACT.md`. Design: only your frame(s) in `design/frames/`.
- Touch only the paths your spec lists. Need another file changed? Stop and report it.
- Tests use fake keys (`dg_test`, `gsk_test`) and injected fetch; no network in unit tests.
- Each v2 feature checks its Settings switch and fails soft (v1 behaviour continues).
- Commit `T<n>: <summary>` on the v2 branch. Do not push. Tick your task, add one log line (≤120 chars), report ≤10 lines.

## Tasks
- [x] T1 v2 core: types, DB migration, settings, shared LLM client — opus — specs/T1.md
- [ ] T2 Ask mid-meeting and after — sonnet — specs/T2.md (after T1)
- [ ] T3 Live action-item suggestions — sonnet — specs/T3.md (after T1)
- [ ] T4 Continuous tab recording for diarization — opus — specs/T4.md (after T1)
- [ ] T5 Diarize with Deepgram + suggest names — opus — specs/T5.md (after T4)
- [ ] T6 Name speakers screen, display names, Settings switches — sonnet — specs/T6.md (after T5)

## Log
- T1 done: types, DB v2 (asks/recordings/recordingMeta), settings v2, lib/llm chat()+transcriptLines; 102 tests pass
