# v3 frames, flows and owners

Every row is a flow that must exist in the build. "→" is where it goes or what it does.
External links: Penv Cloud `https://penv.cloud`; Groq keys `https://console.groq.com/keys`; Notion connections `https://www.notion.so/profile/integrations`;
Notion "Allow more pages" → Notion help on adding connections; provider "create a new key" → that provider's key page.

## V3Setup.dc.html (T2) — replaces Connect and ConnectPaste
- Back → Permissions. "How Rekord handles your meetings" → V3HowItWorks.
- Presets: Free to start (default) / Real time / Choose my own → V3SetupCustom.
- "Use Penv Cloud" → V3PenvConnect / "Paste a key" switch; "Penv Cloud" links to `https://penv.cloud` (every mention, all frames). The v1 environment + token fields appear only behind "Use a token instead" on V3PenvConnect.
- "Paste your API key": detect the service on input; row "This is a <Service> key", jobs it covers, status Ready/
  checking; several keys may be pasted one after another (one row each). "Get a free Groq key" → Groq keys page.
- Preset needs a key it doesn't have → the missing service's key row asks for it. "Start using Rekord" → V3Start.
- States (V3States): key not recognized (service chips → check as that service), key rejected (+ "create a new key").

## V3PenvConnect.dc.html / V3PenvConnected.dc.html (T2 layout, T11 behaviour)
- Shown when "Use Penv Cloud" is chosen in V3Setup. Chosen-setup row + Change → V3Setup.
- "Connect Penv Cloud" → Penv Cloud approval window → V3PenvConnected (T11; button hidden until `WXT_PENV_APP_CONNECT`).
- "See how it works" → `https://penv.cloud`. "Use a token instead" → environment + token fields (v1 penv path).
- "Start using Rekord" disabled until a key source works, with its hint line.
- Connected: account path, one row per shared key with its job and status, "Change which keys" → reconnect.
- States (V3States): not connected (Try again), shared no usable keys (Change which keys), disconnected (Connect again).

## V3SetupCustom.dc.html (T2)
- Back → V3Setup. Transcription: Groq / OpenAI / Deepgram, description per choice, that service's key + status,
  "Switch to Groq if Deepgram stops working" (Deepgram only; sets `realtimeBackup`).
- Assistant: service list, key + status (hidden when the transcription key already covers it, with
  "This key also covers…" line), Model disclosure. "Start using Rekord" → V3Start.

## V3HowItWorks.dc.html (T2)
- Sheet from V3Setup and V3SettingsAI; Close → back. Static content, verbatim.

## V3SettingsAI.dc.html (T2) — new top of Settings
- Back → V3Start. "How Rekord handles your meetings" → V3HowItWorks.
- Transcription row → V3SetupCustom (Transcription). Assistant row → V3SetupCustom (Assistant). Status Ready /
  Rejected / Couldn't check from the existing key check.
- "Keep transcribing if Deepgram stops" switch (shown only with Deepgram) = `realtimeBackup`.
- Your keys: source line, Refresh (penv reload), one row per loaded key with its job or "not in use · Saved for later".
- "Change how Rekord works" → V3Setup. "Manage on Penv Cloud" → `https://penv.cloud` (Penv Cloud source only).
  "Disconnect" → revoke (T11) or clear pasted keys (existing behaviour, with confirm).
- "Connected apps" → V3Connections. "Recording, language and data" → existing Settings screen (minus the moved AI/key parts).

## V3Start.dc.html (T3, calendar card T6)
- Calendar card when an event is happening now (T6); none → "No meeting on your calendar right now…" (V3States);
  access lost → reconnect banner → V3GoogleConnect.
- "Where is the meeting?": In this tab (v1 flow) / In an app (system audio). App shows the Chrome-share steps.
- "Include my microphone". Start recording → V3Live (app: opens Chrome's share picker first). Library/Settings icons.

## V3NoSound.dc.html (T3)
- After app start, meeting level silent for 10 s while the mic has sound → this screen. Live meters.
- "Share again" → reopens the picker, back to V3Live when sound arrives. "Keep going with just my microphone" → V3Live
  without app audio. End → Processing.
- States (V3States): "Rekord can't hear Zoom anymore" when the share track ends mid-meeting → Share again.
  App name from the calendar event's conference link, else "the meeting app".

## V3Live.dc.html (T4)
- Status line "Transcribing as people speak" + "<n> people talking". Lines labelled by name (calendar match, T9) or
  Speaker A/B; the interim line greyed with a caret; finals become segments.
- Tabs, markers, notes, End as v2. Header "· <App>" for app meetings.
- States (V3States): "Switched to Groq" when streaming drops (backup on) with "Try real time again"; nothing missed.

## V3AskAll.dc.html (T5)
- From V3Library card. Back → Library. Range chips 7 / 30 days / All time. Suggested questions fill and send.
- Answer card "Found in <n> meetings" with one source row per meeting → Transcript of that meeting at the moment.
- States (V3States): nothing found → "Search all time".

## V3Library.dc.html (T5; attendee line and Coming up T6; share pills T7/T8)
- "Ask all your meetings" → V3AskAll. Search as v1. Cards: "With <attendees>" (or app/v1 summary line),
  pills: open actions, "In Google Docs" / "In Notion", duration. "Coming up" next calendar event (not a link).

## V3SpeakersInvite.dc.html (T9)
- Matched speaker shows the name and the evidence line. Unmatched: "Who is this? From your invite:" attendee
  chips (minus you and names already used) + "Someone else…" (free text). Note for invitees who didn't speak.
- Play sample, Skip, Save names as v2 Speakers.

## V3Connections.dc.html (T6 Google, T8 Notion)
- Back → V3SettingsAI. Google Calendar row: account, use list, "Calendar to use" select, Disconnect.
- Google Docs row. Notion row: Connect → V3NotionConnect; connected → page name + Change → V3NotionPage.
- Google not connected → each row shows Connect → V3GoogleConnect.

## V3GoogleConnect.dc.html (T6)
- Calendar / Google Docs checkboxes → scopes. "Continue to Google" → `chrome.identity` consent → V3Connections.
  "Not now" → back. Failure/cancel → stays here with an inline message in the frame's style.

## V3Share.dc.html (T7, Notion row T8)
- From Summary "Share". Include chips (as Export). Google Docs row: Saving… / Saved to Google Docs + Open /
  couldn't save + Try again (V3States). "Copy view-only link" → sets anyone-reader, copies, "Link copied…".
- Notion row: not connected → V3NotionConnect; connected → creates the page, then shows it like the Docs row.
- "More: copy, download, email" → existing Export sheet. Close → Summary.

## V3NotionConnect.dc.html / V3NotionPage.dc.html (T8)
- Secret field (or `NOTION_TOKEN` from Penv Cloud), Connect → validate → V3NotionPage.
- V3NotionPage: radio list of pages the integration can see; "Use “<page>”" → saves `notion.pageId` → back to where
  the flow started (V3Share or V3Connections). "Allow more pages" → Notion help.

## V3WhatsNew.dc.html (T10)
- Once after an update to a newer version. "Connect your calendar" → V3Connections. "Maybe later" → V3Start.

## V3States.dc.html
Each section belongs to the task of its screen above; all thirteen must exist.
