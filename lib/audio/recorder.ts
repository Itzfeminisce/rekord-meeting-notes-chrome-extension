import type { RecorderLike } from './chunker';

const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export function pickMimeType(): string {
  return PREFERRED.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

/** Wraps a MediaRecorder for one whole chunk (no timeslice), so each blob is a standalone file. */
export function mediaRecorder(stream: MediaStream, mimeType: string): RecorderLike {
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) parts.push(e.data); };
  return {
    mimeType: rec.mimeType || mimeType,
    start: () => rec.start(),
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        if (rec.state === 'inactive') return resolve(new Blob(parts, { type: rec.mimeType || mimeType }));
        rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType || mimeType }));
        rec.onerror = (e) => reject((e as unknown as { error?: unknown }).error ?? new Error('Recorder error'));
        rec.stop();
      }),
  };
}
