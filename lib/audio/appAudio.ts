import { onMessage, send } from '@/lib/messages';
import type { CalendarEvent } from '@/lib/types';

/**
 * v3 "In an app": the meeting runs in a desktop app (Zoom, Teams…), so Rekord records the computer's audio.
 * The side panel asks Chrome for the screen with system audio, drops the video at once, and hands the audio to the
 * offscreen recorder over a local WebRTC link (a MediaStream cannot be posted between extension pages).
 * The link keeps one "others" track alive for the whole meeting: Share again swaps the sent track in place, so the
 * recorder's chunking, silence skip and continuous recording carry on without a restart.
 */

/** Options for Chrome's share picker: the screen plus the computer's audio. */
export const APP_DISPLAY_OPTIONS = { video: true, audio: true, systemAudio: 'include' } as const;

/** Port name for the side panel → offscreen audio link. */
export const APP_AUDIO_PORT = 'rekord:app-audio';

/** Meter level (0..1) below which the meeting counts as silent (matches SILENCE_RMS through toLevel). */
export const SILENT_LEVEL = 0.04;

/** How long the meeting may stay silent while the microphone hears speech before Rekord says so. */
export const SILENCE_MS = 10_000;

const APP_NAMES: Record<NonNullable<CalendarEvent['app']>, string> = { meet: 'Meet', zoom: 'Zoom', teams: 'Teams' };

/** The app named in copy: from the calendar event's conference link when known, else "the meeting app". */
export function appName(event?: Pick<CalendarEvent, 'app'> | null): string {
  return (event?.app && APP_NAMES[event.app]) || 'the meeting app';
}

/** The app as a short label ("Zoom"), or undefined when Rekord doesn't know it. */
export function appLabel(event?: Pick<CalendarEvent, 'app'> | null): string | undefined {
  return event?.app ? APP_NAMES[event.app] : undefined;
}

/** Live banner shown when sharing stops mid-meeting (V3States "Live · screen sharing stopped"). */
export function endedBanner(name: string): { title: string; body: string } {
  return { title: `Rekord can’t hear ${name} anymore`, body: 'Sharing was stopped. Your microphone is still recording.' };
}

/** Stops every video track at once and returns the audio-only stream, or null (all stopped) when no audio came. */
export function audioOnly(stream: MediaStream): MediaStream | null {
  for (const t of stream.getVideoTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  if (stream.getAudioTracks().length > 0) return stream;
  stream.getTracks().forEach((t) => t.stop());
  return null;
}

export type PickResult = { kind: 'audio'; stream: MediaStream } | { kind: 'no-audio' } | { kind: 'cancelled' } | { kind: 'error' };

type GetDisplayMedia = (options: typeof APP_DISPLAY_OPTIONS) => Promise<MediaStream>;

/** Opens Chrome's share picker (call it straight from a click). Never throws. */
export async function pickAppAudio(getDisplayMedia?: GetDisplayMedia): Promise<PickResult> {
  try {
    const gdm = getDisplayMedia ?? ((o) => navigator.mediaDevices.getDisplayMedia(o as DisplayMediaStreamOptions));
    const stream = audioOnly(await gdm(APP_DISPLAY_OPTIONS));
    return stream ? { kind: 'audio', stream } : { kind: 'no-audio' };
  } catch (error) {
    const name = error instanceof Error || (error && typeof error === 'object') ? (error as { name?: string }).name : undefined;
    return name === 'NotAllowedError' || name === 'AbortError' ? { kind: 'cancelled' } : { kind: 'error' };
  }
}

/**
 * Watches the meeting ("others") level against the microphone: fires once when the meeting has been silent for
 * SILENCE_MS while the microphone heard sound during that stretch. Sound from the meeting starts a new stretch.
 */
export class SilenceWatch {
  private silentSince: number | null = null;
  private micHeard = false;
  private fired = false;

  constructor(private readonly onSilent: () => void, private readonly now: () => number = Date.now, private readonly ms = SILENCE_MS) {}

  update(othersLevel: number, micLevel: number): void {
    const t = this.now();
    if (othersLevel >= SILENT_LEVEL) {
      this.reset();
      return;
    }
    if (this.silentSince === null) this.silentSince = t;
    if (micLevel >= SILENT_LEVEL) this.micHeard = true;
    if (!this.fired && this.micHeard && t - this.silentSince >= this.ms) {
      this.fired = true;
      this.onSilent();
    }
  }

  /** Starts over (e.g. after Share again). */
  reset(): void {
    this.silentSince = null;
    this.micHeard = false;
    this.fired = false;
  }
}

/* ---------- local WebRTC link ---------- */

type LinkMessage =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'reset' };

