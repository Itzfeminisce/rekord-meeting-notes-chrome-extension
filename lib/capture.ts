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
