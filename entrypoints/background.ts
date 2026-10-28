import { resolveSources, type Sources } from '@/lib/sources';
import { getMeeting, pendingChunks, putMeeting } from '@/lib/db';
import { loadKeys } from '@/lib/keys';
import { onMessage, send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';
import type { Meeting, RecordingState, TranscriberConfig } from '@/lib/types';
import type { OffscreenReply } from './offscreen/main';

/** Reply to `recording/start` and `recording/stop`. */
export type RecordingReply = { ok: true; meetingId?: string } | { ok: false; error: string };

const OFFSCREEN_PATH = '/offscreen.html';
const START_ERROR = "Rekord couldn’t start recording. Click the Rekord icon on your meeting tab, then try again.";

const STORE_KEY = 'rekord:recorder'; // storage.session survives service-worker restarts
type Persisted = { state: RecordingState; closeAfterDrain: string | null };

let state: RecordingState = { status: 'idle' };
/** Meeting whose transcription must finish before the offscreen document may close. */
let closeAfterDrain: string | null = null;
/** The in-flight start, so a Stop sent while starting takes effect once it finishes. */
let starting: Promise<RecordingReply> | null = null;
/** A meeting whose drain arrived while it was still stopping, before closeAfterDrain was set. */
let drainedWhileStopping: string | null = null;
/** Tail of the queue that runs offscreen create/close decisions one at a time; never rejects. */
let offscreenQueue: Promise<unknown> = Promise.resolve();

const ready = rehydrate();

async function rehydrate(): Promise<void> {
  try {
    const saved = (await browser.storage.session.get(STORE_KEY))[STORE_KEY] as Persisted | undefined;
    if (!saved) return;
    closeAfterDrain = saved.closeAfterDrain;
    // A start or stop cut short by the restart: 'starting' never reached the recorder; 'stopping' can be stopped again.
    if (saved.state.status === 'starting') state = { status: 'idle' };
    else if (saved.state.status === 'stopping') state = { ...saved.state, status: 'recording' };
    else state = saved.state;
  } catch (error) {
    console.error('Rekord: could not restore recording state', error);
  }
}

function persist(): void {
  const value: Persisted = { state, closeAfterDrain };
  browser.storage.session.set({ [STORE_KEY]: value }).catch((error) => console.error('Rekord: could not save recording state', error));
}

function setState(next: RecordingState): void {
  const statusChanged = next.status !== state.status;
  state = next;
  if (statusChanged) persist(); // level updates (~4/s) need not be stored
  void send({ type: 'recording/state', state });
}

function setCloseAfterDrain(meetingId: string | null): void {
  closeAfterDrain = meetingId;
  persist();
}

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (and grants tab capture for that tab).
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Rekord: could not set side panel behaviour', error));

  // After a browser restart, finish transcribing chunks left pending by an earlier meeting.
  browser.runtime.onStartup.addListener(() => void openForCatchUp());

  onMessage((msg) => {
    switch (msg.type) {
      case 'recording/get-state':
        return ready.then(() => state);
      case 'recording/start':
        return ready.then(() => {
          if (state.status !== 'idle') return { ok: false, error: 'Rekord is already recording.' } as RecordingReply;
          const run = startRecording(msg.tabId, resolveSources(msg.sources));
          starting = run.finally(() => (starting = null));
          return run;
        });
      case 'recording/stop':
        return ready.then(stopRecording);
      case 'offscreen/levels':
        void ready.then(() => {
          if (state.status === 'recording') setState({ ...state, micLevel: msg.micLevel, tabLevel: msg.tabLevel });
        });
        return undefined;
      case 'transcriber/config':
        // The offscreen transcriber has no storage API; only the background answers this.
        return Promise.all([getSettings(), loadKeys()]).then(([settings, keys]): TranscriberConfig => ({ settings, keys }));
      case 'transcription/catch-up':
        // The offscreen transcriber handles it when open; otherwise open it so it resumes pending chunks.
        void openForCatchUp();
        return undefined;
      case 'transcription/drained':
        void ready.then(async () => {
          if (state.status !== 'idle') {
            // Record the drain so the doc can close once the current start/stop settles.
            if (msg.meetingId === closeAfterDrain) setCloseAfterDrain(null);
            else if (state.status === 'stopping' && state.meetingId === msg.meetingId) drainedWhileStopping = msg.meetingId;
            return;
          }
          // Close whenever nothing is recording, unless another meeting's drain is still pending.
          if (closeAfterDrain && closeAfterDrain !== msg.meetingId) return;
          setCloseAfterDrain(null);
          await closeOffscreen();
        });
        return undefined;
      default:
        return undefined;
    }
  });
});

