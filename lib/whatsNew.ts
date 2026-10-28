import { getSettings, updateSettings } from './settings';

const PENDING_KEY = 'whatsNewPending';

/** Compares dotted version strings numerically: -1, 0 or 1. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `current` is newer than the version the user last saw (or they have seen none). */
export function isNewerThanSeen(current: string, lastSeen: string | undefined): boolean {
  return !lastSeen || compareVersions(current, lastSeen) > 0;
}

/**
 * Handles chrome.runtime.onInstalled. An update to a newer version marks What's new as waiting for the next
 * panel open; a fresh install records the version as seen so only later updates show it.
 */
export async function handleInstalled(reason: string, current: string): Promise<void> {
  const settings = await getSettings();
  if (reason === 'install') {
    await updateSettings({ lastSeenVersion: current });
  } else if (reason === 'update' && isNewerThanSeen(current, settings.lastSeenVersion)) {
    await browser.storage.local.set({ [PENDING_KEY]: true });
  }
}

/** Whether What's new should open now: waiting, finished onboarding, and still newer than the last seen version. */
export async function shouldShowWhatsNew(current: string): Promise<boolean> {
  const stored = await browser.storage.local.get(PENDING_KEY);
  if (!stored[PENDING_KEY]) return false;
  const settings = await getSettings();
  return settings.onboarded && isNewerThanSeen(current, settings.lastSeenVersion);
}

/** Marks the current version as seen so What's new does not show again. */
export async function markWhatsNewSeen(current: string): Promise<void> {
  await updateSettings({ lastSeenVersion: current });
  await browser.storage.local.remove(PENDING_KEY);
}
