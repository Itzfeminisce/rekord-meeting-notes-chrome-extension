// v3 real-time transcription: Deepgram streaming, with the chunked Groq transcriber kept underneath as backup.
import { getMeeting, listSegments, putMeeting } from '@/lib/db';
import type { Chunk, ConnectionState, Meeting, Message, Segment, Settings, Speaker } from '@/lib/types';

export const GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
export const LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
/** `chunkId` of segments that came from streaming (they belong to no chunk). */
export const LIVE_CHUNK_ID = 'live';
export const RETRY_MS = 30_000;
/** How long a chunk waits for streaming finals to cover it before Groq transcribes it instead. */
export const HOLD_MS = 15_000;
/** MediaRecorder timeslice for streamed audio. */
export const TIMESLICE_MS = 250;
const EDGE_MS = 300;
const STOP_EDGE_MS = 1_000;
const CLOSE_WAIT_MS = 3_000;
const STOPPED_ERROR = 'Real-time transcription stopped';

export type StreamState = 'live' | 'backup' | 'off';
export type StreamErrorKind = 'auth' | 'offline' | 'server';

/** A failed token or socket. Messages never contain the key, the token or a response body. */
export class StreamError extends Error {
  constructor(readonly kind: StreamErrorKind, message: string) {
    super(message);
    this.name = 'StreamError';
  }
}

/**
 * Side panel / offscreen ↔ background requests that `Message` (lib/types.ts) does not list yet:
 * `stream/token` (offscreen → background, reply TokenReply) and `stream/get-state` (panel → offscreen, reply StreamState).
 */
export type StreamRequest = { type: 'stream/token' } | { type: 'stream/get-state' };
export type TokenReply = { ok: true; token: string } | { ok: false; reason: StreamErrorKind };

export function isStreamRequest<T extends StreamRequest['type']>(msg: unknown, type: T): msg is Extract<StreamRequest, { type: T }> {
  return !!msg && typeof msg === 'object' && (msg as { type?: unknown }).type === type;
}

/** Mints a short-lived Deepgram JWT (`POST /v1/auth/grant`, `Authorization: Token <key>`). */
export async function mintToken(key: string, fetchFn: typeof fetch = fetch, ttlSeconds = 30): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(GRANT_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });
  } catch {
    throw new StreamError('offline', 'Network request failed');
  }
  if (res.status === 401 || res.status === 403) throw new StreamError('auth', `HTTP ${res.status}`);
  if (!res.ok) throw new StreamError('server', `HTTP ${res.status}`);
  let body: { access_token?: unknown };
  try {
    body = (await res.json()) as { access_token?: unknown };
  } catch {
    throw new StreamError('server', 'Invalid response');
  }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new StreamError('server', 'Invalid response');
  return body.access_token;
}

/** Background side of `stream/token`: mints a token from the loaded Deepgram key. Never returns the key. */
export async function tokenReply(loadKeys: () => Promise<Record<string, string>>, fetchFn: typeof fetch = fetch): Promise<TokenReply> {
  try {
    const key = (await loadKeys()).DEEPGRAM_API_KEY?.trim();
    if (!key) return { ok: false, reason: 'auth' };
    return { ok: true, token: await mintToken(key, fetchFn) };
  } catch (e) {
    return { ok: false, reason: e instanceof StreamError ? e.kind : 'server' };
  }
}

/** Offscreen side of `stream/token`. */
export async function requestToken(sendRaw: (msg: StreamRequest) => Promise<unknown>): Promise<string> {
  const reply = (await sendRaw({ type: 'stream/token' }).catch(() => undefined)) as TokenReply | undefined;
  if (!reply) throw new StreamError('server', 'No token');
  if (!reply.ok) throw new StreamError(reply.reason, 'No token');
  return reply.token;
}

/** Whether a meeting with these settings and keys transcribes in real time. */
export function wantsRealtime(config: { settings?: Settings; keys?: Record<string, string> } | undefined): boolean {
  return config?.settings?.transcription?.provider === 'deepgram' && Boolean(config.keys?.DEEPGRAM_API_KEY?.trim());
}

export function listenUrl(language: Settings['language'], diarize: boolean): string {
  const p = new URLSearchParams({
    model: 'nova-3',
    interim_results: 'true',
    smart_format: 'true',
    language: language === 'auto' ? 'multi' : 'en',
  });
  if (diarize) p.set('diarize', 'true');
  return `${LISTEN_URL}?${p}`;
}