async function startRecording(tabId: number, sources: Sources): Promise<RecordingReply> {
  const startedAt = Date.now();
  const meetingId = crypto.randomUUID();
  setState({ status: 'starting', meetingId, startedAt, micLevel: 0, tabLevel: 0 });

  let streamId = '';
  try {
    if (sources.tab) streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    console.error('Rekord: tab capture refused', error);
    setState({ status: 'idle' });
    return { ok: false, error: START_ERROR };
  }

  let meeting: Meeting | undefined;
  let micUnavailable = false;
  try {
    const [tab, settings] = await Promise.all([
      browser.tabs.get(tabId).catch(() => undefined),
      getSettings(),
    ]);
    meeting = {
      id: meetingId,
      title: tab?.title?.trim() || 'Untitled meeting',
      tabUrl: tab?.url,
      startedAt,
      status: 'recording',
      language: settings.language,
    };
    await putMeeting(meeting);
    await ensureOffscreen();
    const reply = await send<OffscreenReply>({ type: 'offscreen/start', streamId, meetingId, startedAt, sources });
    if (!reply?.ok) throw new Error(reply?.error ?? START_ERROR);
    micUnavailable = reply.micUnavailable === true;
  } catch (error) {
    console.error('Rekord: recording failed to start', error);
    if (meeting) await putMeeting({ ...meeting, status: 'error', endedAt: Date.now() }).catch(() => undefined);
    setState({ status: 'idle' });
    // Never close a document still transcribing pending chunks; it closes itself once drained.
    await closeOffscreen(true);
    return { ok: false, error: error instanceof Error && error.message ? error.message : START_ERROR };
  }

  setState({ status: 'recording', meetingId, startedAt, micLevel: 0, tabLevel: 0, sources, ...(micUnavailable && { micUnavailable }) });
  return { ok: true, meetingId };
}

async function stopRecording(): Promise<RecordingReply> {
  if (state.status === 'starting' && starting) await starting.catch(() => undefined); // stop as soon as start reaches 'recording' (or aborts)
  if (state.status !== 'recording') return { ok: true };
  const { meetingId } = state;
  setState({ ...state, status: 'stopping' });
  // Resolves after the last chunks (and the final continuous-recording part) are saved.
  const stopped = await send<OffscreenReply>({ type: 'offscreen/stop' });
  const meeting = await getMeeting(meetingId);
  // v2: a saved tab recording means speaker names can run after the meeting.
  const speakerStep = stopped?.ok && stopped.recorded ? ({ speakerStep: 'pending' } as const) : {};
  if (meeting) await putMeeting({ ...meeting, status: 'processing', endedAt: Date.now(), ...speakerStep });
  if (drainedWhileStopping === meetingId) {
    drainedWhileStopping = null; // already drained: nothing left to wait for
  } else {
    setCloseAfterDrain(meetingId);
  }
  setState({ status: 'idle' });
  await closeOffscreen();
  return { ok: true, meetingId };
}

/**
 * Opens the offscreen document when chunks are pending and none is open; its transcriber resumes them on load
 * and reports `transcription/drained` ('*') once empty, which closes it again while idle.
 */
async function openForCatchUp(): Promise<void> {
  try {
    await ready;
    if (state.status !== 'idle') return; // the recording's document handles it
    if ((await pendingChunks()).length === 0) return;
    await ensureOffscreen(() => state.status === 'idle'); // a start that began meanwhile opens its own
  } catch (error) {
    console.error('Rekord: could not resume transcription', error);
  }
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

/** Runs one offscreen create/close decision after the previous one settles, so each sees the document's real state. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = offscreenQueue.then(task);
  offscreenQueue = run.catch(() => undefined);
  return run;
}

/** Creates the document unless one is open or `stillWanted()` turns false by the time this call's turn comes. */
function ensureOffscreen(stillWanted: () => boolean = () => true): Promise<void> {
  return serialized(async () => {
    if (!stillWanted() || (await hasOffscreen())) return;
    await browser.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'] as Browser.offscreen.Reason[],
      justification: 'Record meeting tab and microphone audio, and keep the meeting audible.',
    });
  });
}

/**
 * Closes the document if, at the moment of closing, nothing is recording or starting and no meeting still awaits
 * its drain. With `onlyIfNothingPending`, also keeps it open while any chunk awaits transcription.
 */
async function closeOffscreen(onlyIfNothingPending = false): Promise<void> {
  try {
    await serialized(async () => {
      if (onlyIfNothingPending && (await pendingChunks()).length > 0) return;
      if (!(await hasOffscreen())) return;
      // Re-checked after the last await, so a start or stop that began meanwhile keeps its document.
      if (state.status !== 'idle' || closeAfterDrain) return;
      await browser.offscreen.closeDocument();
    });
  } catch (error) {
    console.error('Rekord: could not close recorder', error);
  }
}
