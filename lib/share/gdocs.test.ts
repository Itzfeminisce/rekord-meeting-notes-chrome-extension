import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDB, getMeeting, putMeeting } from '../db';
import { GoogleError, type GoogleDeps } from '../google';
import { DEFAULT_OPTIONS } from '../export';
import { gdocsShare, shareLink, shareToDocs } from './gdocs';
import { toHtml } from './render';
import type { Meeting } from '../types';

const meeting: Meeting = {
  id: 'm1', title: 'Weekly <sync>', startedAt: Date.UTC(2026, 0, 5, 10), endedAt: Date.UTC(2026, 0, 5, 10, 42), status: 'done', language: 'en',
  summary: { overview: 'We planned the launch.', decisions: ['Ship Friday'], actions: [{ text: 'Write notes', owner: 'Sam' }], questions: [], generatedAt: 1, model: 'x' },
};
const segs = [{ id: 's1', meetingId: 'm1', speaker: 'you' as const, startMs: 65000, endMs: 70000, text: 'Hello there', chunkId: 'c' }];
const notes = [{ id: 'n1', meetingId: 'm1', atMs: 5000, text: 'Remember this', createdAt: 1 }];

interface Call { url: string; method: string; body?: string }
function fakeDrive(opts: { folder?: boolean; failUpdate?: boolean; failAll?: boolean } = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body as string | undefined });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (opts.failAll) return json({}, 500);
    if (url.includes('?q=')) return json({ files: opts.folder ? [{ id: 'F1' }] : [] });
    if (url.includes('/upload/') && method === 'PATCH') return opts.failUpdate ? json({}, 404) : json({ id: 'D1' });
    if (url.includes('/upload/')) return json({ id: 'D1' });
    if (url.endsWith('/permissions')) return json({ id: 'p' });
    return json({ id: 'F1' });
  }) as unknown as typeof fetch;
  const deps: GoogleDeps = {
    fetch: f, clientId: 'test-client',
    identity: { getAuthToken: async () => ({ token: 'tok_test' }), removeCachedAuthToken: async () => undefined },
  };
  return { calls, deps };
}

beforeEach(async () => {
  await closeDB();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await putMeeting(meeting);
});

describe('toHtml', () => {
  it('honours the include choices and escapes text', () => {
    const base = toHtml(meeting, segs, notes, []);
    expect(base).toContain('<h1>Weekly &lt;sync&gt;</h1>');
    expect(base).toContain('We planned the launch.');
    expect(base).toContain('<li>Write notes (Sam)</li>');
    expect(base).not.toContain('Hello there');
    expect(base).not.toContain('Remember this');
    const all = toHtml(meeting, segs, notes, [], { ...DEFAULT_OPTIONS, transcript: true, notes: true });
    expect(all).toContain('[1:05] You: Hello there');
    expect(all).toContain('Remember this');
    const none = toHtml(meeting, segs, notes, [], { summary: false, actions: false, decisions: false, transcript: false, notes: false });
    expect(none).not.toContain('Write notes');
    expect(none).not.toContain('Ship Friday');
  });
});

describe('shareToDocs', () => {
  it('creates the Rekord folder, uploads a Google Doc into it and saves the record', async () => {
    const { calls, deps } = fakeDrive();
    const { record } = await shareToDocs(meeting, '<p>x</p>', {}, deps);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
    expect(calls[1]?.body).toContain('"name":"Rekord"');
    expect(calls[2]?.body).toContain('application/vnd.google-apps.document');
    expect(calls[2]?.body).toContain('"parents":["F1"]');
    expect(record.url).toBe('https://docs.google.com/document/d/D1/edit');
    expect((await getMeeting('m1'))?.shares).toEqual([record]);
  });

  it('reuses an existing folder', async () => {
    const { calls, deps } = fakeDrive({ folder: true });
    await shareToDocs(meeting, '<p>x</p>', {}, deps);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1]?.body).toContain('"parents":["F1"]');
  });

  it('updates the existing doc instead of making a duplicate', async () => {
    const first = fakeDrive();
    const { meeting: saved } = await shareToDocs(meeting, '<p>x</p>', {}, first.deps);
    const second = fakeDrive();
    const { meeting: again } = await shareToDocs(saved, '<p>y</p>', {}, second.deps);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.method).toBe('PATCH');
    expect(second.calls[0]?.url).toContain('/D1?');
    expect(again.shares).toHaveLength(1);
  });

  it('makes a new doc when the old one is gone', async () => {
    const first = fakeDrive();
    const { meeting: saved } = await shareToDocs(meeting, '<p>x</p>', {}, first.deps);
    const second = fakeDrive({ failUpdate: true, folder: true });
    await shareToDocs(saved, '<p>y</p>', {}, second.deps);
    expect(second.calls.map((c) => c.method)).toEqual(['PATCH', 'GET', 'POST']);
  });

  it('throws a GoogleError and saves nothing when Google fails', async () => {
    const { deps } = fakeDrive({ failAll: true });
    await expect(shareToDocs(meeting, '<p>x</p>', {}, deps)).rejects.toBeInstanceOf(GoogleError);
    expect((await getMeeting('m1'))?.shares).toBeUndefined();
  });
});

describe('shareLink', () => {
  it('saves the doc, sets anyone-reader and marks linkShared', async () => {
    const { calls, deps } = fakeDrive();
    const { record } = await shareLink(meeting, '<p>x</p>', deps);
    const perm = calls.find((c) => c.url.endsWith('/D1/permissions'));
    expect(JSON.parse(perm?.body ?? '{}')).toEqual({ type: 'anyone', role: 'reader' });
    expect(record.linkShared).toBe(true);
    expect(gdocsShare((await getMeeting('m1')) as Meeting)?.linkShared).toBe(true);
  });

  it('only adds the permission when the doc already exists', async () => {
    const first = fakeDrive();
    const { meeting: saved } = await shareToDocs(meeting, '<p>x</p>', {}, first.deps);
    const second = fakeDrive();
    await shareLink(saved, '<p>x</p>', second.deps);
    expect(second.calls.map((c) => c.method)).toEqual(['POST']);
    expect(second.calls[0]?.url).toContain('/permissions');
  });
});
