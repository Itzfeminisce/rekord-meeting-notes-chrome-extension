import { getMeeting, putMeeting } from '@/lib/db';
import { onMessage, send } from '@/lib/messages';
import { getSettings } from '@/lib/settings';
import type { Meeting, RecordingState } from '@/lib/types';

/** Reply to `recording/start` and `recording/stop`. */
export type RecordingReply = { ok: true; meetingId?: string } | { ok: false; error: string };

const OFFSCREEN_PATH = '/offscreen.html';
const START_ERROR = "Rekord couldn't start recording. Click the Rekord icon on your meeting tab, then try again.";

let state: RecordingState = { status: 'idle' };
/** Meeting whose transcription must finish before the offscreen document may close. */
let closeAfterDrain: string | null = null;

function setState(next: RecordingState): void {
  state = next;
  void send({ type: 'recording/state', state });
}

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (and grants tab capture for that tab).
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Rekord: could not set side panel behaviour', error));

  onMessage((msg) => {
    switch (msg.type) {
      case 'recording/get-state':
        return state;
      case 'recording/start':
        return startRecording(msg.tabId);
      case 'recording/stop':
        return stopRecording();
      case 'offscreen/levels':
        if (state.status === 'recording') setState({ ...state, micLevel: msg.micLevel, tabLevel: msg.tabLevel });
        return undefined;
      case 'transcription/drained':
        if (msg.meetingId === closeAfterDrain && state.status === 'idle') {
          closeAfterDrain = null;
          void closeOffscreen();
        }
        return undefined;
      default:
        return undefined;
    }
  });
});

async function startRecording(tabId: number): Promise<RecordingReply> {
  if (state.status !== 'idle') return { ok: false, error: 'Rekord is already recording.' };
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

  try {
    await putMeeting(meeting);
    await ensureOffscreen();
    const reply = await send<RecordingReply>({ type: 'offscreen/start', streamId, meetingId, startedAt });
    if (!reply?.ok) throw new Error(reply?.error ?? START_ERROR);
  } catch (error) {
    console.error('Rekord: recording failed to start', error);
    await putMeeting({ ...meeting, status: 'error', endedAt: Date.now() }).catch(() => undefined);
    setState({ status: 'idle' });
    await closeOffscreen();
    return { ok: false, error: error instanceof Error && error.message ? error.message : START_ERROR };
  }

  setState({ status: 'recording', meetingId, startedAt, micLevel: 0, tabLevel: 0 });
  return { ok: true, meetingId };
}

async function stopRecording(): Promise<RecordingReply> {
  if (state.status !== 'recording') return { ok: true };
  const { meetingId } = state;
  setState({ ...state, status: 'stopping' });
  await send({ type: 'offscreen/stop' }); // resolves after the last chunks are saved
  const meeting = await getMeeting(meetingId);
  if (meeting) await putMeeting({ ...meeting, status: 'processing', endedAt: Date.now() });
  closeAfterDrain = meetingId;
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

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await browser.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'] as Browser.offscreen.Reason[],
    justification: 'Record meeting tab and microphone audio, and keep the meeting audible.',
  });
}

async function closeOffscreen(): Promise<void> {
  try {
    if (await hasOffscreen()) await browser.offscreen.closeDocument();
  } catch (error) {
    console.error('Rekord: could not close recorder', error);
  }
}