interface PortLike {
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
  disconnect(): void;
}

/** Resolves once ICE gathering is complete (host candidates only, so it's quick), or after `ms`. */
function gathered(pc: RTCPeerConnection, ms = 2000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, ms);
  });
}

/** Side panel end: one audio sender whose track can be swapped (or cleared) without renegotiating. */
export class AppAudioSender {
  private readonly pc: RTCPeerConnection;
  private readonly transceiver: RTCRtpTransceiver;
  private readonly port: PortLike;

  constructor(port: PortLike, pc: RTCPeerConnection = new RTCPeerConnection()) {
    this.port = port;
    this.pc = pc;
    this.transceiver = pc.addTransceiver('audio', { direction: 'sendonly' });
  }

  /** Offers the link and waits for the recorder's answer. */
  async open(track: MediaStreamTrack | null, timeoutMs = 10_000): Promise<void> {
    if (track) await this.transceiver.sender.replaceTrack(track);
    const answered = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Rekord’s recorder didn’t answer')), timeoutMs);
      this.port.onMessage.addListener((msg) => {
        const m = msg as LinkMessage;
        if (m?.kind === 'answer') {
          clearTimeout(timer);
          resolve(m.sdp);
        }
      });
      this.port.onDisconnect.addListener(() => reject(new Error('Rekord’s recorder closed')));
    });
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    this.port.postMessage({ kind: 'offer', sdp: this.pc.localDescription?.sdp ?? '' } satisfies LinkMessage);
    await this.pc.setRemoteDescription({ type: 'answer', sdp: await answered });
  }

  /** Sends a new shared track (or silence with null); the recorder's silence watch starts over. */
  async replace(track: MediaStreamTrack | null): Promise<void> {
    await this.transceiver.sender.replaceTrack(track);
    try { this.port.postMessage({ kind: 'reset' } satisfies LinkMessage); } catch { /* recorder gone */ }
  }

  close(): void {
    try { this.port.disconnect(); } catch { /* already closed */ }
    this.pc.close();
  }
}

/**
 * Offscreen end: answers the side panel's offer and hands over the received stream. `onReset` runs when the side
 * panel swaps the shared track. Returns a close function.
 */
export function receiveAppAudio(
  port: PortLike,
  handlers: { onStream: (stream: MediaStream) => void; onReset: () => void; onClose: () => void },
  pc: RTCPeerConnection = new RTCPeerConnection(),
): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    pc.close();
    handlers.onClose();
  };
  pc.addEventListener('track', (e) => handlers.onStream(e.streams[0] ?? new MediaStream([e.track])));
  port.onDisconnect.addListener(close);
  port.onMessage.addListener((msg) => {
    const m = msg as LinkMessage;
    if (m?.kind === 'reset') handlers.onReset();
    if (m?.kind !== 'offer') return;
    void (async () => {
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        port.postMessage({ kind: 'answer', sdp: pc.localDescription?.sdp ?? '' } satisfies LinkMessage);
      } catch (error) {
        console.error('Rekord: app audio link failed', error);
        close();
      }
    })();
  });
  return close;
}

/* ---------- side panel controller ---------- */

/**
 * 'off' no app capture; 'on' hearing the app; 'silent' nothing comes from the app (no audio shared, or 10 s of
 * silence while you talk); 'ended' sharing stopped mid-meeting; 'mic-only' the user chose to go on without it.
 */
