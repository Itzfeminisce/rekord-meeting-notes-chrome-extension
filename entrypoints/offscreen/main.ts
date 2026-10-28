import { deleteSegment, putChunk, putRecordingMeta, putRecordingPart, putSegment } from '@/lib/db';
import { onMessage, send } from '@/lib/messages';
import { Chunker } from '@/lib/audio/chunker';
import { rms, toLevel } from '@/lib/audio/levels';
import { mediaRecorder, pickMimeType } from '@/lib/audio/recorder';
import { ContinuousRecording, shouldRecord, sliceRecorder } from '@/lib/audio/recording';
import { resolveSources, type Sources } from '@/lib/sources';
import { appSources, type AppFlag } from '@/lib/capture';
import { APP_AUDIO_PORT, receiveAppAudio, SilenceWatch } from '@/lib/audio/appAudio';
import { drain, drainAll, enqueue, startTranscriber } from '@/lib/transcribe';
import { isStreamRequest, mediaRecorderAudio, RealtimeSession, requestToken, wantsRealtime, type SocketLike, type StreamRequest } from '@/lib/transcribe/stream';
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
  /** v3 "In an app": the shared screen audio arrives later over the side panel's link and becomes 'others'. */
  app?: AppSession;
  /** v3 real time: Deepgram streaming over the chunk recorder (which stays on as the Groq backup). */
  realtime?: RealtimeSession;
}

interface AppSession {
  /** Adds the received stream as the meeting ("others") track. */
  attach: (stream: MediaStream) => void;
  others?: Track;
  watch: SilenceWatch;
  closeLink?: () => void;
  /** Chrome only feeds a remote WebRTC track into Web Audio while a media element plays it (muted). */
  playback?: HTMLAudioElement;
}

let session: Session | null = null;
let busy: Promise<unknown> = Promise.resolve();

/** `micUnavailable`: the microphone was refused or missing, so only the tab ('others') is recorded. */
/** `recorded`: a continuous tab recording was saved for speaker names (reply to `offscreen/stop`). */
/** `realtime`: lines came from Deepgram streaming, so speaker labels are already known. */
export type OffscreenReply = { ok: true; micUnavailable?: boolean; recorded?: boolean; realtime?: boolean } | { ok: false; error: string };

// Resume chunks left pending (e.g. from an earlier session) and listen for catch-up / online.
startTranscriber();
// When this document was opened only to catch up, report once the queue is empty so the background can close it.
// ('*' = no particular meeting; the background ignores it while recording or waiting on a meeting's drain.)
void drainAll().then(() => {
  if (!session) void send({ type: 'transcription/drained', meetingId: '*' });
});

onMessage((msg) => {
  if (msg.type === 'offscreen/start') {
    const app = appSources(msg as typeof msg & AppFlag);
    return (busy = busy.then(() => start(msg.streamId, msg.meetingId, msg.startedAt, app ?? resolveSources(msg.sources), app !== null)));
  }
  if (msg.type === 'offscreen/stop') return (busy = busy.then(() => stop()));
  // "Try real time again" / "Retry now" also reconnect a dropped stream.
  if (msg.type === 'transcription/catch-up') session?.realtime?.retry();
  if (isStreamRequest(msg, 'stream/get-state')) return session?.realtime?.current ?? 'off';
  return undefined;
});

// v3: the side panel links the shared screen audio once the recording has started.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== APP_AUDIO_PORT) return;
  const app = session?.app;
  if (!app) {
    port.disconnect();
    return;
  }
  app.closeLink?.();
  app.closeLink = receiveAppAudio(port, {
    onStream: (stream) => app.attach(stream),
    onReset: () => app.watch.reset(),
    onClose: () => undefined,
  });
});

