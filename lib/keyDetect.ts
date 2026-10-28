/** Recognises a pasted key by its prefix. Never logs or returns the value itself. */

export type KeyName =
  | 'GROQ_API_KEY'
  | 'OPENAI_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'DEEPGRAM_API_KEY'
  | 'NOTION_TOKEN';

export type KeyJob = 'transcription' | 'assistant';

/** The key name for a pasted value, or null when Rekord doesn't recognise it. Longer prefixes win over `sk-`. */
export function detectKey(value: string): KeyName | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('gsk_')) return 'GROQ_API_KEY';
  if (v.startsWith('sk-ant-')) return 'ANTHROPIC_API_KEY';
  if (v.startsWith('sk-or-')) return 'OPENROUTER_API_KEY';
  if (v.startsWith('sk-')) return 'OPENAI_API_KEY';
  if (v.startsWith('ntn_') || v.startsWith('secret_')) return 'NOTION_TOKEN';
  if (/^[0-9a-f]{40}$/i.test(v)) return 'DEEPGRAM_API_KEY';
  return null;
}

/** What a key can do in Rekord: transcribe audio, power the assistant (summary, ask), both, or neither. */
export function jobsFor(name: KeyName): KeyJob[] {
  switch (name) {
    case 'GROQ_API_KEY':
    case 'OPENAI_API_KEY':
      return ['transcription', 'assistant'];
    case 'DEEPGRAM_API_KEY':
      return ['transcription'];
    case 'ANTHROPIC_API_KEY':
    case 'OPENROUTER_API_KEY':
      return ['assistant'];
    case 'NOTION_TOKEN':
      return [];
  }
}

const LABELS: Record<KeyName, string> = {
  GROQ_API_KEY: 'Groq',
  OPENAI_API_KEY: 'OpenAI',
  DEEPGRAM_API_KEY: 'Deepgram',
  ANTHROPIC_API_KEY: 'Anthropic',
  OPENROUTER_API_KEY: 'OpenRouter',
  NOTION_TOKEN: 'Notion',
};

/** The service's display name for a key name ("Groq"); unknown names come back unchanged. */
export function serviceLabel(name: string): string {
  return LABELS[name as KeyName] ?? name;
}
