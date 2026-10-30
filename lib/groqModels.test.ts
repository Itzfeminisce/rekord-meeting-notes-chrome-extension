import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GROQ_CHAT_PREFERENCE, listGroqModels, pickGroqChatModel, resetGroqModelsCache } from './groqModels';
import { DEFAULT_SETTINGS } from './settings';

beforeEach(() => resetGroqModelsCache());

describe('pickGroqChatModel', () => {
  it('takes the first preferred model Groq lists', () => {
    expect(pickGroqChatModel(['llama-3.1-8b-instant', 'qwen/qwen3-32b', 'whisper-large-v3'])).toBe('qwen/qwen3-32b');
    expect(pickGroqChatModel(['openai/gpt-oss-20b', 'openai/gpt-oss-120b'])).toBe('openai/gpt-oss-120b');
  });

  it('else takes the first listed chat model, skipping audio, guard and compound models', () => {
    const ids = ['whisper-large-v3-turbo', 'playai-tts', 'meta-llama/llama-prompt-guard-2-86m', 'groq/compound', 'distil-whisper-large-v3-en', 'new/chat-model'];
    expect(pickGroqChatModel(ids)).toBe('new/chat-model');
    expect(pickGroqChatModel(ids.slice(0, 5))).toBeUndefined();
    expect(pickGroqChatModel([])).toBeUndefined();
  });

  it('the default Groq summary model is the first preference', () => {
    expect(DEFAULT_SETTINGS.summary).toEqual({ provider: 'groq', model: GROQ_CHAT_PREFERENCE[0] });
  });
});

describe('listGroqModels', () => {
  it('lists active ids once per session and does not cache a failure', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b', active: false }, { id: 'c', active: true }] })));
    await expect(listGroqModels('https://g/v1', 'gsk_test', f)).rejects.toThrow();
    expect(await listGroqModels('https://g/v1', 'gsk_test', f)).toEqual(['a', 'c']);
    expect(await listGroqModels('https://g/v1', 'gsk_test', f)).toEqual(['a', 'c']);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenLastCalledWith('https://g/v1/models', { headers: { Authorization: 'Bearer gsk_test' } });
  });
});
