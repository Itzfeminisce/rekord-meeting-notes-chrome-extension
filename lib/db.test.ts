import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeDB, deleteMeeting, getMeeting, listChunks, listMarkers, listMeetings, listNotes, listSegments,
  pendingChunks, putChunk, putMarker, putMeeting, putNote, putSegment,
} from './db';
import type { Chunk, Meeting } from './types';

const meeting = (id: string, startedAt: number): Meeting => ({ id, title: id, startedAt, status: 'done', language: 'en' });
const chunk = (id: string, meetingId: string, startMs: number, status: Chunk['status']): Chunk => ({
  id, meetingId, speaker: 'you', startMs, endMs: startMs + 10_000, mimeType: 'audio/webm', status, attempts: 0,
});

describe('db', () => {
  beforeEach(async () => {
    await closeDB();
    globalThis.indexedDB = new IDBFactory();
  });

  it('lists meetings newest first', async () => {
    await putMeeting(meeting('a', 1));
    await putMeeting(meeting('b', 2));
    expect((await listMeetings()).map((m) => m.id)).toEqual(['b', 'a']);
    expect((await getMeeting('a'))?.title).toBe('a');
  });

  it('lists children by meeting, sorted by time', async () => {
    await putMeeting(meeting('m', 1));
    await putSegment({ id: 's2', meetingId: 'm', speaker: 'you', startMs: 20, endMs: 30, text: 'b', chunkId: 'c' });
    await putSegment({ id: 's1', meetingId: 'm', speaker: 'others', startMs: 0, endMs: 10, text: 'a', chunkId: 'c' });
    await putSegment({ id: 'x', meetingId: 'other', speaker: 'you', startMs: 0, endMs: 10, text: 'x', chunkId: 'c' });
    expect((await listSegments('m')).map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('returns pending chunks, optionally per meeting', async () => {
    await putChunk(chunk('c2', 'm', 10, 'pending'));
    await putChunk(chunk('c1', 'm', 0, 'pending'));
    await putChunk(chunk('c3', 'm', 20, 'done'));
    await putChunk(chunk('c4', 'n', 0, 'pending'));
    expect((await pendingChunks('m')).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(await pendingChunks()).toHaveLength(3);
  });

  it('cascades meeting deletes', async () => {
    await putMeeting(meeting('m', 1));
    await putMeeting(meeting('keep', 2));
    await putNote({ id: 'n', meetingId: 'm', atMs: 0, text: 'hi', createdAt: 1 });
    await putMarker({ id: 'k', meetingId: 'm', atMs: 0, kind: 'decision' });
    await putChunk(chunk('c', 'm', 0, 'pending'));
    await putChunk(chunk('c-keep', 'keep', 0, 'pending'));
    await deleteMeeting('m');
    expect(await getMeeting('m')).toBeUndefined();
    expect(await listNotes('m')).toEqual([]);
    expect(await listMarkers('m')).toEqual([]);
    expect(await listChunks('m')).toEqual([]);
    expect(await listChunks('keep')).toHaveLength(1);
  });
});