async function start(streamId: string, meetingId: string, startedAt: number, sources: Sources, app = false): Promise<OffscreenReply> {
  if (session) await stop();
  let tab: MediaStream | undefined;
  let mic: MediaStream | undefined;
  if (sources.tab && !app) {
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

  if (!tab && !mic && !app) return { ok: false, error: "Rekord can’t reach your microphone. Allow it in your browser, or also record this tab." };

  const realtime = await realtimeSession(meetingId, startedAt);
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
      saveChunk: realtime ? (chunk) => realtime.saveChunk(chunk) : putChunk,
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
  if (realtime && tab) realtime.addTrack('others', mediaRecorderAudio(tab, mimeType));
  if (realtime && mic) realtime.addTrack('you', mediaRecorderAudio(mic, mimeType));

  // If the meeting tab closes or stops sharing, end the recording properly.
  tab?.getAudioTracks()[0]?.addEventListener('ended', () => void send({ type: 'recording/stop' }));

  // v3 "In an app": same chunking, silence skip and continuous recording as tab audio, once the stream arrives.
  // Not played back: the app is already audible on the computer.
  const appSession: AppSession | undefined = app ? {
    watch: new SilenceWatch(() => void send({ type: 'app-audio/silent' })),
    attach: (stream) => {
      const a = session?.app;
      if (!a || session?.meetingId !== meetingId) return stopStream(stream);
      const first = !a.others;
      if (a.others) {
        void a.others.chunker.stop();
        tracks.splice(tracks.indexOf(a.others), 1);
      }
      a.playback?.pause();
      a.playback = new Audio();
      a.playback.muted = true;
      a.playback.srcObject = stream;
      void a.playback.play().catch(() => undefined);
      a.others = track(stream, 'others', ctx.createMediaStreamSource(stream));
      tracks.push(a.others);
      a.others.chunker.start();
      session?.realtime?.addTrack('others', mediaRecorderAudio(stream, mimeType));
      a.watch.reset();
      if (first && session) session.recording = startContinuous(stream, meetingId, startedAt, mimeType);
    },
  } : undefined;

  let n = 0;
  const timer = setInterval(() => {
    const level = (t: Track | undefined) => {
      if (!t) return 0;
      t.analyser.getFloatTimeDomainData(t.buffer);
      const value = rms(t.buffer);
      void t.chunker.tick(value);
      return toLevel(value);
    };
    const tabLevel = level(tabTrack ?? appSession?.others);
    const micLevel = level(micTrack);
    if (appSession?.others) appSession.watch.update(tabLevel, micLevel);
    if (++n % 2 === 0) void send({ type: 'offscreen/levels', tabLevel, micLevel });
  }, TICK_MS);

  const recording = tab ? startContinuous(tab, meetingId, startedAt, mimeType) : Promise.resolve(null);
  session = { meetingId, ctx, tracks, timer, recording, ...(appSession && { app: appSession }), ...(realtime && { realtime }) };
  return mic || !sources.mic ? { ok: true } : { ok: true, micUnavailable: true };
}

async function stop(): Promise<OffscreenReply> {
  const s = session;
  if (!s) return { ok: true };
  session = null;
  clearInterval(s.timer);
  s.app?.closeLink?.();
  s.app?.playback?.pause();
  const recording = await s.recording;
  const [recorded] = await Promise.all([
    recording ? recording.stop() : Promise.resolve(false),
    ...s.tracks.map((t) => t.chunker.stop()),
  ]);
  // After the last chunks are handed over: flush the sockets and settle which chunks Groq still transcribes.
  const realtime = s.realtime ? await s.realtime.stop().catch(() => false) : false;
  s.tracks.forEach((t) => stopStream(t.stream));
  await s.ctx.close().catch(() => undefined);
  // Report when the transcriber has caught up, so the background can close this document.
  void drain(s.meetingId).then(() => send({ type: 'transcription/drained', meetingId: s.meetingId }));
  return { ok: true, ...(recorded && { recorded: true }), ...(realtime && { realtime: true }) };
}

/** v3: a realtime session when Deepgram is the transcription provider and its key is loaded; else null (v1 chunks). */
async function realtimeSession(meetingId: string, startedAt: number): Promise<RealtimeSession | null> {
  try {
    const config = (await send({ type: 'transcriber/config' })) as TranscriberConfig | undefined;
    if (!config || !wantsRealtime(config)) return null;
    const sendRaw = (msg: StreamRequest) => browser.runtime.sendMessage(msg);
    return new RealtimeSession(
      { meetingId, startedAt, language: config.settings.language, backup: config.settings.realtimeBackup !== false },
      {
        getToken: () => requestToken(sendRaw),
        openSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
        saveSegment: putSegment,
        deleteSegment,
        putChunk,
        enqueue,
        emit: (msg) => void send(msg),
        now: () => Date.now(),
        isOnline: () => navigator.onLine !== false,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        newId: () => crypto.randomUUID(),
      },
    );
  } catch (error) {
    console.error('Rekord: real-time transcription unavailable', error);
    return null;
  }
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
