import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDB, getMeeting, putMeeting, putSegment } from './db';
import { saveKeys } from './keys';
import { updateSettings } from './settings';
import { buildPrompt, parseSummary, summarize, truncateMiddle } from './summarize';

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

beforeEach(async () => {
  fakeBrowser.reset();
  await closeDB();
  globalThis.indexedDB = new IDBFactory();
  await putMeeting({ id: 'm', title: 'Sync', startedAt: 0, status: 'processing', language: 'en' });
  await putSegment({ id: 's', meetingId: 'm', speaker: 'you', startMs: 65000, endMs: 70000, text: 'hello', chunkId: 'c' });
  await saveKeys({ GROQ_API_KEY: 'gsk_test' });
});

describe('parseSummary', () => {
  it('strips code fences and normalises actions', () => {
    const s = parseSummary('```json\n{"overview":"o","decisions":["d"],"actions":[{"text":"a","owner":"You"},"b"],"questions":[]}\n```');
    expect(s).toEqual({ overview: 'o', decisions: ['d'], actions: [{ text: 'a', owner: 'You' }, { text: 'b' }], questions: [] });
  });
  it('rejects garbage and empty', () => {
    expect(() => parseSummary('nope')).toThrow();
    expect(() => parseSummary('{}')).toThrow();
  });
  it('accepts a summary where only some fields are empty', () => {
    expect(parseSummary('{"overview":"","decisions":[],"actions":[],"questions":["q"]}').questions).toEqual(['q']);
  });
});

describe('prompt', () => {
  it('formats lines and truncates the middle', () => {
    expect(buildPrompt('T', [{ id: 's', meetingId: 'm', speaker: 'others', startMs: 65000, endMs: 1, text: 'hi', chunkId: 'c' }], [], [])).toContain('[1:05] Others: hi');
    const named = { id: 's', meetingId: 'm', speaker: 'others' as const, speakerLabel: 'A', startMs: 65000, endMs: 1, text: 'hi', chunkId: 'c' };
    expect(buildPrompt('T', [named], [], [], { A: { name: 'Dana' } })).toContain('[1:05] Dana: hi');
    expect(buildPrompt('T', [named], [], [])).toContain('[1:05] Speaker A: hi');
    const t = truncateMiddle('a'.repeat(100) + 'b'.repeat(100), 100);
    expect(t.startsWith('a')).toBe(true);
    expect(t.endsWith('b')).toBe(true);
    expect(t).toContain('omitted');
  });
});

describe('summarize', () => {
  it('saves the summary and marks done', async () => {
    const f = vi.fn(async () => reply('{"overview":"o","decisions":[],"actions":[],"questions":["q"]}'));
    await summarize('m', f);
    const m = await getMeeting('m');
    expect(m?.status).toBe('done');
    expect(m?.summary?.questions).toEqual(['q']);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');
  });
  it('skips the LLM when there is nothing to summarize', async () => {
    await closeDB();
    globalThis.indexedDB = new IDBFactory();
    await putMeeting({ id: 'e', title: 'Empty', startedAt: 0, status: 'processing', language: 'en' });
    const f = vi.fn();
    await summarize('e', f);
    expect(f).not.toHaveBeenCalled();
    const m = await getMeeting('e');
    expect(m?.status).toBe('done');
    expect(m?.summary).toMatchObject({ overview: '', decisions: [], actions: [], questions: [] });
  });
  it('still marks done and throws on failure', async () => {
    await expect(summarize('m', async () => reply('x', 500))).rejects.toThrow(/error/);
    expect((await getMeeting('m'))?.status).toBe('done');
    expect((await getMeeting('m'))?.summary).toBeUndefined();
  });
  it('reports missing key and offline without calling', async () => {
    await saveKeys({});
    const f = vi.fn();
    await expect(summarize('m', f)).rejects.toThrow(/Connect AI/);
    expect(f).not.toHaveBeenCalled();
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    await expect(summarize('m', async () => { throw new TypeError('x'); })).rejects.toThrow(/reach/);
  });
  it('uses ollama without a key and a custom baseUrl', async () => {
    await updateSettings({ summary: { provider: 'ollama', model: 'llama3', baseUrl: 'http://h:1/v1/' } });
    await saveKeys({});
    const f = vi.fn(async () => reply('{"overview":"o"}'));
    await summarize('m', f);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://h:1/v1/chat/completions');
  });
});
