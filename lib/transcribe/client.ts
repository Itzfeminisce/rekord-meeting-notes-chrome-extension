import { PROVIDERS } from '@/lib/settings';
import type { Chunk, Settings } from '@/lib/types';

export type TranscribeErrorKind = 'rate-limited' | 'auth' | 'offline' | 'server' | 'bad-request';

/** A failed transcription request. Messages never contain the API key or the response body. */
export class TranscribeError extends Error {
  constructor(
    readonly kind: TranscribeErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TranscribeError';
  }
}

const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Parses a `retry-after` header (seconds or HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : DEFAULT_RETRY_AFTER_MS;
}

function fileName(mimeType: string): string {
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a'
    : mimeType.includes('wav') ? 'wav' : mimeType.includes('mpeg') ? 'mp3' : 'webm';
  return `chunk.${ext}`;
}

/** Sends one chunk to `${baseUrl}/audio/transcriptions` (Groq or OpenAI) and returns its text. */
export async function transcribeChunk(
  chunk: Chunk,
  settings: Settings,
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (!chunk.audio) throw new TranscribeError('bad-request', 'Chunk has no audio');
  const { provider, model } = settings.transcription;
  const form = new FormData();
  form.append('file', chunk.audio, fileName(chunk.mimeType));
  form.append('model', model);
  form.append('response_format', 'json');
  if (settings.language !== 'auto') form.append('language', 'en');

  let res: Response;
  try {
    res = await fetchFn(`${PROVIDERS[provider].baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
  } catch {
    throw new TranscribeError('offline', 'Network request failed');
  }
  if (res.status === 429) {
    throw new TranscribeError('rate-limited', 'Rate limited', parseRetryAfter(res.headers.get('retry-after')));
  }
  if (res.status === 401 || res.status === 403) throw new TranscribeError('auth', `HTTP ${res.status}`);
  if (res.status >= 500) throw new TranscribeError('server', `HTTP ${res.status}`);
  if (!res.ok) throw new TranscribeError('bad-request', `HTTP ${res.status}`);
  let body: { text?: unknown };
  try {
    body = (await res.json()) as { text?: unknown };
  } catch {
    throw new TranscribeError('server', 'Invalid response');
  }
  return typeof body.text === 'string' ? body.text.trim() : '';
}
