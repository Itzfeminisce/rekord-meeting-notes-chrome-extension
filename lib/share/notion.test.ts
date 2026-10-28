import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDB, getMeeting, putMeeting } from '../db';
import { buildBlocks, idOfUrl, NotionError, notionShare, searchPages, shareToNotion, validateSecret, NOTION_VERSION } from './notion';
import type { Meeting } from '../types';

const TOKEN = 'ntn_test';
const meeting: Meeting = {
  id: 'm1', title: 'Weekly sync', startedAt: Date.UTC(2026, 0, 5, 10), endedAt: Date.UTC(2026, 0, 5, 10, 42), status: 'done', language: 'en',
  summary: { overview: 'We planned the launch.', decisions: ['Ship Friday'], actions: [{ text: 'Write notes', owner: 'Sam' }], questions: [], generatedAt: 1, model: 'x' },
};
const PAGE_URL = 'https://www.notion.so/Weekly-sync-0123456789abcdef0123456789abcdef';

interface Call { url: string; method: string; body?: string; headers: Record<string, string> }
function fakeNotion(handler: (url: string, method: string, body: unknown) => { status?: number; json?: unknown } | undefined = () => undefined) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    const r = handler(url, method, body) ?? {};
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, deps: { fetch: f } };
}

beforeEach(async () => {
  await closeDB();
  indexedDB = new IDBFactory();
});

