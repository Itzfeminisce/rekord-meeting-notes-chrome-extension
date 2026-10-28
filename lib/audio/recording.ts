import { deleteRecording } from '../db';
import type { RecordingMeta, RecordingPart, TranscriberConfig } from '../types';

/** Each `dataavailable` slice becomes one RecordingPart; parts concatenate in seq order into one file. */
export const PART_MS = 30_000;
export const RECORDING_BITRATE = 32_000;

/** One continuous recorder that emits a slice every `timesliceMs` (slices are fragments of a single file). */
export interface SliceRecorder {
  readonly mimeType: string;
  start(timesliceMs: number): void;
  pause(): void;
  resume(): void;
  /** Resolves after the final slice has been emitted. */
  stop(): Promise<void>;
}

export interface ContinuousRecordingOptions {
  meetingId: string;
  /** Meeting start (epoch ms); pause offsets are relative to it. */
  startedAt: number;
  createRecorder: (onData: (blob: Blob) => void) => SliceRecorder;
  savePart: (part: RecordingPart) => Promise<void>;
  saveMeta: (meta: RecordingMeta) => Promise<void>;
  /** Removes every saved part and the metadata of a meeting; defaults to db `deleteRecording`. */
  deleteRecording?: (meetingId: string) => Promise<void>;
  now?: () => number;
  newId?: () => string;
  partMs?: number;
}

/**
 * Should this meeting keep a continuous tab recording for diarization? Only with tab audio, the speaker-names
 * switch on, and a diarization key loaded. Only presence is checked; the key itself is never kept.
 */
export function shouldRecord(config: TranscriberConfig | undefined, hasTabAudio: boolean): boolean {
  if (!hasTabAudio || !config) return false;
  const { settings, keys } = config;
  if (!settings.features?.speakerNames) return false;
  const keyName = settings.diarization?.keyName ?? 'DEEPGRAM_API_KEY';
  return Boolean(keys?.[keyName]);
}

/**
 * Records the tab stream for the whole meeting as RecordingParts {seq 0, 1, …}, with pauses in RecordingMeta.
 * `pauses[].atMs` is recording time (meeting time minus earlier pauses) where the pause starts. Fails soft: a write
 * error is logged and recording continues; stop() never throws.
 */
export class ContinuousRecording {
  private readonly o: Required<Omit<ContinuousRecordingOptions, 'now' | 'newId' | 'partMs' | 'deleteRecording'>> & {
    now: () => number; newId: () => string; partMs: number; deleteRecording: (meetingId: string) => Promise<void>;
  };
  private recorder: SliceRecorder | null = null;
  private seq = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private meta: RecordingMeta;
  private pausedAt: number | null = null;
  private stopped = false;
  private writeFailed = false;

  constructor(opts: ContinuousRecordingOptions) {
    this.o = {
      ...opts,
      now: opts.now ?? Date.now,
      newId: opts.newId ?? (() => crypto.randomUUID()),
      partMs: opts.partMs ?? PART_MS,
      deleteRecording: opts.deleteRecording ?? deleteRecording,
    };
    this.meta = { meetingId: opts.meetingId, pauses: [] };
  }

  /** Number of parts handed to `savePart` so far. */
  get parts(): number { return this.seq; }
  get paused(): boolean { return this.pausedAt !== null; }

  start(): void {
    if (this.recorder || this.stopped) return;
    this.recorder = this.o.createRecorder((blob) => this.onData(blob));
    this.writeMeta();
    this.recorder.start(this.o.partMs);
  }

  pause(): void {
    if (!this.recorder || this.stopped || this.pausedAt !== null) return;
    this.recorder.pause();
    this.pausedAt = this.o.now();
  }

  resume(): void {
    if (!this.recorder || this.stopped || this.pausedAt === null) return;
    this.closePause();
    this.recorder.resume();
  }

  /** Flushes the final part and waits for every write. Resolves true when at least one part was saved. */
  async stop(): Promise<boolean> {
    if (this.stopped) { await this.writes; return this.ok(); }
    this.stopped = true;
    if (this.pausedAt !== null) this.closePause();
    try {
      await this.recorder?.stop();
    } catch (error) {
      console.error('Rekord: continuous recording failed to stop', error);
    }
    await this.writes;
    return this.ok();
  }

  /** True when parts were saved with no gap; otherwise drops what was saved so no speaker step runs on a broken file. */
  private async ok(): Promise<boolean> {
    if (this.writeFailed) {
      try { await this.o.deleteRecording(this.o.meetingId); } catch (error) { console.error('Rekord: could not delete failed recording', error); }
      return false;
    }
    return this.seq > 0;
  }

  private closePause(): void {
    const at = this.pausedAt!;
    this.pausedAt = null;
    const earlier = this.meta.pauses.reduce((sum, p) => sum + p.durationMs, 0);
    const atMs = Math.max(0, at - this.o.startedAt - earlier);
    this.meta = { ...this.meta, pauses: [...this.meta.pauses, { atMs, durationMs: Math.max(0, this.o.now() - at) }] };
    this.writeMeta();
  }

  private onData(blob: Blob): void {
    if (blob.size === 0 || this.writeFailed) return;
    const part: RecordingPart = {
      id: this.o.newId(),
      meetingId: this.o.meetingId,
      seq: this.seq++,
      blob,
      mimeType: this.recorder?.mimeType || blob.type,
    };
    this.queue(async () => {
      if (this.writeFailed) return;
      try { await this.o.savePart(part); } catch (error) { this.writeFailed = true; throw error; }
    }, 'part');
  }

  private writeMeta(): void {
    const meta = this.meta;
    this.queue(() => this.o.saveMeta(meta), 'metadata');
  }

  private queue(write: () => Promise<void>, what: string): void {
    this.writes = this.writes.then(write).catch((error) => console.error(`Rekord: could not save recording ${what}`, error));
  }
}

/** Wraps a MediaRecorder with a timeslice so the tab stream becomes one continuous file in parts. */
export function sliceRecorder(stream: MediaStream, mimeType: string, onData: (blob: Blob) => void): SliceRecorder {
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: RECORDING_BITRATE } : undefined);
  rec.ondataavailable = (e) => onData(e.data);
  return {
    mimeType: rec.mimeType || mimeType,
    start: (ms) => rec.start(ms),
    pause: () => { if (rec.state === 'recording') rec.pause(); },
    resume: () => { if (rec.state === 'paused') rec.resume(); },
    stop: () =>
      new Promise<void>((resolve) => {
        if (rec.state === 'inactive') return resolve();
        rec.onstop = () => resolve(); // fires after the final dataavailable
        rec.onerror = () => resolve();
        rec.stop();
      }),
  };
}
