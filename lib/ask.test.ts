import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ask, buildAskMessages, markUnfinished, parseCitations, saveAnswerAsNote } from './ask';
import { closeDB, listAsks, listNotes, putMeeting, putNote, putSegment } from './db';
import { saveKeys } from './keys';

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

beforeEach(async () => {
  fakeBrowser.reset();
  await closeDB();
  globalThis.indexedDB = new IDBFactory();
  await putMeeting({ id: 'm', title: 'Sync', startedAt: 0, status: 'recording', language: 'en' });
  await putSegment({ id: 's', meetingId: 'm', speaker: 'you', startMs: 65000, endMs: 70000, text: 'pricing stays', chunkId: 'c' });
  await putNote({ id: 'n', meetingId: 'm', atMs: 66000, text: 'check competitor', createdAt: 1 });
  await saveKeys({ GROQ_API_KEY: 'gsk_test' });
});

describe('parseCitations', () => {
  it('parses m:ss and h:mm:ss, unique, in order', () => {
    expect(parseCitations('A [18:30] B [1:02:03] C [18:30] [x]')).toEqual([1110000, 3723000]);
    expect(parseCitations('nothing')).toEqual([]);
  });
});

describe('buildAskMessages', () => {
  it('has a grounded system prompt, the context, history and the question', () => {
    const msgs = buildAskMessages({
      meeting: { title: 'Sync' },
      segments: [{ id: 's', meetingId: 'm', speaker: 'you', startMs: 65000, endMs: 70000, text: 'pricing stays', chunkId: 'c' }],
      notes: [{ id: 'n', meetingId: 'm', atMs: 66000, text: 'check competitor', createdAt: 1 }],
      markers: [],
      history: [{ id: 'h', meetingId: 'm', createdAt: 1, question: 'q1', answer: 'a1' }, { id: 'e', meetingId: 'm', createdAt: 2, question: 'bad', error: 'x' }],
    }, 'What now?');
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toMatch(/only/);
    expect(msgs[0]!.content).toMatch(/\[mm:ss\]/);
    expect(msgs[1]!.content).toContain('Meeting: Sync');
    expect(msgs[1]!.content).toContain('pricing stays');
    expect(msgs[1]!.content).toContain('check competitor');
    expect(msgs.slice(2).map((m) => m.content)).toEqual(['q1', 'a1', 'What now?']);
  });
});

describe('ask', () => {
  it('saves the question first, then the answer with citations', async () => {
    let during: unknown;
    const fetchFn = vi.fn(async () => { during = (await listAsks('m'))[0]; return reply('Price stays [1:05].'); });
    const t = await ask('m', ' What about pricing? ', { fetch: fetchFn });
    expect(during).toMatchObject({ question: 'What about pricing?' });
    expect((during as { answer?: string }).answer).toBeUndefined();
    expect(t.answer).toBe('Price stays [1:05].');
    expect(t.citations).toEqual([65000]);
    expect(await listAsks('m')).toEqual([t]);
  });
  it('stores an error turn and retry reuses it', async () => {
    const bad = await ask('m', 'q', { fetch: async () => reply('', 500) });
    expect(bad.error).toBeTruthy();
    expect(bad.answer).toBeUndefined();
    const ok = await ask('m', 'q', { fetch: async () => reply('Fine.'), turnId: bad.id });
    expect(ok.id).toBe(bad.id);
    expect(ok.error).toBeUndefined();
    expect(await listAsks('m')).toHaveLength(1);
  });
  it('reports a missing key without calling the network', async () => {
    await fakeBrowser.storage.local.clear(); await fakeBrowser.storage.session.clear();
    const fetchFn = vi.fn();
    const t = await ask('m', 'q', { fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(t.error).toMatch(/Connect AI/);
  });
});

describe('saveAnswerAsNote', () => {
  it('uses the newest cited moment, else now', async () => {
    await saveAnswerAsNote({ id: 't', meetingId: 'm', createdAt: 1, question: 'q', answer: 'a', citations: [1000, 5000] }, 9000);
    await saveAnswerAsNote({ id: 't2', meetingId: 'm', createdAt: 1, question: 'q', answer: 'b' }, 9000);
    const at = (await listNotes('m')).map((n) => [n.text, n.atMs]);
    expect(at).toContainEqual(['a', 5000]);
    expect(at).toContainEqual(['b', 9000]);
  });
});

describe('citation validation', () => {
  it('rejects invalid seconds/minutes', () => {
    expect(parseCitations('[99:99] [12:75] [1:60] [1:75:00] [1:00:61] [2:05]')).toEqual([125000]);
  });
  it('drops citations beyond maxMs', () => {
    expect(parseCitations('[1:00] [30:00]', 120000)).toEqual([60000]);
  });
  it('saveAnswerAsNote ignores out-of-range citations', async () => {
    const n = await saveAnswerAsNote({ id: 'x', meetingId: 'm', createdAt: 1, question: 'q', answer: 'c', citations: [6000000] }, 9000, 120000);
    expect(n.atMs).toBe(9000);
  });
});

describe('markUnfinished', () => {
  it('fails unfinished turns except the running one', () => {
    const base = { meetingId: 'm', createdAt: 1, question: 'q' };
    const out = markUnfinished([{ ...base, id: 'a' }, { ...base, id: 'b' }, { ...base, id: 'c', answer: 'x' }], 'b');
    expect(out[0]?.error).toBe("This question didn't finish. Try again.");
    expect(out[1]?.error).toBeUndefined();
    expect(out[2]?.error).toBeUndefined();
  });
});
