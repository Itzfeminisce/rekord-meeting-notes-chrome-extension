import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDB, getChunk, listSegments, putChunk, putMeeting } from '@/lib/db';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import type { Chunk, Message } from '@/lib/types';
import { configLoader, createTranscriber } from './queue';

const KEY = 'gsk_test';
const chunk = (id: string, startMs: number, meetingId = 'm1'): Chunk => ({
  id, meetingId, speaker: 'you', startMs, endMs: startMs + 10_000, mimeType: 'audio/webm',
  audio: new Blob([id]), status: 'pending', attempts: 0,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

type Step = Response | 'throw';
const queues: ReturnType<typeof createTranscriber>[] = [];
function setup(steps: Step[], opts: { keys?: Record<string, string>; online?: boolean; hangSleep?: boolean } = {}) {
  let t = 1_000_000;
  const sent: Message[] = [];
  const sleeps: number[] = [];
  const calls: { url: string; file: string; form: FormData; auth: string }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    calls.push({ url, form, file: await (form.get('file') as Blob).text(), auth: (init.headers as Record<string, string>).Authorization ?? "" });
    const step = steps.shift() ?? json({ text: 'hello' });
    if (step === 'throw') throw new TypeError('Failed to fetch');
    return step;
  }) as unknown as typeof globalThis.fetch;
  const q = createTranscriber({
    fetch,
    send: async (m) => { sent.push(m); },
    now: () => t,
    sleep: (ms) => { sleeps.push(ms); t += ms; return opts.hangSleep ? new Promise<void>(() => {}) : Promise.resolve(); },
    isOnline: () => opts.online ?? true,
    getSettings: async () => DEFAULT_SETTINGS,
    loadKeys: async () => opts.keys ?? { GROQ_API_KEY: KEY },
  });
  queues.push(q);
  const states = () => sent.filter((m) => m.type === 'connection/state').map((m) => (m as { state: unknown }).state);
  return { q, sent, sleeps, calls, states };
}

