import { putChunk, putRecordingMeta, putRecordingPart } from '@/lib/db';
import { onMessage, send } from '@/lib/messages';
import { Chunker } from '@/lib/audio/chunker';
import { rms, toLevel } from '@/lib/audio/levels';
import { mediaRecorder, pickMimeType } from '@/lib/audio/recorder';
import { ContinuousRecording, shouldRecord, sliceRecorder } from '@/lib/audio/recording';
import { resolveSources, type Sources } from '@/lib/sources';
import { drain, drainAll, enqueue, startTranscriber } from '@/lib/transcribe';
import type { Speaker, TranscriberConfig } from '@/lib/types';

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
  /** v2: continuous tab recording for diarization, or null when not wanted (resolves once decided). */
  recording: Promise<ContinuousRecording | null>;
}

let session: Session | null = null;
let busy: Promise<unknown> = Promise.resolve();

/** `micUnavailable`: the microphone was refused or missing, so only the tab ('others') is recorded. */
/** `recorded`: a continuous tab recording was saved for speaker names (reply to `offscreen/stop`). */
export type OffscreenReply = { ok: true; micUnavailable?: boolean; recorded?: boolean } | { ok: false; error: string };

// Resume chunks left pending (e.g. from an earlier session) and listen for catch-up / online.
startTranscriber();
// When this document was opened only to catch up, report once the queue is empty so the background can close it.
// ('*' = no particular meeting; the background ignores it while recording or waiting on a meeting's drain.)
void drainAll().then(() => {
  if (!session) void send({ type: 'transcription/drained', meetingId: '*' });
});

onMessage((msg) => {
  if (msg.type === 'offscreen/start') return (busy = busy.then(() => start(msg.streamId, msg.meetingId, msg.startedAt, resolveSources(msg.sources))));
  if (msg.type === 'offscreen/stop') return (busy = busy.then(() => stop()));
  return undefined;
});

async function start(streamId: string, meetingId: string, startedAt: number, sources: Sources): Promise<OffscreenReply> {
  if (session) await stop();
  let tab: MediaStream | undefined;
  let mic: MediaStream | undefined;
  if (sources.tab) {
    try {
      tab = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as MediaTrackConstraints,
        video: false,
      });
    } catch (error) {
      console.error('Rekord: tab capture failed', error);
      return { ok: false, error: "Rekord can’t hear this tab. Click the Rekord icon on your meeting tab, then try again." };
    }
  }
  if (sources.mic) try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    // No mic (NotAllowedError/NotFoundError, …): keep recording the tab on its own.
    console.warn('Rekord: microphone unavailable, recording the tab only', error);
  }

  if (!tab && !mic) return { ok: false, error: "Rekord can’t reach your microphone. Allow it in your browser, or also record this tab." };

  const ctx = new AudioContext();
  const tabSource = tab && ctx.createMediaStreamSource(tab);
  tabSource?.connect(ctx.destination); // keep the meeting audible while it is captured
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
  const tracks: Track[] = [];
  const tabTrack = tab && tabSource ? track(tab, 'others', tabSource) : undefined;
  const micTrack = mic ? track(mic, 'you', ctx.createMediaStreamSource(mic)) : undefined;
  if (tabTrack) tracks.push(tabTrack);
  if (micTrack) tracks.push(micTrack);
  tracks.forEach((t) => t.chunker.start());

  // If the meeting tab closes or stops sharing, end the recording properly.
  tab?.getAudioTracks()[0]?.addEventListener('ended', () => void send({ type: 'recording/stop' }));

  let n = 0;
  const timer = setInterval(() => {
    const level = (t: Track | undefined) => {
      if (!t) return 0;
      t.analyser.getFloatTimeDomainData(t.buffer);
      const value = rms(t.buffer);
      void t.chunker.tick(value);
      return toLevel(value);
    };
    const tabLevel = level(tabTrack);
    const micLevel = level(micTrack);
    if (++n % 2 === 0) void send({ type: 'offscreen/levels', tabLevel, micLevel });
  }, TICK_MS);

  const recording = tab ? startContinuous(tab, meetingId, startedAt, mimeType) : Promise.resolve(null);
  session = { meetingId, ctx, tracks, timer, recording };
  return mic || !sources.mic ? { ok: true } : { ok: true, micUnavailable: true };
}

async function stop(): Promise<OffscreenReply> {
  const s = session;
  if (!s) return { ok: true };
  session = null;
  clearInterval(s.timer);
  const recording = await s.recording;
  const [recorded] = await Promise.all([
    recording ? recording.stop() : Promise.resolve(false),
    ...s.tracks.map((t) => t.chunker.stop()),
  ]);
  s.tracks.forEach((t) => stopStream(t.stream));
  await s.ctx.close().catch(() => undefined);
  // Report when the transcriber has caught up, so the background can close this document.
  void drain(s.meetingId).then(() => send({ type: 'transcription/drained', meetingId: s.meetingId }));
  return recorded ? { ok: true, recorded: true } : { ok: true };
}

/**
 * v2: one continuous recording of the tab stream for after-meeting diarization, when Speaker names is on and a
 * diarization key is loaded. Settings come from the background (no storage API here). Fails soft: returns null.
 */
async function startContinuous(tab: MediaStream, meetingId: string, startedAt: number, mimeType: string): Promise<ContinuousRecording | null> {
  try {
    const config = (await send({ type: 'transcriber/config' })) as TranscriberConfig | undefined;
    if (!shouldRecord(config, tab.getAudioTracks().length > 0)) return null;
    if (session?.meetingId !== meetingId) return null; // stopped while asking
    const recording = new ContinuousRecording({
      meetingId, startedAt,
      createRecorder: (onData) => sliceRecorder(tab, mimeType, onData),
      savePart: putRecordingPart,
      saveMeta: putRecordingMeta,
    });
    recording.start();
    return recording;
  } catch (error) {
    console.error('Rekord: continuous recording unavailable', error);
    return null;
  }
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}
