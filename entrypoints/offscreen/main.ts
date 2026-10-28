import { putChunk } from '@/lib/db';
import { onMessage, send } from '@/lib/messages';
import { Chunker } from '@/lib/audio/chunker';
import { rms, toLevel } from '@/lib/audio/levels';
import { mediaRecorder, pickMimeType } from '@/lib/audio/recorder';
import { drain, drainAll, enqueue, startTranscriber } from '@/lib/transcribe';
import type { Speaker } from '@/lib/types';

const TICK_MS = 125; // silence sampling; levels are posted every 2nd tick (~4/s)

interface Track {
  stream: MediaStream;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  chunker: Chunker;
}

interface Session {
  meetingId: string;
  ctx: AudioContext;
  tracks: Track[];
  timer: ReturnType<typeof setInterval>;
}

let session: Session | null = null;
let busy: Promise<unknown> = Promise.resolve();

/** `micUnavailable`: the microphone was refused or missing, so only the tab ('others') is recorded. */
export type OffscreenReply = { ok: true; micUnavailable?: boolean } | { ok: false; error: string };

// Resume chunks left pending (e.g. from an earlier session) and listen for catch-up / online.
startTranscriber();
// When this document was opened only to catch up, report once the queue is empty so the background can close it.
// ('*' = no particular meeting; the background ignores it while recording or waiting on a meeting's drain.)
void drainAll().then(() => {
  if (!session) void send({ type: 'transcription/drained', meetingId: '*' });
});

onMessage((msg) => {
  if (msg.type === 'offscreen/start') return (busy = busy.then(() => start(msg.streamId, msg.meetingId, msg.startedAt)));
  if (msg.type === 'offscreen/stop') return (busy = busy.then(() => stop()));
  return undefined;
});

async function start(streamId: string, meetingId: string, startedAt: number): Promise<OffscreenReply> {
  if (session) await stop();
  let tab: MediaStream | undefined;
  let mic: MediaStream | undefined;
  try {
    tab = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as MediaTrackConstraints,
      video: false,
    });
  } catch (error) {
    console.error('Rekord: tab capture failed', error);
    return { ok: false, error: "Rekord can't hear this tab. Click the Rekord icon on your meeting tab, then try again." };
  }
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    // No mic (NotAllowedError/NotFoundError, …): keep recording the tab on its own.
    console.warn('Rekord: microphone unavailable, recording the tab only', error);
  }

  const ctx = new AudioContext();
  const tabSource = ctx.createMediaStreamSource(tab);
  tabSource.connect(ctx.destination); // keep the meeting audible while it is captured
  const mimeType = pickMimeType();
  const track = (stream: MediaStream, speaker: Speaker, source: MediaStreamAudioSourceNode): Track => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const chunker = new Chunker({
      meetingId, speaker, startedAt,
      createRecorder: () => mediaRecorder(stream, mimeType),
      saveChunk: putChunk,
      onPending: (chunk) => enqueue(chunk.id),
    });
    return { stream, analyser, buffer: new Float32Array(analyser.fftSize), chunker };
  };
  const tracks = [track(tab, 'others', tabSource)];
  if (mic) tracks.push(track(mic, 'you', ctx.createMediaStreamSource(mic)));
  tracks.forEach((t) => t.chunker.start());

  // If the meeting tab closes or stops sharing, end the recording properly.
  tab.getAudioTracks()[0]?.addEventListener('ended', () => void send({ type: 'recording/stop' }));

  let n = 0;
  const timer = setInterval(() => {
    const levels = tracks.map((t) => {
      t.analyser.getFloatTimeDomainData(t.buffer);
      const value = rms(t.buffer);
      void t.chunker.tick(value);
      return toLevel(value);
    });
    if (++n % 2 === 0) void send({ type: 'offscreen/levels', tabLevel: levels[0] ?? 0, micLevel: levels[1] ?? 0 });
  }, TICK_MS);

  session = { meetingId, ctx, tracks, timer };
  return mic ? { ok: true } : { ok: true, micUnavailable: true };
}

async function stop(): Promise<OffscreenReply> {
  const s = session;
  if (!s) return { ok: true };
  session = null;
  clearInterval(s.timer);
  await Promise.all(s.tracks.map((t) => t.chunker.stop()));
  s.tracks.forEach((t) => stopStream(t.stream));
  await s.ctx.close().catch(() => undefined);
  // Report when the transcriber has caught up, so the background can close this document.
  void drain(s.meetingId).then(() => send({ type: 'transcription/drained', meetingId: s.meetingId }));
  return { ok: true };
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}