interface DGWord { word?: string; punctuated_word?: string; start?: number; end?: number; speaker?: number }
export interface LiveResult { final: boolean; startMs: number; endMs: number; text: string; words: DGWord[] }

/** Parses one Deepgram `Results` message (times relative to the socket's audio start); null for anything else. */
export function parseResult(data: unknown): LiveResult | null {
  if (typeof data !== 'string') return null;
  let msg: { type?: unknown; is_final?: unknown; start?: unknown; duration?: unknown; channel?: { alternatives?: { transcript?: unknown; words?: unknown }[] } };
  try { msg = JSON.parse(data); } catch { return null; }
  if (!msg || msg.type !== 'Results') return null;
  const alt = msg.channel?.alternatives?.[0];
  const start = typeof msg.start === 'number' ? msg.start : 0;
  const duration = typeof msg.duration === 'number' ? msg.duration : 0;
  return {
    final: msg.is_final === true,
    startMs: Math.round(start * 1000),
    endMs: Math.round((start + duration) * 1000),
    text: typeof alt?.transcript === 'string' ? alt.transcript.trim() : '',
    words: Array.isArray(alt?.words) ? (alt.words as DGWord[]) : [],
  };
}

/** Deepgram speaker index → "A", "B", … */
export function speakerLetter(n: number): string {
  return n < 26 ? String.fromCharCode(65 + n) : `S${n + 1}`;
}

export interface SegmentContext { meetingId: string; speaker: Speaker; offsetMs: number; diarize: boolean; newId: () => string }

/** Final → one segment per run of one diarized speaker; interim → the current speaker's run as one interim line. */
export function toSegments(r: LiveResult, c: SegmentContext): Segment[] {
  if (!r.text) return [];
  const base = { meetingId: c.meetingId, speaker: c.speaker, chunkId: LIVE_CHUNK_ID };
  const runs: { words: DGWord[]; speaker?: number }[] = [];
  if (c.diarize && r.words.length) {
    for (const w of r.words) {
      const last = runs[runs.length - 1];
      if (last && last.speaker === w.speaker) last.words.push(w);
      else runs.push({ words: [w], speaker: w.speaker });
    }
  }
  const make = (words: DGWord[] | null, spk: number | undefined, interim: boolean): Segment => {
    const text = words ? words.map((w) => w.punctuated_word ?? w.word ?? '').join(' ').trim() : r.text;
    const startMs = words?.[0]?.start !== undefined ? Math.round(words[0].start * 1000) : r.startMs;
    const endW = words?.[words.length - 1]?.end;
    const endMs = endW !== undefined ? Math.round(endW * 1000) : r.endMs;
    return {
      ...base,
      id: interim ? `interim:${c.speaker}` : c.newId(),
      startMs: c.offsetMs + startMs,
      endMs: c.offsetMs + endMs,
      text,
      ...(c.diarize && typeof spk === 'number' && { speakerLabel: speakerLetter(spk) }),
      ...(interim && { interim: true }),
    };
  };
  if (!r.final) {
    const last = runs[runs.length - 1];
    return [last ? make(last.words, last.speaker, true) : make(null, undefined, true)];
  }
  if (!runs.length) return [make(null, undefined, false)];
  return runs.map((run) => make(run.words, run.speaker, false)).filter((s) => s.text);
}

const mid = (s: Pick<Segment, 'startMs' | 'endMs'>) => (s.startMs + s.endMs) / 2;
const within = (s: Pick<Segment, 'startMs' | 'endMs'>, from: number, to: number) => mid(s) >= from && mid(s) < to;

/**
 * A chunk transcribed by Groq replaces the streamed lines it covers (same speaker, middle inside the chunk), so the
 * transcript never shows the same words twice. Used by the side panel when that chunk's segment arrives.
 */
export function supersede(list: Segment[], seg: Segment): Segment[] {
  if (seg.chunkId === LIVE_CHUNK_ID || seg.interim) return list;
  return list.filter((s) => !(s.chunkId === LIVE_CHUNK_ID && s.speaker === seg.speaker && within(s, seg.startMs, seg.endMs)));
}

