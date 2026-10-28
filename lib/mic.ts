export type MicState = 'granted' | 'denied' | 'prompt' | 'unknown';

/** Current microphone permission for this extension origin. */
export async function queryMic(): Promise<MicState> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/** Calls `cb` now and on every change. Returns an unsubscribe function. */
export function watchMic(cb: (state: MicState) => void): () => void {
  let off = () => {};
  let stopped = false;
  navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((status) => {
      if (stopped) return;
      const handler = () => cb(status.state);
      status.addEventListener('change', handler);
      off = () => status.removeEventListener('change', handler);
      handler();
    })
    .catch(() => {
      if (!stopped) cb('unknown');
    });
  return () => {
    stopped = true;
    off();
  };
}

/** Asks for the microphone, then releases it. Returns true when allowed. Run from an extension tab, not the side panel. */
export async function requestMic(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/** Opens the extension page that shows Chrome's microphone prompt. */
export function openPermissionTab(): Promise<unknown> {
  return browser.tabs.create({ url: (browser.runtime.getURL as (p: string) => string)('/permission.html') });
}
