import { useEffect, useState } from 'react';
import { onMessage } from './messages';
import { formatClock } from './time';
import type { ConnectionState } from './types';

export const CHUNK_MS = 10_000;
/** `message` value that tells the router's error screen to show the connection-lost frame. */
export const CONNECTION_LOST = 'connection-lost';

export type LostState = Extract<ConnectionState, { ok: false }>;

export interface ConnectionCopy {
  title: string;
  body: string;
  /** Where the secondary action leads. */
  action: { label: string; to: 'settings' };
}

/** Tracks `connection/state` messages. Starts as ok: the panel may open after the last message was sent. */
export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ ok: true });
  useEffect(
    () => onMessage((msg) => {
      if (msg.type === 'connection/state') setState(msg.state);
    }),
    [],
  );
  return state;
}

export function providerName(provider: string | undefined): string {
  return provider === 'openai' ? 'OpenAI' : 'Groq';
}

export function pendingLabel(pendingChunks: number): string {
  return formatClock(Math.max(0, pendingChunks) * CHUNK_MS);
}

export function retryIn(retryAt: number | undefined, now: number): string | null {
  return retryAt === undefined ? null : formatClock(Math.max(0, retryAt - now));
}

export function connectionCopy(state: LostState, provider: string | undefined, now: number): ConnectionCopy {
  const name = providerName(provider);
  const catchUp = `Rekord is still recording and will catch up the last ${pendingLabel(state.pendingChunks)}`;
  const title = 'Transcription paused';
  const switchProvider = { label: 'Switch provider', to: 'settings' } as const;
  switch (state.reason) {
    case 'offline':
      return { title, body: `You’re offline. ${catchUp} as soon as you’re back.`, action: switchProvider };
    case 'rate-limited': {
      const wait = retryIn(state.retryAt, now);
      return { title, body: `${name} is busy. ${catchUp}${wait ? `, trying again in ${wait}` : ' soon'}.`, action: switchProvider };
    }
    case 'auth':
      return { title, body: `${name} didn’t accept your key. ${catchUp} once it’s fixed in Settings.`, action: { label: 'Open Settings', to: 'settings' } };
    default:
      return { title, body: `${name} isn’t responding. ${catchUp} as soon as it’s back.`, action: switchProvider };
  }
}