/** Distinct people heard live: "you" plus each diarized label. */
export function liveSpeakerCount(segments: Segment[]): number {
  const keys = new Set<string>();
  for (const s of segments) {
    if (s.chunkId !== LIVE_CHUNK_ID || s.interim || !s.text.trim()) continue;
    keys.add(s.speaker === 'you' ? 'you' : `o:${s.speakerLabel ?? ''}`);
  }
  return keys.size;
}

/** For a realtime meeting, the names step uses the live labels instead of a Deepgram pass after the meeting. */
export async function liveLabels(
  meetingId: string,
  db: { getMeeting: (id: string) => Promise<Meeting | undefined>; listSegments: (id: string) => Promise<Segment[]>; putMeeting: (m: Meeting) => Promise<void> } =
    { getMeeting, listSegments, putMeeting },
): Promise<string[]> {
  const labels = [...new Set((await db.listSegments(meetingId)).filter((s) => s.speaker === 'others' && s.speakerLabel).map((s) => s.speakerLabel!))].sort();
  const meeting = await db.getMeeting(meetingId);
  if (!meeting || !labels.length) return labels;
  const speakers = { ...(meeting.speakers ?? {}) };
  for (const l of labels) speakers[l] ??= {};
  await db.putMeeting({ ...meeting, speakers });
  return labels;
}

// ---------------------------------------------------------------------------------------------------------------

