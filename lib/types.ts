export type Speaker = 'you' | 'others';                 // UI labels: "You", "Others"
export type MarkerKind = 'decision' | 'action' | 'question' | 'bookmark';
export type MeetingStatus = 'recording' | 'processing' | 'done' | 'error';
export type SpeakerLabel = string;               // 'A', 'B', ... from diarization; only on 'others' segments

export interface Meeting {
  id: string;                 // crypto.randomUUID()
  title: string;              // defaults to the captured tab's title
  tabUrl?: string;
  startedAt: number;          // epoch ms
  endedAt?: number;
  status: MeetingStatus;
  language: 'en' | 'auto';
  summary?: Summary;
  speakers?: Record<SpeakerLabel, { name?: string; suggested?: string; evidenceMs?: number }>;
  speakerStep?: 'pending' | 'running' | 'ready' | 'saved' | 'skipped' | 'failed';
  suggestCursorMs?: number;                       // segments after this are not yet checked for actions
}

export interface Segment {    // one transcribed chunk
  id: string; meetingId: string; speaker: Speaker;
  startMs: number; endMs: number;   // offsets from meeting.startedAt
  text: string; chunkId: string;
  speakerLabel?: SpeakerLabel;
}

export interface Note { id: string; meetingId: string; atMs: number; text: string; createdAt: number }

export interface Marker {
  id: string; meetingId: string; atMs: number; kind: MarkerKind; label?: string;
  source?: 'user' | 'ai';                         // missing = 'user'
  status?: 'suggested' | 'accepted' | 'dismissed'; // only for source 'ai'
  owner?: string; due?: string;                   // free text from the suggestion, editable
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

export type ChunkStatus = 'pending' | 'done' | 'silent' | 'failed';
export interface Chunk {      // audio waiting for (or done with) transcription
  id: string; meetingId: string; speaker: Speaker;
  startMs: number; endMs: number;
  audio?: Blob;               // deleted once status is 'done' or 'silent'
  mimeType: string;           // e.g. 'audio/webm;codecs=opus'
  status: ChunkStatus; attempts: number; lastError?: string;
}

export interface Summary {
  overview: string;
  decisions: string[];
  actions: { text: string; owner?: string }[];
  questions: string[];
  generatedAt: number; model: string;
}

export type ProviderId = 'groq' | 'openrouter' | 'ollama' | 'openai' | 'anthropic';
export interface ProviderConfig { id: ProviderId; baseUrl: string; keyName?: string } // keyName: e.g. 'GROQ_API_KEY'; none for ollama

export interface Settings {
  transcription: { provider: 'groq' | 'openai'; model: string };   // groq: whisper-large-v3-turbo; openai: whisper-1
  summary: { provider: ProviderId; model: string; baseUrl?: string }; // baseUrl overrides the provider default (Ollama)
  keySource: 'penv' | 'paste';
  penv: { org: string; project: string; env: string };             // token itself lives in storage.session only
  language: 'en' | 'auto';
  onboarded: boolean;
  features: { ask: boolean; liveSuggestions: boolean; speakerNames: boolean }; // defaults: true, true, true
  diarization: { provider: 'deepgram'; model: string; keyName: 'DEEPGRAM_API_KEY' }; // model 'nova-3'
  keepAudio: boolean;                             // default false
}

export type ConnectionState =
  | { ok: true }
  | { ok: false; reason: 'offline' | 'rate-limited' | 'auth' | 'server'; retryAt?: number; pendingChunks: number };

export type RecordingState =
  | { status: 'idle' }
  | { status: 'starting' | 'recording' | 'stopping'; meetingId: string; startedAt: number; micLevel: number; tabLevel: number; micUnavailable?: boolean }; // micUnavailable: recording the tab only

// runtime messages (chrome.runtime.sendMessage); all plain JSON, never Blobs
export type Message =
  | { type: 'recording/start'; tabId: number }          // side panel → background
  | { type: 'recording/stop' }                          // side panel → background
  | { type: 'recording/state'; state: RecordingState }  // background → all (also on request)
  | { type: 'recording/get-state' }
  | { type: 'offscreen/start'; streamId: string; meetingId: string; startedAt: number } // background → offscreen
  | { type: 'offscreen/stop' }
  | { type: 'offscreen/levels'; micLevel: number; tabLevel: number }              // offscreen → background, ~4/s
  | { type: 'segment/added'; segment: Segment }         // offscreen/transcriber → all
  | { type: 'connection/state'; state: ConnectionState }
  | { type: 'transcription/drained'; meetingId: string } // queue empty for that meeting
  | { type: 'transcription/catch-up' }                   // ask the transcriber to retry pending chunks
  | { type: 'speakers/progress'; meetingId: string; step: Meeting['speakerStep'] }
  | { type: 'transcriber/config' };                      // offscreen → background only; reply: TranscriberConfig

/** Reply to `transcriber/config` (the offscreen document has no storage API). Keys are never persisted by the caller. */
export interface TranscriberConfig { settings: Settings; keys: Record<string, string> }
