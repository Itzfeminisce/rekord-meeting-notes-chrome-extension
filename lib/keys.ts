/**
 * API keys are held in memory only: `chrome.storage.session` is cleared when the browser closes
 * and is never written to disk.
 */

const STORAGE_KEY = 'apiKeys';

export async function saveKeys(keys: Record<string, string>): Promise<void> {
  await browser.storage.session.set({ [STORAGE_KEY]: keys });
}

export async function loadKeys(): Promise<Record<string, string>> {
  const stored = await browser.storage.session.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as Record<string, string> | undefined) ?? {};
}

export async function clearKeys(): Promise<void> {
  await browser.storage.session.remove(STORAGE_KEY);
}
