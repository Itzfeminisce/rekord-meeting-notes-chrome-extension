import type { Message } from './types';

export type MessageType = Message['type'];
export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;

/**
 * Sends a runtime message. Resolves with the listener's response, or undefined when nothing is listening
 * (never throws for "Receiving end does not exist").
 */
export async function send<R = unknown>(msg: Message): Promise<R | undefined> {
  try {
    return (await browser.runtime.sendMessage(msg)) as R | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Listens for runtime messages. Return a value (or a promise) from the handler to reply; return undefined to ignore.
 * Returns an unsubscribe function.
 */
export function onMessage(
  handler: (msg: Message, sender: Browser.runtime.MessageSender) => unknown,
): () => void {
  // Uses sendResponse + `return true` (works on every Chrome version) rather than returning a promise.
  const listener = (msg: unknown, sender: Browser.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return false;
    const result = handler(msg as Message, sender);
    if (result === undefined) return false;
    Promise.resolve(result).then(sendResponse, () => sendResponse(undefined));
    return true;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
