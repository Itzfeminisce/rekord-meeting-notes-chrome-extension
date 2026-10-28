# v3 contract: changes to `lib/types.ts` (T1 applies them; others import, never redefine)

```ts
export type TranscriptionProvider = 'groq' | 'openai' | 'deepgram';
export type SetupPreset = 'free' | 'realtime' | 'custom';
export type MeetingSource = 'tab' | 'app';      // 'app' = desktop app via system audio

export interface Settings {
  /* v2 fields; transcription.provider widens to TranscriptionProvider */
  setup: SetupPreset;                              // default 'free'
  keySource: 'penv' | 'penv-app' | 'paste';         // 'penv-app' = one-click Penv Cloud connection (T11)
  penvApp?: { connectionId: string; org: string; project: string; env: string; keys: string[] }; // grant itself in session storage
  realtimeBackup: boolean;                         // "Switch to Groq if Deepgram stops working", default true
  google: { calendar: boolean; docs: boolean; calendarId?: string; email?: string }; // connected scopes
  notion: { pageId?: string; pageTitle?: string };
  lastSeenVersion?: string;                        // What's new shows when the manifest version is newer
}

export interface CalendarEvent {
  id: string; title: string; start: number; end: number;
  attendees: { name?: string; email: string; self?: boolean }[];
  app?: 'meet' | 'zoom' | 'teams';                 // from the conference link, used for "· Zoom" labels
}

export interface ShareRecord { kind: 'gdocs' | 'notion'; url: string; at: number; linkShared?: boolean }

export interface Meeting {
  /* v2 fields */
  source?: MeetingSource;                          // missing = 'tab'
  event?: CalendarEvent;                           // the matched calendar event
  shares?: ShareRecord[];
  realtime?: boolean;                              // live labels came from Deepgram streaming
}

export interface Segment {
  /* v2 fields */
  interim?: boolean;                               // streaming text not final yet (never stored, UI only)
}
```

Keys: `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `NOTION_TOKEN`.
`lib/keyDetect.ts`: `detectKey(value) → KeyName | null` (`gsk_` Groq, `sk-ant-` Anthropic, `sk-or-` OpenRouter,
`sk-` OpenAI, `ntn_`/`secret_` Notion, 40 hex chars Deepgram) and `jobsFor(name) → ('transcription'|'assistant')[]`.
DB: bump the version only if a store is added; new Meeting fields are optional and need no migration.
Messages: add `{ type: 'stream/state'; state: 'live' | 'backup' | 'off' }` and `{ type: 'app-audio/silent' }`,
`{ type: 'app-audio/ended' }`.