export interface SocketLike {
  send(data: Blob | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Starts sending one stream's audio; the returned stop resolves once the last piece was handed over. */
export type AudioStarter = (onData: (blob: Blob) => void) => () => Promise<void> | void;

export interface StreamDeps {
  getToken: () => Promise<string>;
  openSocket: (url: string, protocols: string[]) => SocketLike;
  saveSegment: (s: Segment) => Promise<void>;
  deleteSegment: (id: string) => Promise<void>;
  putChunk: (c: Chunk) => Promise<void>;
  enqueue: (chunkId: string) => void;
  emit: (msg: Message) => void;
  now: () => number;
  isOnline: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  newId: () => string;
}

type Decision = 'stream' | 'groq';
interface Held { chunk: Chunk; resolve: (d: Decision) => void; timer: unknown }

/** One speaker's socket (mic → "You", or the meeting audio → diarized). Reconnects with a fresh token. */
export class LiveTrack {
  private ws: SocketLike | null = null;
  private stopAudio: (() => Promise<void> | void) | null = null;
  private connecting = false;
  private stopping = false;
  private liveFrom: number | null = null;
  private offset = 0;
  private finalUntil = 0;
  private stored: { id: string; startMs: number; endMs: number }[] = [];
  private groqRanges: [number, number][] = [];
  private held: Held[] = [];
  private retryTimer: unknown = null;
  private interimShown = false;
  private closeWaiter: (() => void) | null = null;
  /** A drop or failed connect happened and the socket isn't live again yet. */
  down = false;
  lastError: StreamErrorKind = 'server';
  finals = 0;

  constructor(
    readonly speaker: Speaker,
    private readonly o: { meetingId: string; startedAt: number; language: Settings['language']; backup: boolean; startAudio: AudioStarter },
    private readonly d: StreamDeps,
    private readonly onChange: () => void,
  ) {}

  get live(): boolean { return this.liveFrom !== null; }
  private get diarize(): boolean { return this.speaker === 'others'; }
  private meetingNow(): number { return this.d.now() - this.o.startedAt; }

  async connect(): Promise<void> {
    if (this.stopping || this.connecting || this.ws) return;
    this.connecting = true;
    this.clearRetry();
    let ws: SocketLike;
    try {
      const token = await this.d.getToken();
      if (this.stopping) { this.connecting = false; return; }
      ws = this.d.openSocket(listenUrl(this.o.language, this.diarize), ['bearer', token]);
    } catch (e) {
      this.connecting = false;
      this.lastError = e instanceof StreamError ? e.kind : 'server';
      this.drop();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connecting = false;
      this.offset = this.meetingNow();
      this.liveFrom = this.offset;
      this.finalUntil = this.offset;
      this.down = false;
      this.stopAudio = this.o.startAudio((blob) => { if (this.ws === ws) try { ws.send(blob); } catch { /* closing */ } });
      this.onChange();
    };
    ws.onmessage = (e) => { if (this.ws === ws) void this.message(e.data); };
    ws.onclose = () => this.closed(ws);
    ws.onerror = () => this.closed(ws);
  }

  /** "Try real time again" / every 30 s while down. */
  retry(): void {
    if (this.down && !this.ws && !this.connecting) void this.connect();
  }

  /** Decides who transcribes a saved chunk: the stream (it covered it) or Groq. */
  gate(chunk: Chunk): Promise<Decision> {
    if (this.covered(chunk, EDGE_MS)) return Promise.resolve('stream');
    if (this.liveFrom === null || this.liveFrom > chunk.startMs + EDGE_MS) return Promise.resolve(this.toGroq(chunk));
    return new Promise<Decision>((resolve) => {
      const h: Held = { chunk, resolve, timer: null };
      h.timer = this.d.setTimer(() => this.release(h, this.toGroq(chunk)), HOLD_MS);
      this.held.push(h);
    });
  }

  /** Flushes the socket (CloseStream) so the last finals arrive, then settles every held chunk. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRetry();
    const ws = this.ws;
    if (ws) {
      try { await this.stopAudio?.(); } catch { /* recorder already gone */ }
      this.stopAudio = null;
      const closed = new Promise<void>((r) => {
        this.closeWaiter = r;
        this.d.setTimer(r, CLOSE_WAIT_MS);
      });
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* already closed */ }
      await closed;
      try { ws.close(1000); } catch { /* ignore */ }
      this.ws = null;
    }
    for (const h of [...this.held]) this.release(h, this.covered(h.chunk, STOP_EDGE_MS) ? 'stream' : this.toGroq(h.chunk));
    this.liveFrom = null;
    if (this.interimShown) this.clearInterim();
  }

  private covered(c: Chunk, edge: number): boolean {
    return this.liveFrom !== null && this.liveFrom <= c.startMs + edge && this.finalUntil >= c.endMs - edge;
  }

  /** Groq takes the chunk: with backup on, streamed lines inside it are removed so nothing shows twice. */
  private toGroq(chunk: Chunk): Decision {
    if (!this.o.backup) return 'groq';
    this.groqRanges.push([chunk.startMs, chunk.endMs]);
    const drop = this.stored.filter((s) => within(s, chunk.startMs, chunk.endMs));
    this.stored = this.stored.filter((s) => !drop.includes(s));
    for (const s of drop) void this.d.deleteSegment(s.id).catch(() => undefined);
    return 'groq';
  }

  private release(h: Held, d: Decision): void {
    if (!this.held.includes(h)) return;
    this.held = this.held.filter((x) => x !== h);
    this.d.clearTimer(h.timer);
    h.resolve(d);
  }

  private async message(data: unknown): Promise<void> {
    const r = parseResult(data);
    if (!r) return;
    const segs = toSegments(r, { meetingId: this.o.meetingId, speaker: this.speaker, offsetMs: this.offset, diarize: this.diarize, newId: this.d.newId });
    if (!r.final) {
      const seg = segs[0];
      if (seg) { this.interimShown = true; this.d.emit({ type: 'segment/added', segment: seg }); }
      return;
    }
    this.finalUntil = Math.max(this.finalUntil, this.offset + r.endMs);
    if (this.interimShown) this.clearInterim();
    for (const seg of segs) {
      if (this.groqRanges.some(([a, b]) => within(seg, a, b))) continue; // Groq already has these words
      this.stored.push({ id: seg.id, startMs: seg.startMs, endMs: seg.endMs });
      this.finals += 1;
      try { await this.d.saveSegment(seg); } catch { continue; }
      this.d.emit({ type: 'segment/added', segment: seg });
    }
    for (const h of [...this.held]) if (this.covered(h.chunk, EDGE_MS)) this.release(h, 'stream');
  }

  private clearInterim(): void {
    this.interimShown = false;
    const now = this.meetingNow();
    this.d.emit({ type: 'segment/added', segment: { id: `interim:${this.speaker}`, meetingId: this.o.meetingId, speaker: this.speaker, startMs: now, endMs: now, text: '', chunkId: LIVE_CHUNK_ID, interim: true } });
  }

  private closed(ws: SocketLike): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.connecting = false;
    const stopAudio = this.stopAudio;
    this.stopAudio = null;
    try { void stopAudio?.(); } catch { /* ignore */ }
    if (this.stopping) { this.closeWaiter?.(); return; }
    this.lastError = this.d.isOnline() ? 'server' : 'offline';
    this.drop();
  }

  private drop(): void {
    this.liveFrom = null;
    this.down = true;
    if (this.interimShown) this.clearInterim();
    for (const h of [...this.held]) this.release(h, this.toGroq(h.chunk));
    this.onChange();
    if (!this.stopping) {
      this.clearRetry();
      this.retryTimer = this.d.setTimer(() => { this.retryTimer = null; void this.connect(); }, RETRY_MS);
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.d.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }
}

