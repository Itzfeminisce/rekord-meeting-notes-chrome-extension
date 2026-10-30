/**
 * Shared chat client for the summary provider (OpenAI-compatible `/chat/completions`).
 * Never logs or returns a key. Errors are LLMError with a user-facing message and a `code`.
 */
import { listGroqModels, pickGroqChatModel } from './groqModels';
import { loadKeys } from './keys';
import { getSettings, PROVIDERS, updateSettings } from './settings';
import { formatClock } from './time';
import type { Meeting, Segment, Settings } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatOptions {
  json?: boolean;        // ask for a JSON object reply (response_format json_object)
  maxTokens?: number;
  temperature?: number;  // default 0.2
  signal?: AbortSignal;
  /** Settings and keys to use instead of storage (e.g. from `transcriber/config` in the offscreen document). */
  config?: { settings: Settings; keys: Record<string, string> };
}

export type LLMErrorCode = 'no-key' | 'offline' | 'auth' | 'rate-limited' | 'server' | 'bad-reply';

export class LLMError extends Error {
  constructor(message: string, readonly code: LLMErrorCode) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Sends `messages` to the summary provider/model and returns the reply text. Throws LLMError. */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<string> {
  const [settings, keys] = opts.config
    ? [opts.config.settings, opts.config.keys]
    : await Promise.all([getSettings(), loadKeys()]);
  const { provider, model } = settings.summary;
  const cfg = PROVIDERS[provider];
  const baseUrl = (settings.summary.baseUrl || cfg.baseUrl).replace(/\/+$/, '');
  const key = cfg.keyName ? keys[cfg.keyName] : undefined;
  if (cfg.keyName && !key) throw new LLMError('Rekord needs an AI connection for this. Check Connect AI in Settings.', 'no-key');

  const post = (model: string) => fetchFn(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: opts.temperature ?? 0.2,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      messages,
    }),
    signal: opts.signal,
  });

  let res: Response;
  try {
    res = await post(model);
    // Groq retires models: pick a listed one, remember it, and retry once.
    if (res.status === 404 && provider === 'groq' && key && (await isModelNotFound(res))) {
      const healed = await healGroqModel(baseUrl, key, model, !opts.config, fetchFn);
      if (healed) res = await post(healed);
    }
  } catch {
    throw new LLMError('Rekord could not reach the AI service. Check your connection and try again.', 'offline');
  }
  if (res.status === 401 || res.status === 403) throw new LLMError('The AI service did not accept your key. Check Connect AI in Settings.', 'auth');
  if (res.status === 429) throw new LLMError('The AI service is busy right now. Try again in a minute.', 'rate-limited');
  if (!res.ok) throw new LLMError(`The AI service returned an error (${res.status}). Try again.`, 'server');
  let content: unknown;
  try { content = ((await res.json()) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content; } catch { /* handled below */ }
  if (typeof content !== 'string') throw new LLMError('The AI service sent an unexpected reply. Try again.', 'bad-reply');
  return content;
}

async function isModelNotFound(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } };
    return body.error?.code === 'model_not_found';
  } catch {
    return false;
  }
}

/** A model Groq lists in place of `failed`, saved over it when the saved model is still `failed`. Undefined if none. */
async function healGroqModel(baseUrl: string, key: string, failed: string, save: boolean, fetchFn: FetchLike): Promise<string | undefined> {
  let picked: string | undefined;
  try { picked = pickGroqChatModel(await listGroqModels(baseUrl, key, fetchFn)); } catch { return undefined; }
  if (!picked || picked === failed) return undefined;
  if (save) {
    try {
      const current = await getSettings();
      if (current.summary.provider === 'groq' && current.summary.model === failed) {
        await updateSettings({ summary: { ...current.summary, model: picked } });
      }
    } catch { /* the retry still uses `picked` */ }
  }
  return picked;
}

/** What a speaker shows as: "You", their saved name, else "Speaker A" for a diarized label, else "Others". */
export function displayName(s: Pick<Segment, 'speaker' | 'speakerLabel'>, speakers?: Meeting['speakers']): string {
  if (s.speaker === 'you') return 'You';
  if (!s.speakerLabel) return 'Others';
  return speakers?.[s.speakerLabel]?.name?.trim() || `Speaker ${s.speakerLabel}`;
}

/** Display name for a segment (same as `displayName`). */
export const speakerName = displayName;

/** Transcript as "[mm:ss] Name: text" lines (empty segments skipped). */
export function transcriptLines(segments: Segment[], speakers?: Meeting['speakers']): string[] {
  return segments
    .filter((s) => s.text.trim())
    .map((s) => `[${formatClock(s.startMs)}] ${speakerName(s, speakers)}: ${s.text.trim()}`);
}
