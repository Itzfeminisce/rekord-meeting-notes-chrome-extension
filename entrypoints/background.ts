import { getMeeting, putMeeting } from '@/lib/db';
import { onMessage, send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';
import type { Meeting, RecordingState } from '@/lib/types';
import type { OffscreenReply } from './offscreen/main';

/** Reply to `recording/start` and `recording/stop`. */
export type RecordingReply = { ok: true; meetingId?: string } | { ok: false; error: string };

const OFFSCREEN_PATH = '/offscreen.html';
const START_ERROR = "Rekord couldn't start recording. Click the Rekord icon on your meeting tab, then try again.";

const STORE_KEY = 'rekord:recorder'; // storage.session survives service-worker restarts
type Persisted = { state: RecordingState; closeAfterDrain: string | null };

let state: RecordingState = { status: 'idle' };
/** Meeting whose transcription must finish before the offscreen document may close. */
let closeAfterDrain: string | null = null;
/** The in-flight start, so a Stop sent while starting takes effect once it finishes. */
let starting: Promise<RecordingReply> | null = null;

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

  onMessage((msg) => {
    switch (msg.type) {
      case 'recording/get-state':
        return ready.then(() => state);
      case 'recording/start':
        return ready.then(() => {
          if (state.status !== 'idle') return { ok: false, error: 'Rekord is already recording.' } as RecordingReply;
          const run = startRecording(msg.tabId);
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
      case 'transcription/drained':
        void ready.then(async () => {
          // Close whenever nothing is recording, unless another meeting's drain is still pending.
          if (state.status !== 'idle') return;
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

async function startRecording(tabId: number): Promise<RecordingReply> {
  const startedAt = Date.now();
  const meetingId = crypto.randomUUID();
  setState({ status: 'starting', meetingId, startedAt, micLevel: 0, tabLevel: 0 });

  let streamId: string;
  try {
    streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    console.error('Rekord: tab capture refused', error);
    setState({ status: 'idle' });
    return { ok: false, error: START_ERROR };
  }

  const [tab, settings] = await Promise.all([
    browser.tabs.get(tabId).catch(() => undefined),
    getSettings(),
  ]);
  const meeting: Meeting = {
    id: meetingId,
    title: tab?.title?.trim() || 'Untitled meeting',
    tabUrl: tab?.url,
    startedAt,
    status: 'recording',
    language: settings.language,
  };

  let created = false;
  let micUnavailable = false;
  try {
    await putMeeting(meeting);
    created = await ensureOffscreen();
    const reply = await send<OffscreenReply>({ type: 'offscreen/start', streamId, meetingId, startedAt });
    if (!reply?.ok) throw new Error(reply?.error ?? START_ERROR);
    micUnavailable = reply.micUnavailable === true;
  } catch (error) {
    console.error('Rekord: recording failed to start', error);
    await putMeeting({ ...meeting, status: 'error', endedAt: Date.now() }).catch(() => undefined);
    setState({ status: 'idle' });
    // Never close a document another meeting is still transcribing in.
    if (created && !closeAfterDrain) await closeOffscreen();
    return { ok: false, error: error instanceof Error && error.message ? error.message : START_ERROR };
  }

  setState({ status: 'recording', meetingId, startedAt, micLevel: 0, tabLevel: 0, ...(micUnavailable && { micUnavailable }) });
  return { ok: true, meetingId };
}

async function stopRecording(): Promise<RecordingReply> {
  if (state.status === 'starting' && starting) await starting; // stop as soon as start reaches 'recording' (or aborts)
  if (state.status !== 'recording') return { ok: true };
  const { meetingId } = state;
  setState({ ...state, status: 'stopping' });
  await send({ type: 'offscreen/stop' }); // resolves after the last chunks are saved
  const meeting = await getMeeting(meetingId);
  if (meeting) await putMeeting({ ...meeting, status: 'processing', endedAt: Date.now() });
  setCloseAfterDrain(meetingId);
  setState({ status: 'idle' });
  return { ok: true, meetingId };
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

/** Resolves true when this call created the document. */
async function ensureOffscreen(): Promise<boolean> {
  if (await hasOffscreen()) return false;
  await browser.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'] as Browser.offscreen.Reason[],
    justification: 'Record meeting tab and microphone audio, and keep the meeting audible.',
  });
  return true;
}

async function closeOffscreen(): Promise<void> {
  try {
    if (await hasOffscreen()) await browser.offscreen.closeDocument();
  } catch (error) {
    console.error('Rekord: could not close recorder', error);
  }
}