describe('validateSecret', () => {
  it('calls /users/me with the version header and bearer token', async () => {
    const { calls, deps } = fakeNotion(() => ({ json: { name: 'Rekord' } }));
    expect(await validateSecret(TOKEN, deps)).toEqual({ name: 'Rekord' });
    expect(calls[0]!.url).toBe('https://api.notion.com/v1/users/me');
    expect(calls[0]!.headers['Notion-Version']).toBe(NOTION_VERSION);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('maps errors to codes', async () => {
    await expect(validateSecret(TOKEN, fakeNotion(() => ({ status: 401 })).deps)).rejects.toMatchObject({ code: 'auth' });
    await expect(validateSecret(TOKEN, fakeNotion(() => ({ status: 429 })).deps)).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(validateSecret(TOKEN, fakeNotion(() => ({ status: 500 })).deps)).rejects.toMatchObject({ code: 'server' });
    const offline = { fetch: (async () => { throw new TypeError('x'); }) as unknown as typeof fetch };
    await expect(validateSecret(TOKEN, offline)).rejects.toBeInstanceOf(NotionError);
    await expect(validateSecret(TOKEN, offline)).rejects.toMatchObject({ code: 'offline' });
  });
  it('never puts the secret in an error message', async () => {
    const err = await validateSecret(TOKEN, fakeNotion(() => ({ status: 401 })).deps).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe('searchPages', () => {
  it('filters to pages and maps title and parent kind', async () => {
    const { calls, deps } = fakeNotion(() => ({ json: { results: [
      { id: 'a', parent: { type: 'workspace' }, properties: { title: { type: 'title', title: [{ plain_text: 'My ' }, { plain_text: 'notes' }] } } },
      { id: 'b', parent: { type: 'teamspace' }, properties: { Name: { type: 'title', title: [{ plain_text: 'Product' }] } } },
      { id: 'c', parent: { type: 'page_id' }, properties: { title: { type: 'title', title: [] } } },
      { id: 'd', archived: true, properties: {} },
    ] } }));
    const pages = await searchPages(TOKEN, deps);
    expect(JSON.parse(calls[0]!.body!).filter).toEqual({ property: 'object', value: 'page' });
    expect(pages).toEqual([
      { id: 'a', title: 'My notes', parent: 'Private' },
      { id: 'b', title: 'Product', parent: 'Team space' },
      { id: 'c', title: 'Untitled' },
    ]);
  });
  it('follows pagination', async () => {
    let n = 0;
    const { calls, deps } = fakeNotion(() => (++n === 1
      ? { json: { results: [{ id: 'a', properties: {} }], has_more: true, next_cursor: 'cur' } }
      : { json: { results: [{ id: 'b', properties: {} }] } }));
    expect((await searchPages(TOKEN, deps)).map((p) => p.id)).toEqual(['a', 'b']);
    expect(JSON.parse(calls[1]!.body!).start_cursor).toBe('cur');
  });
});

describe('buildBlocks', () => {
  it('makes headings, paragraphs, bullets and to-dos for action items', () => {
    const blocks = buildBlocks(meeting, [], [], []);
    const types = blocks.map((b) => b.type);
    expect(types[0]).toBe('paragraph');
    expect(types).toContain('heading_2');
    const todo = blocks.find((b) => b.type === 'to_do') as unknown as { to_do: { checked: boolean; rich_text: { text: { content: string } }[] } };
    expect(todo.to_do.checked).toBe(false);
    expect(todo.to_do.rich_text[0]!.text.content).toBe('Write notes (Sam)');
    expect(blocks.some((b) => b.type === 'bulleted_list_item')).toBe(true);
  });
  it('splits text longer than 2000 characters', () => {
    const long: Meeting = { ...meeting, summary: { ...meeting.summary!, overview: 'x'.repeat(4500) } };
    const paras = buildBlocks(long, [], [], []).filter((b) => b.type === 'paragraph');
    expect(paras.length).toBe(1 + 3);
  });
  it('leaves out parts that are not included', () => {
    const blocks = buildBlocks(meeting, [], [], [], { summary: false, actions: true, decisions: false, transcript: false, notes: false });
    expect(blocks.filter((b) => b.type === 'heading_2')).toHaveLength(1);
  });
});

describe('shareToNotion', () => {
  it('creates a child page under the chosen page and saves a ShareRecord', async () => {
    await putMeeting(meeting);
    const { calls, deps } = fakeNotion(() => ({ json: { id: 'P1', url: PAGE_URL } }));
    const blocks = buildBlocks(meeting, [], [], []);
    const { record } = await shareToNotion(TOKEN, 'parent1', meeting, blocks, deps);
    const body = JSON.parse(calls[0]!.body!);
    expect(calls[0]!.method).toBe('POST');
    expect(body.parent).toEqual({ page_id: 'parent1' });
    expect(body.properties.title.title[0].text.content).toBe('Weekly sync');
    expect(record).toMatchObject({ kind: 'notion', url: PAGE_URL });
    expect(notionShare((await getMeeting('m1'))!)?.url).toBe(PAGE_URL);
  });
  it('sends blocks past 100 in follow-up appends', async () => {
    const many = Array.from({ length: 230 }, () => buildBlocks(meeting, [], [], [])[0]!);
    const { calls, deps } = fakeNotion(() => ({ json: { id: 'P1', url: PAGE_URL } }));
    await putMeeting(meeting);
    await shareToNotion(TOKEN, 'parent1', meeting, many, deps);
    expect(JSON.parse(calls[0]!.body!).children).toHaveLength(100);
    expect(calls.slice(1).map((c) => JSON.parse(c.body!).children.length)).toEqual([100, 30]);
  });
  it('re-share updates the same page: retitles, clears old blocks, appends new, keeps one record', async () => {
    const shared: Meeting = { ...meeting, shares: [{ kind: 'notion', url: PAGE_URL, at: 1 }] };
    await putMeeting(shared);
    const { calls, deps } = fakeNotion((url, method) => {
      if (method === 'GET') return { json: { results: [{ id: 'old1' }, { id: 'old2' }] } };
      if (method === 'PATCH' && url.includes('/pages/')) return { json: { id: 'x', url: PAGE_URL } };
      return undefined;
    });
    const { meeting: next } = await shareToNotion(TOKEN, 'parent1', shared, buildBlocks(shared, [], [], []), deps);
    const id = '0123456789abcdef0123456789abcdef';
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(calls[0]!.url).toContain(`/pages/${id}`);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop())).toEqual(['old1', 'old2']);
    expect(calls.at(-1)!.url).toContain(`/blocks/${id}/children`);
    expect(next.shares?.filter((s) => s.kind === 'notion')).toHaveLength(1);
  });
  it('makes a new page when the earlier one is gone', async () => {
    const shared: Meeting = { ...meeting, shares: [{ kind: 'notion', url: PAGE_URL, at: 1 }] };
    await putMeeting(shared);
    const { calls, deps } = fakeNotion((url, method) => {
      if (method === 'PATCH' && url.includes('/pages/')) return { status: 404 };
      return { json: { id: 'P2', url: 'https://www.notion.so/New-ffffffffffffffffffffffffffffffff' } };
    });
    const { record } = await shareToNotion(TOKEN, 'parent1', shared, [], deps);
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    expect(record.url).toContain('ffff');
  });
  it('surfaces other failures', async () => {
    await expect(shareToNotion(TOKEN, 'p', meeting, [], fakeNotion(() => ({ status: 500 })).deps)).rejects.toMatchObject({ code: 'server' });
  });
});

describe('idOfUrl', () => {
  it('reads the page id from a Notion url', () => {
    expect(idOfUrl(PAGE_URL)).toBe('0123456789abcdef0123456789abcdef');
    expect(idOfUrl('https://example.com')).toBeUndefined();
  });
});
