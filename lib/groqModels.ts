/** Picks a Groq chat model from the ids Groq's `/models` lists, so a retired default heals itself. */
import type { FetchLike } from './llm';

/** Best first. The first entry is Rekord's default Groq summary model. */
export const GROQ_CHAT_PREFERENCE = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
];

const NOT_CHAT = /whisper|tts|guard|playai|compound|distil/i;

/** The first preferred id that Groq lists, else the first listed id that is a chat model, else undefined. */
export function pickGroqChatModel(ids: string[]): string | undefined {
  return GROQ_CHAT_PREFERENCE.find((m) => ids.includes(m)) ?? ids.find((id) => !NOT_CHAT.test(id));
}

let cached: Promise<string[]> | undefined;

/** Active model ids from Groq's `/models`, fetched once per session. A failed fetch is not cached. */
export function listGroqModels(baseUrl: string, key: string, fetchFn: FetchLike): Promise<string[]> {
  cached ??= (async () => {
    const res = await fetchFn(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown; active?: boolean }[] };
    return (body.data ?? []).filter((m) => typeof m.id === 'string' && m.active !== false).map((m) => m.id as string);
  })().catch((e: unknown) => { cached = undefined; throw e; });
  return cached;
}

/** Test seam: forgets the session cache. */
export function resetGroqModelsCache(): void {
  cached = undefined;
}
