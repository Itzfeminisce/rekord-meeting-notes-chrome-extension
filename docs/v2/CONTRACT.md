# v2 contract: changes to `lib/types.ts` (T1 applies them; others import, never redefine)

```ts
export type SpeakerLabel = string;               // 'A', 'B', ... from diarization; only on 'others' segments
export interface Segment { /* v1 fields */ speakerLabel?: SpeakerLabel }

export interface Marker {
  /* v1 fields */
  source?: 'user' | 'ai';                         // missing = 'user'
  status?: 'suggested' | 'accepted' | 'dismissed'; // only for source 'ai'
  owner?: string; due?: string;                   // free text from the suggestion, editable
}

export interface Meeting {
  /* v1 fields */
  speakers?: Record<SpeakerLabel, { name?: string; suggested?: string; evidenceMs?: number }>;
  speakerStep?: 'pending' | 'running' | 'ready' | 'saved' | 'skipped' | 'failed';
  suggestCursorMs?: number;                       // segments after this are not yet checked for actions
}

export interface AskTurn {                        // store 'asks', index by meetingId
  id: string; meetingId: string; createdAt: number;
  question: string; answer?: string;
  citations?: number[];                           // atMs values the answer referenced
  error?: string;
}

export interface RecordingPart {                  // store 'recordings', index by meetingId
  id: string; meetingId: string; seq: number;     // parts concatenate in seq order into one file
  blob: Blob; mimeType: string;
}
export interface RecordingMeta { meetingId: string; pauses: { atMs: number; durationMs: number }[] }
// store 'recordingMeta', key meetingId. Recording time + sum of earlier pauses = meeting time.

export interface Settings {
  /* v1 fields */
  features: { ask: boolean; liveSuggestions: boolean; speakerNames: boolean }; // defaults: true, true, true
  diarization: { provider: 'deepgram'; model: string; keyName: 'DEEPGRAM_API_KEY' }; // model 'nova-3'
  keepAudio: boolean;                             // default false
}
```

DB: bump the version, add stores `asks`, `recordings`, `recordingMeta`; `deleteMeeting` also clears them.
Messages: add `{ type: 'speakers/progress'; meetingId: string; step: Meeting['speakerStep'] }`.
Messages (T8): `recording/start` and `offscreen/start` gain `sources?: { mic: boolean; tab: boolean }` (absent = both on; at least one is on). Tab off: no tab stream and no continuous recording; mic off: no mic permission requested.
