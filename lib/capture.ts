/** Shown when Chrome has not granted Rekord the meeting tab (the icon wasn't clicked on it). */
export const TAB_GRANT_HINT = 'Click the Rekord icon in the toolbar while you’re on the meeting tab, then press Start.';

/**
 * `tabs.get` only returns a tab's url once the user has invoked Rekord on that tab (activeTab grant),
 * so a missing url while "Others · This tab" is ticked means tab capture would be refused.
 */
export function needsTabGrant({ tabOn, tabUrl }: { tabOn: boolean; tabUrl?: string | null }): boolean {
  return tabOn && !tabUrl;
}

/** Reply the background sends when `tabCapture.getMediaStreamId` is refused. */
export function tabRefusedReply(): { ok: false; error: string } {
  return { ok: false, error: TAB_GRANT_HINT };
}

/** v3 "Where is the meeting?": in a Chrome tab (tab capture) or in a desktop app (system audio). */
export type MeetingPlace = 'tab' | 'app';

/** `recording/start` and `offscreen/start` carry `app: true` for desktop-app capture (no tab capture then). */
export interface AppFlag { app?: boolean }

/**
 * What to record for a place. In a tab, the tab is always the meeting ("others"). In an app, the shared screen audio
 * is the meeting and no tab is captured; with no audio shared, the microphone stays on so the meeting isn't empty.
 */
export function captureSources(place: MeetingPlace, mic: boolean, appHasAudio = true): { sources: { mic: boolean; tab: boolean }; app: boolean } {
  if (place === 'tab') return { sources: { mic, tab: true }, app: false };
  return { sources: { mic: mic || !appHasAudio, tab: false }, app: true };
}

/** Normalises the sources of an app start: no tab, mic as asked (on when missing). Null when not an app start. */
export function appSources(msg: { sources?: { mic?: boolean }; app?: boolean }): { mic: boolean; tab: false } | null {
  return msg.app ? { mic: msg.sources?.mic ?? true, tab: false } : null;
}