/**
 * The realtime side of one recording: a LiveTrack per speaker, chunk gating (streamed chunks are marked done,
 * the rest go to the Groq queue, or stay 'failed' when backup is off) and the `stream/state` broadcast.
 */
export class RealtimeSession {
  private tracks = new Map<Speaker, LiveTrack>();
  private pending = new Set<Promise<void>>();
  private state: StreamState = 'off';
  private lost = false;

  constructor(
    private readonly o: { meetingId: string; startedAt: number; language: Settings['language']; backup: boolean },
    private readonly d: StreamDeps,
  ) {}

  get current(): StreamState { return this.state; }
  /** At least one line came from streaming (the meeting is marked `realtime`). */
  get realtime(): boolean { return [...this.tracks.values()].some((t) => t.finals > 0) || this.hadFinals; }
  private hadFinals = false;

  /** Starts (or replaces) the socket for one speaker's audio. */
  addTrack(speaker: Speaker, startAudio: AudioStarter): void {
    const old = this.tracks.get(speaker);
    if (old) { if (old.finals) this.hadFinals = true; void old.stop(); }
    const t = new LiveTrack(speaker, { ...this.o, startAudio }, this.d, () => this.update());
    this.tracks.set(speaker, t);
    void t.connect();
  }

  retry(): void {
    for (const t of this.tracks.values()) t.retry();
  }

  /** Chunker `saveChunk`: never blocks the chunker; the decision lands in the db shortly after. */
  saveChunk(chunk: Chunk): Promise<void> {
    const track = this.tracks.get(chunk.speaker);
    if (!track || chunk.status !== 'pending') return this.d.putChunk(chunk);
    const p: Promise<void> = track.gate(chunk)
      .then(async (decision) => {
        if (decision === 'stream') {
          const { audio: _a, ...rest } = chunk;
          await this.d.putChunk({ ...rest, status: 'done' });
        } else if (this.o.backup) {
          await this.d.putChunk(chunk);
          this.d.enqueue(chunk.id);
        } else {
          await this.d.putChunk({ ...chunk, status: 'failed', lastError: STOPPED_ERROR });
        }
      })
      .catch((error) => console.error('Rekord: could not save audio chunk', error))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    return Promise.resolve();
  }

  /** Closes every socket after its last finals, settles all chunks; true when the meeting was transcribed live. */
  async stop(): Promise<boolean> {
    await Promise.all([...this.tracks.values()].map((t) => t.stop()));
    while (this.pending.size) await Promise.all([...this.pending]);
    const realtime = this.realtime;
    this.set('off');
    if (this.lost) this.d.emit({ type: 'connection/state', state: { ok: true } });
    return realtime;
  }

  private update(): void {
    const ts = [...this.tracks.values()];
    const down = ts.find((t) => t.down);
    if (down) {
      this.set(this.o.backup ? 'backup' : 'off');
      if (!this.o.backup) {
        this.lost = true;
        const state: ConnectionState = { ok: false, reason: down.lastError, pendingChunks: 0, ...(down.lastError !== 'auth' && { retryAt: this.d.now() + RETRY_MS }) };
        this.d.emit({ type: 'connection/state', state });
      }
      return;
    }
    if (ts.some((t) => t.live)) {
      this.set('live');
      if (this.lost) { this.lost = false; this.d.emit({ type: 'connection/state', state: { ok: true } }); }
    }
  }

  private set(next: StreamState): void {
    if (next === this.state) return;
    this.state = next;
    this.d.emit({ type: 'stream/state', state: next });
  }
}

/** Streams a MediaStream's audio as webm/opus pieces (Deepgram reads the container, so no `encoding` is set). */
export function mediaRecorderAudio(stream: MediaStream, mimeType: string): AudioStarter {
  return (onData) => {
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) onData(e.data); };
    rec.start(TIMESLICE_MS);
    return () => new Promise<void>((resolve) => {
      if (rec.state === 'inactive') return resolve();
      rec.addEventListener('stop', () => resolve(), { once: true });
      rec.stop();
    });
  };
}
