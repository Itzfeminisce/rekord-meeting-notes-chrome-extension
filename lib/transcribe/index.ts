// Transcriber entry point; runs inside the offscreen document.
import { createTranscriber } from './queue';

export { transcribeChunk, TranscribeError, parseRetryAfter } from './client';
export { createTranscriber } from './queue';

const transcriber = createTranscriber();
let stop: (() => void) | undefined;

/** Queues a saved pending chunk for transcription. */
export function enqueue(chunkId: string): void {
  transcriber.enqueue(chunkId);
}

/** Resolves once no chunks of `meetingId` are waiting, or the rest are blocked (auth, offline, long rate limit). */
export function drain(meetingId: string): Promise<void> {
  return transcriber.drain(meetingId);
}

/** Resolves once no chunks are waiting at all, or the rest are blocked (auth, offline, long rate limit). */
export function drainAll(): Promise<void> {
  return transcriber.drain();
}

/** Retries all pending chunks (also triggered by the `transcription/catch-up` message). */
export function catchUp(): void {
  transcriber.catchUp();
}

/** Registers the `transcription/catch-up` and `online` listeners and starts on leftover chunks. Idempotent. */
export function startTranscriber(): () => void {
  stop ??= transcriber.start();
  return () => { stop?.(); stop = undefined; };
}
