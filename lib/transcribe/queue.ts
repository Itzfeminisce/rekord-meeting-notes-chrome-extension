import { getChunk, getMeeting, pendingChunks, putChunk, putSegment } from '@/lib/db';
import { send as sendMessage, onMessage } from '@/lib/messages';
import { PROVIDERS } from '@/lib/settings';
import type { Chunk, ConnectionState, Message, Segment, Settings, TranscriberConfig } from '@/lib/types';
import { TranscribeError, transcribeChunk } from './client';

export const MAX_ATTEMPTS = 5;
export const MAX_PER_MINUTE = 20;
export const MAX_BACKOFF_MS = 60_000;
/** drain() stops waiting when the queue is paused for longer than this (e.g. a long rate limit). */
const DRAIN_BLOCK_MS = 60_000;

export interface TranscriberDeps {
  fetch: typeof fetch;
  send: (msg: Message) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isOnline: () => boolean;
  getSettings: () => Promise<Settings>;
  loadKeys: () => Promise<Record<string, string>>;
}

type FailReason = Exclude<ConnectionState, { ok: true }>['reason'];

/**
 * Config loaders for the offscreen document, which has no storage API: each call asks the background
 * (`transcriber/config`) for fresh settings and keys. Nothing is cached, so keys live only for one request.
 */
export function configLoader(send: (msg: Message) => Promise<unknown> = sendMessage) {
  async function request(): Promise<TranscriberConfig> {
    const reply = (await send({ type: 'transcriber/config' })) as TranscriberConfig | undefined;
    if (!reply || typeof reply !== 'object' || !reply.settings) throw new Error('Transcriber config unavailable');
    return reply;
  }
  return {
    getSettings: async (): Promise<Settings> => (await request()).settings,
    loadKeys: async (): Promise<Record<string, string>> => (await request()).keys ?? {},
  };
}

const defaultDeps = (): TranscriberDeps => ({
  fetch: (...args) => fetch(...args),
  send: sendMessage,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  ...configLoader(),
});

