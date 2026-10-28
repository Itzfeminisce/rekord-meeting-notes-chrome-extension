import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDB, getMeeting, listMarkers, putMarker, putMeeting, putSegment } from './db';
import { saveKeys } from './keys';
import { getSettings, updateSettings } from './settings';
import { buildPrompt } from './summarize';
import { isDuplicate, parseSuggestions, resolveSuggestion, runSuggest, startSuggester, suggestionCounts } from './suggest';
import type { Marker } from './types';

const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const seg = (id: string, startMs: number, text = 'I will draft the email by Thursday') =>
  putSegment({ id, meetingId: 'm', speaker: 'you', startMs, endMs: startMs + 5000, text, chunkId: id });

beforeEach(async () => {
  fakeBrowser.reset();
  await closeDB();
  globalThis.indexedDB = new IDBFactory();
  await putMeeting({ id: 'm', title: 'Sync', startedAt: 0, status: 'recording', language: 'en' });
  await saveKeys({ GROQ_API_KEY: 'gsk_test' });
});
afterEach(() => { vi.useRealTimers(); });

describe('parseSuggestions', () => {
  it('parses arrays, fences, wrappers and caps at 3', () => {
    const arr = '[{"text":" A ","owner":"You","due":"Thu","atMs":5000},{"text":"B"},{"text":"C"},{"text":"D"},{"nope":1}]';
    const out = parseSuggestions('```json\n' + arr + '\n```');
    expect(out.map((s) => s.text)).toEqual(['A', 'B', 'C']);
    expect(out[0]).toMatchObject({ owner: 'You', due: 'Thu', atMs: 5000 });
    expect(parseSuggestions('{"actions":[{"text":"X","atMs":"1:05"}]}')[0]?.atMs).toBe(65000);
    expect(parseSuggestions('sorry, none')).toEqual([]);
  });
});

describe('isDuplicate', () => {
  it('ignores case and spacing, and matches containment', () => {
    expect(isDuplicate('Draft  Email', ['draft email'])).toBe(true);
    expect(isDuplicate('Draft email copy', ['draft email'])).toBe(true);
    expect(isDuplicate('draft', ['Draft email copy'])).toBe(true);
    expect(isDuplicate('Book room', ['Draft email'])).toBe(false);
  });
});

describe('runSuggest', () => {
  it('saves suggestions, drops duplicates and advances the cursor', async () => {
    await seg('s1', 60_000);
    await putMarker({ id: 'old', meetingId: 'm', atMs: 1, kind: 'action', label: 'Send invoice' });
    const fetchFn = vi.fn(async () => reply('[{"text":"Draft launch email","owner":"You","due":"Thursday","atMs":62000},{"text":"send invoice"}]'));
    const made = await runSuggest('m', { fetchFn });
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: 'action', source: 'ai', status: 'suggested', label: 'Draft launch email', atMs: 62000, owner: 'You', due: 'Thursday' });
    expect((await listMarkers('m')).filter((m) => m.source === 'ai')).toHaveLength(1);
    expect((await getMeeting('m'))?.suggestCursorMs).toBe(60_000);
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toContain('Send invoice');
    // nothing new after the cursor: no call
    expect(await runSuggest('m', { fetchFn })).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps the cursor when the call fails, and does nothing when the switch is off', async () => {
    await seg('s1', 60_000);
    expect(await runSuggest('m', { fetchFn: async () => new Response('{}', { status: 500 }) })).toEqual([]);
    expect((await getMeeting('m'))?.suggestCursorMs).toBeUndefined();
    const s = await getSettings();
    await updateSettings({ features: { ...s.features, liveSuggestions: false } });
    const fetchFn = vi.fn(async () => reply('[]'));
    await runSuggest('m', { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('only sends the last 3 minutes', async () => {
    await seg('old', 1_000, 'ancient talk');
    await seg('new', 400_000, 'recent talk');
    const fetchFn = vi.fn(async () => reply('[]'));
    await runSuggest('m', { fetchFn });
    const body = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(body).toContain('recent talk');
    expect(body).not.toContain('ancient talk');
  });
});

describe('startSuggester', () => {
  it('runs each minute, skips when unhealthy or in flight', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await seg('s1', 1000);
    let ok = false;
    let release: () => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((res) => { release = () => res(reply('[{"text":"Do it"}]')); }));
    const onNew = vi.fn();
    const stop = startSuggester({ meetingId: 'm', isOk: () => ok, onNew, fetchFn });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).not.toHaveBeenCalled(); // connection not ok
    ok = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000); // still in flight
    expect(fetchFn).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('accept / dismiss', () => {
  const sug: Marker = { id: 'a', meetingId: 'm', atMs: 5, kind: 'action', label: 'Draft', source: 'ai', status: 'suggested' };
  it('persists the decision and edits, and counts them', async () => {
    await putMarker(sug);
    await putMarker({ ...sug, id: 'b', label: 'Other' });
    await resolveSuggestion(sug, 'accepted', { label: ' Draft copy ' });
    await resolveSuggestion({ ...sug, id: 'b' }, 'dismissed');
    const list = await listMarkers('m');
    expect(list.find((m) => m.id === 'a')).toMatchObject({ status: 'accepted', label: 'Draft copy' });
    expect(list.find((m) => m.id === 'b')?.status).toBe('dismissed');
    expect(suggestionCounts([...list, { ...sug, id: 'c' }])).toEqual({ added: 1, waiting: 1 });
  });
});

describe('summary prompt', () => {
  it('includes accepted AI actions only', () => {
    const base: Marker = { id: 'x', meetingId: 'm', atMs: 65_000, kind: 'action', source: 'ai' };
    const p = buildPrompt('T', [], [], [
      { ...base, label: 'Accepted one', status: 'accepted', owner: 'You', due: 'Thu' },
      { ...base, id: 'y', label: 'Waiting one', status: 'suggested' },
      { ...base, id: 'z', label: 'Dismissed one', status: 'dismissed' },
    ]);
    expect(p).toContain('action: Accepted one (owner: You) (due: Thu)');
    expect(p).not.toContain('Waiting one');
    expect(p).not.toContain('Dismissed one');
  });
});