describe('transcription queue', () => {
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((q) => q.drain())); // wait for each queue run to end
  });

  beforeEach(async () => {
    fakeBrowser.reset();
    await closeDB();
    globalThis.indexedDB = new IDBFactory();
    await putMeeting({ id: 'm1', title: 'M', startedAt: 0, status: 'recording', language: 'en' });
  });

  it('transcribes a chunk into a segment and drops its audio', async () => {
    const { q, sent, calls } = setup([json({ text: ' Hi there ' }), json({ text: '' })]);
    await putChunk(chunk('a', 0));
    await putChunk(chunk('b', 10_000));
    q.enqueue('a');
    await q.drain('m1');
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.form.get('model')).toBe('whisper-large-v3-turbo');
    expect(calls[0]!.form.get('language')).toBe('en');
    expect(calls[0]!.form.get('response_format')).toBe('json');
    const segs = await listSegments('m1');
    expect(segs.map((s) => s.text)).toEqual(['Hi there']); // empty text → no segment
    const a = await getChunk('a');
    expect(a?.status).toBe('done');
    expect(a?.audio).toBeUndefined();
    expect((await getChunk('b'))?.status).toBe('done');
    expect(sent.filter((m) => m.type === 'segment/added')).toHaveLength(1);
  });

  it('waits for retry-after on 429 and keeps the chunk pending', async () => {
    const { q, sleeps, states } = setup([json({}, 429, { 'retry-after': '7' }), json({ text: 'ok' })]);
    await putChunk(chunk('a', 0));
    q.enqueue('a');
    await q.drain('m1');
    expect(sleeps).toContain(7000);
    expect(states()[0]).toMatchObject({ ok: false, reason: 'rate-limited', retryAt: 1_007_000, pendingChunks: 1 });
    expect(states().at(-1)).toEqual({ ok: true });
    expect((await getChunk('a'))?.status).toBe('done');
  });

  it('stops on 401 until catch-up, without hanging drain', async () => {
    const { q, calls, states } = setup([json({}, 401)]);
    await putChunk(chunk('a', 0));
    q.enqueue('a');
    await q.drain('m1');
    expect(states()).toEqual([{ ok: false, reason: 'auth', pendingChunks: 1 }]);
    expect((await getChunk('a'))?.status).toBe('pending');
    q.enqueue('a');
    await q.drain('m1');
    expect(calls).toHaveLength(1);
    q.catchUp();
    await q.drain('m1');
    expect((await getChunk('a'))?.status).toBe('done');
  });

  it('reports auth when the key is missing', async () => {
    const { q, calls, states } = setup([], { keys: {} });
    await putChunk(chunk('a', 0));
    q.enqueue('a');
    await q.drain('m1');
    expect(calls).toHaveLength(0);
    expect(states()[0]).toMatchObject({ reason: 'auth' });
  });

  it('backs off on network errors and marks failed after 5 attempts', async () => {
    const { q, sleeps, states } = setup(['throw', 'throw', 'throw', 'throw', 'throw']);
    await putChunk(chunk('a', 0));
    q.enqueue('a');
    await q.drain('m1'); // resolves once the chunk is failed
    await q.drain(); // let the final backoff finish
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(states()[0]).toMatchObject({ reason: 'offline', retryAt: 1_001_000 });
    const a = await getChunk('a');
    expect(a).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('does not count attempts while the browser is offline; recovers on success', async () => {
    const { q, states } = setup(['throw', 'throw', 'throw', 'throw', 'throw', 'throw', json({}, 503)], { online: false });
    await putChunk(chunk('a', 0));
    q.enqueue('a');
    await q.drain('m1'); // resolves early: the queue is blocked offline
    for (let i = 0; i < 200 && (await getChunk('a'))?.status === 'pending'; i++) await new Promise((r) => setTimeout(r, 0));
    const a = await getChunk('a');
    expect(a).toMatchObject({ status: 'done', attempts: 2 });
    expect(states().some((s) => (s as { reason?: string }).reason === 'server')).toBe(true);
    expect(states().at(-1)).toEqual({ ok: true });
  });

  it('drain resolves while the browser stays offline; chunks stay pending', async () => {
    const { q, calls, states } = setup(['throw'], { online: false, hangSleep: true });
    await putChunk(chunk('a', 0));
    await putChunk(chunk('b', 10_000));
    q.enqueue('a');
    await q.drain('m1');
    expect(calls).toHaveLength(1);
    expect(states()[0]).toMatchObject({ ok: false, reason: 'offline', pendingChunks: 2 });
    expect(await getChunk('a')).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await getChunk('b'))?.status).toBe('pending');
    await q.drain(); // a later drain resolves too
  });

  it('sends chunks oldest first, one at a time, ≤20 per minute', async () => {
    const { q, calls, sleeps } = setup([]);
    for (let i = 21; i >= 0; i--) await putChunk(chunk(`c${String(i).padStart(2, '0')}`, i * 10_000));
    q.enqueue('c00');
    await q.drain('m1');
    expect(calls.map((c) => c.file)).toEqual([...Array(22)].map((_, i) => `c${String(i).padStart(2, '0')}`));
    expect(sleeps).toEqual([60_000]);
  });

  it('announces drained for a processing meeting when nobody is draining', async () => {
    await putMeeting({ id: 'm1', title: 'M', startedAt: 0, status: 'processing', language: 'en' });
    const { q, sent } = setup([]);
    await putChunk(chunk('a', 0));
    q.catchUp();
    await q.drain(); // waits for the run to end
    expect(sent).toContainEqual({ type: 'transcription/drained', meetingId: 'm1' });
  });

  it('reports a server error instead of silently stopping when config cannot load', async () => {
    const sent: Message[] = [];
    const q2 = createTranscriber({ send: async (m) => { sent.push(m); }, getSettings: async () => { throw new Error('no storage'); } });
    queues.push(q2);
    await putChunk(chunk('a', 0));
    q2.enqueue('a');
    await q2.drain('m1'); // must not hang
    expect(sent).toContainEqual({ type: 'connection/state', state: { ok: false, reason: 'server', pendingChunks: 1 } });
    expect((await getChunk('a'))?.status).toBe('pending');
  });
});

describe('configLoader', () => {
  it('requests settings and keys from the background via transcriber/config', async () => {
    const sent: Message[] = [];
    const loader = configLoader(async (m) => { sent.push(m); return { settings: DEFAULT_SETTINGS, keys: { GROQ_API_KEY: KEY } }; });
    expect(await loader.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await loader.loadKeys()).toEqual({ GROQ_API_KEY: KEY });
    expect(sent).toEqual([{ type: 'transcriber/config' }, { type: 'transcriber/config' }]);
  });

  it('throws when nothing answers', async () => {
    const loader = configLoader(async () => undefined);
    await expect(loader.getSettings()).rejects.toThrow();
    await expect(loader.loadKeys()).rejects.toThrow();
  });
});