/** A single-request-at-a-time transcription queue backed by the pending chunks in IndexedDB. */
export function createTranscriber(overrides: Partial<TranscriberDeps> = {}) {
  const d = { ...defaultDeps(), ...overrides };
  let running = false;
  let dirty = false;
  let authBlocked = false;
  let offlineBlocked = false;   // last request failed while the browser was offline
  let pausedUntil = 0;          // rate limit / backoff end, for drain()
  let failing = false;          // last request failed; send {ok:true} on the next success
  let backoffStep = 0;
  const requestTimes: number[] = [];
  let wakers: (() => void)[] = [];
  const waiters = new Map<string, (() => void)[]>();

  const wake = () => { const w = wakers; wakers = []; w.forEach((f) => f()); };
  const wait = async (ms: number) => {
    let waker!: () => void;
    await Promise.race([d.sleep(ms), new Promise<void>((r) => wakers.push((waker = r)))]);
    wakers = wakers.filter((w) => w !== waker);
  };

  async function sendState(reason: FailReason, retryAt?: number) {
    failing = true;
    const pending = (await pendingChunks()).length;
    const state: ConnectionState = { ok: false, reason, pendingChunks: pending, ...(retryAt ? { retryAt } : {}) };
    await d.send({ type: 'connection/state', state });
  }

  function resolveWaiters(meetingId?: string) {
    for (const [id, list] of [...waiters]) {
      if (meetingId && id !== meetingId) continue;
      waiters.delete(id);
      list.forEach((r) => r());
    }
  }

  /** Resolves drain() callers when the queue cannot make progress soon. */
  function releaseIfBlocked() {
    if (authBlocked || offlineBlocked || pausedUntil - d.now() >= DRAIN_BLOCK_MS) resolveWaiters();
  }

  /** After a chunk leaves 'pending': resolve drain() or announce the meeting as drained. */
  async function afterChunk(meetingId: string) {
    if ((await pendingChunks(meetingId)).length > 0) return;
    if (waiters.has(meetingId)) { resolveWaiters(meetingId); return; } // the drain() caller announces it
    if ((await getMeeting(meetingId))?.status === 'processing') {
      await d.send({ type: 'transcription/drained', meetingId });
    }
  }

  /** Sliding-window limiter: at most MAX_PER_MINUTE request starts in any 60 s. */
  async function takeToken() {
    for (;;) {
      const now = d.now();
      while (requestTimes.length && now - requestTimes[0]! >= 60_000) requestTimes.shift();
      if (requestTimes.length < MAX_PER_MINUTE) { requestTimes.push(now); return; }
      await d.sleep(requestTimes[0]! + 60_000 - now);
    }
  }

  async function fail(chunk: Chunk, err: TranscribeError, reason: FailReason) {
    const fresh = await getChunk(chunk.id);
    // While the browser is offline, a failed request says nothing about the chunk: don't count it.
    const counts = !(reason === 'offline' && !d.isOnline());
    offlineBlocked = !counts;
    if (fresh && counts) {
      const attempts = fresh.attempts + 1;
      await putChunk({ ...fresh, attempts, lastError: err.message, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending' });
      if (attempts >= MAX_ATTEMPTS) await afterChunk(chunk.meetingId);
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** backoffStep++);
    pausedUntil = d.now() + delay;
    await sendState(reason, pausedUntil);
    releaseIfBlocked();
    await wait(delay);
    pausedUntil = 0;
  }

  async function process(chunk: Chunk) {
    if (!chunk.audio) {
      await putChunk({ ...chunk, status: 'failed', lastError: 'No audio' });
      await afterChunk(chunk.meetingId);
      return;
    }
    const settings = await d.getSettings();
    const keyName = PROVIDERS[settings.transcription.provider].keyName;
    const key = keyName ? (await d.loadKeys())[keyName] : undefined;
    if (!key) {
      authBlocked = true;
      await sendState('auth');
      return;
    }
    await takeToken();
    let text: string;
    try {
      text = await transcribeChunk(chunk, settings, key, d.fetch);
    } catch (e) {
      const err = e instanceof TranscribeError ? e : new TranscribeError('server', 'Unexpected error');
      if (err.kind === 'auth') {
        authBlocked = true;
        await sendState('auth');
      } else if (err.kind === 'rate-limited') {
        const ms = err.retryAfterMs ?? MAX_BACKOFF_MS;
        pausedUntil = d.now() + ms;
        await sendState('rate-limited', pausedUntil);
        releaseIfBlocked();
        await wait(ms);
        pausedUntil = 0;
      } else {
        await fail(chunk, err, err.kind === 'offline' ? 'offline' : 'server');
      }
      return;
    }
    backoffStep = 0;
    offlineBlocked = false;
    const fresh = await getChunk(chunk.id);
    if (!fresh) return; // meeting deleted meanwhile
    if (text) {
      const segment: Segment = {
        id: chunk.id, meetingId: chunk.meetingId, speaker: chunk.speaker,
        startMs: chunk.startMs, endMs: chunk.endMs, text, chunkId: chunk.id,
      };
      await putSegment(segment);
      await d.send({ type: 'segment/added', segment });
    }
    const { audio: _audio, lastError: _err, ...rest } = fresh;
    await putChunk({ ...rest, status: 'done', attempts: fresh.attempts + 1 });
    if (failing) {
      failing = false;
      await d.send({ type: 'connection/state', state: { ok: true } });
    }
    await afterChunk(chunk.meetingId);
  }

  async function run() {
    running = true;
    try {
      while (dirty) {
        dirty = false;
        for (;;) {
          if (authBlocked) break;
          const next = (await pendingChunks())[0];
          if (!next) break;
          await process(next);
        }
      }
    } catch {
      // Unexpected (DB/config) error: stop this run and tell the UI; the next enqueue/catch-up starts again.
      try { await sendState('server'); } catch { /* DB unavailable too: nothing more to report */ }
    } finally {
      running = false;
      resolveWaiters();
    }
  }

  function kick() {
    dirty = true;
    if (!running) void run();
  }

  /** Queues a saved pending chunk. */
  function enqueue(_chunkId: string): void {
    kick();
  }

  /** Retries every pending chunk, including after an auth error. */
  function catchUp(): void {
    authBlocked = false;
    offlineBlocked = false;
    backoffStep = 0;
    wake();
    kick();
  }

  /**
   * Resolves once `meetingId` has no pending chunks, or the queue is blocked (auth error, offline, long pause);
   * blocked chunks stay pending for a later catch-up.
   */
  function drain(meetingId?: string): Promise<void> {
    const id = meetingId ?? '*'; // '*': resolved when the queue run ends
    const p = new Promise<void>((r) => waiters.set(id, [...(waiters.get(id) ?? []), r]));
    kick();
    releaseIfBlocked();
    if (meetingId) {
      void pendingChunks(meetingId).then((l) => { if (!l.length) resolveWaiters(meetingId); }, () => resolveWaiters());
    }
    return p;
  }

  /** Listens for `transcription/catch-up` and the browser coming back online; starts on leftover chunks. */
  function start(): () => void {
    const off = onMessage((msg) => {
      if (msg.type === 'transcription/catch-up') catchUp();
      return undefined;
    });
    const online = () => { offlineBlocked = false; wake(); kick(); };
    globalThis.addEventListener?.('online', online);
    kick();
    return () => { off(); globalThis.removeEventListener?.('online', online); };
  }

  return { enqueue, drain, catchUp, start };
}