export type AppAudioStatus = 'off' | 'on' | 'silent' | 'ended' | 'mic-only';

export interface AppAudioDeps {
  pick: () => Promise<PickResult>;
  connectPort: () => PortLike;
  createSender: (port: PortLike) => Pick<AppAudioSender, 'open' | 'replace' | 'close'>;
}

const defaultDeps: AppAudioDeps = {
  pick: () => pickAppAudio(),
  connectPort: () => browser.runtime.connect({ name: APP_AUDIO_PORT }) as unknown as PortLike,
  createSender: (port) => new AppAudioSender(port),
};

/** Holds the shared screen audio for the meeting in this side panel and reports its status to screens. */
export class AppAudioController {
  status: AppAudioStatus = 'off';
  private stream: MediaStream | null = null;
  private sender: Pick<AppAudioSender, 'open' | 'replace' | 'close'> | null = null;
  private readonly listeners = new Set<(s: AppAudioStatus) => void>();

  constructor(private readonly deps: AppAudioDeps = defaultDeps) {}

  subscribe(fn: (s: AppAudioStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: AppAudioStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.listeners.forEach((fn) => fn(next));
  }

  private hold(stream: MediaStream | null): MediaStreamTrack | null {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    const track = stream?.getAudioTracks()[0] ?? null;
    track?.addEventListener('ended', () => {
      if (this.stream !== stream || this.status === 'off') return;
      this.set('ended');
      void send({ type: 'app-audio/ended' });
    });
    return track;
  }

  /** Step 1 of Start recording (call from the click): opens Chrome's picker. 'no-audio' means start anyway. */
  async pick(): Promise<'audio' | 'no-audio' | 'cancelled' | 'error'> {
    const r = await this.deps.pick();
    if (r.kind === 'audio') this.hold(r.stream);
    return r.kind;
  }

  /** Step 2, once the recording started: links the audio to the recorder. */
  async connect(): Promise<void> {
    const track = this.stream?.getAudioTracks()[0] ?? null;
    this.set(track ? 'on' : 'silent');
    this.sender?.close();
    const sender = this.deps.createSender(this.deps.connectPort());
    this.sender = sender;
    try {
      await sender.open(track);
    } catch (error) {
      console.error('Rekord: could not link app audio', error);
      if (this.sender === sender) this.sender = null;
      this.set('silent'); // nothing reaches the recorder: offer Share again
      throw error;
    }
  }

  /** Repeats the picker and resumes the same meeting with the new audio. */
  async shareAgain(): Promise<'audio' | 'no-audio' | 'cancelled' | 'error'> {
    const r = await this.deps.pick();
    if (r.kind === 'cancelled' || r.kind === 'error') return r.kind;
    const track = this.hold(r.kind === 'audio' ? r.stream : null);
    if (this.sender) await this.sender.replace(track);
    else await this.connect().catch(() => undefined);
    this.set(track ? 'on' : 'silent');
    return r.kind;
  }

  /** "Keep going with just my microphone": stops sharing and stops asking. */
  async micOnly(): Promise<void> {
    this.hold(null);
    this.set('mic-only');
    await this.sender?.replace(null).catch(() => undefined);
  }

  /** The recorder reported 10 s of silence while you talk. */
  silent(): void {
    if (this.status === 'on') this.set('silent');
  }

  /** The meeting ended: stop sharing and close the link. */
  end(): void {
    this.hold(null);
    this.sender?.close();
    this.sender = null;
    this.set('off');
  }
}

let shared: AppAudioController | null = null;

/** The side panel's controller; listens for the recorder's silence report and the meeting's end. */
export function appAudio(): AppAudioController {
  if (shared) return shared;
  const c = new AppAudioController();
  shared = c;
  onMessage((msg) => {
    if (msg.type === 'app-audio/silent') c.silent();
    if (msg.type === 'recording/state' && msg.state.status === 'idle' && c.status !== 'off') c.end();
    return undefined;
  });
  return c;
}
