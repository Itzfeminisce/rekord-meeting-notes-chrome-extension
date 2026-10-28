import type { Chunk, Speaker } from '../types';
import { SILENCE_RMS } from './levels';

export const CHUNK_MS = 10_000;
export const MIN_CHUNK_MS = 1_000;

/** One recording that yields a standalone playable file when stopped. */
export interface RecorderLike {
  readonly mimeType: string;
  start(): void;
  stop(): Promise<Blob>;
}

export interface ChunkerOptions {
  meetingId: string;
  speaker: Speaker;
  /** Meeting start (epoch ms); chunk offsets are relative to it. */
  startedAt: number;
  createRecorder: () => RecorderLike;
  saveChunk: (chunk: Chunk) => Promise<void>;
  /** Called after a pending (non-silent) chunk is saved. */
  onPending?: (chunk: Chunk) => void;
  now?: () => number;
  newId?: () => string;
  chunkMs?: number;
  minChunkMs?: number;
  silenceRms?: number;
}

/**
 * Records one speaker's stream in back-to-back chunks. Call `tick(rms)` often (e.g. every 125 ms) with the
 * current RMS; it rotates the recorder every `chunkMs`. Chunks whose RMS never reached the threshold are saved
 * as 'silent' without audio.
 */
export class Chunker {
  private recorder: RecorderLike | null = null;
  private chunkStart = 0;
  private peak = 0;
  private busy: Promise<void> = Promise.resolve();
  private rotating = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly chunkMs: number;
  private readonly minChunkMs: number;
  private readonly silenceRms: number;

  constructor(private readonly opts: ChunkerOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.chunkMs = opts.chunkMs ?? CHUNK_MS;
    this.minChunkMs = opts.minChunkMs ?? MIN_CHUNK_MS;
    this.silenceRms = opts.silenceRms ?? SILENCE_RMS;
  }

  start(): void {
    this.recorder = this.begin();
  }

  /** Feeds a level sample; rotates to a new chunk when the current one is long enough. */
  tick(level: number): Promise<void> {
    if (this.stopped || !this.recorder) return this.busy;
    if (level > this.peak) this.peak = level;
    if (!this.rotating && this.now() - this.chunkStart >= this.chunkMs) {
      this.rotating = true;
      const prev = this.recorder;
      const prevStart = this.chunkStart;
      const prevPeak = this.peak;
      const end = this.now();
      this.recorder = this.begin(); // start the next file before stopping the last, so no audio is lost
      this.busy = this.busy
        .then(() => this.finish(prev, prevStart, end, prevPeak, false))
        .finally(() => { this.rotating = false; });
    }
    return this.busy;
  }

  /** Stops recording and saves the last partial chunk (dropped if shorter than `minChunkMs`). */
  async stop(): Promise<void> {
    if (this.stopped) return this.busy;
    this.stopped = true;
    const rec = this.recorder;
    this.recorder = null;
    if (rec) {
      const start = this.chunkStart;
      const peak = this.peak;
      const end = this.now();
      this.busy = this.busy.then(() => this.finish(rec, start, end, peak, true));
    }
    return this.busy;
  }

  private begin(): RecorderLike {
    const rec = this.opts.createRecorder();
    rec.start();
    this.chunkStart = this.now();
    this.peak = 0;
    return rec;
  }

  private async finish(rec: RecorderLike, start: number, end: number, peak: number, last: boolean): Promise<void> {
    let blob: Blob | undefined;
    try {
      blob = await rec.stop();
    } catch (error) {
      console.error('Rekord: recorder failed to stop', error);
    }
    if (last && end - start < this.minChunkMs) return;
    const silent = peak < this.silenceRms;
    if (!silent && (!blob || blob.size === 0)) return;
    const { meetingId, speaker, startedAt } = this.opts;
    const chunk: Chunk = {
      id: this.newId(),
      meetingId,
      speaker,
      startMs: Math.max(0, start - startedAt),
      endMs: Math.max(0, end - startedAt),
      mimeType: rec.mimeType,
      status: silent ? 'silent' : 'pending',
      attempts: 0,
      ...(silent ? {} : { audio: blob }),
    };
    try {
      await this.opts.saveChunk(chunk);
    } catch (error) {
      console.error('Rekord: could not save audio chunk', error);
      return;
    }
    if (!silent) this.opts.onPending?.(chunk);
  }
}
