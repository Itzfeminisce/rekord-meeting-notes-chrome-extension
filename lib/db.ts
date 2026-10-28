import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AskTurn, Chunk, Marker, Meeting, Note, RecordingMeta, RecordingPart, Segment } from './types';

interface RekordDB extends DBSchema {
  meetings: { key: string; value: Meeting };
  segments: { key: string; value: Segment; indexes: { meetingId: string } };
  notes: { key: string; value: Note; indexes: { meetingId: string } };
  markers: { key: string; value: Marker; indexes: { meetingId: string } };
  chunks: { key: string; value: Chunk; indexes: { meetingId: string; status: string } };
  asks: { key: string; value: AskTurn; indexes: { meetingId: string } };
  recordings: { key: string; value: RecordingPart; indexes: { meetingId: string } };
  recordingMeta: { key: string; value: RecordingMeta };
}

type ChildStore = 'segments' | 'notes' | 'markers' | 'chunks' | 'asks' | 'recordings';
const CHILD_STORES: ChildStore[] = ['segments', 'notes', 'markers', 'chunks', 'asks', 'recordings'];

export const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<RekordDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<RekordDB>> {
  dbPromise ??= openDB<RekordDB>('rekord', DB_VERSION, {
    // Each step only adds stores, so data from earlier versions is kept.
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('meetings', { keyPath: 'id' });
        db.createObjectStore('segments', { keyPath: 'id' }).createIndex('meetingId', 'meetingId');
        db.createObjectStore('notes', { keyPath: 'id' }).createIndex('meetingId', 'meetingId');
        db.createObjectStore('markers', { keyPath: 'id' }).createIndex('meetingId', 'meetingId');
        const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
        chunks.createIndex('meetingId', 'meetingId');
        chunks.createIndex('status', 'status');
      }
      if (oldVersion < 2) {
        db.createObjectStore('asks', { keyPath: 'id' }).createIndex('meetingId', 'meetingId');
        db.createObjectStore('recordings', { keyPath: 'id' }).createIndex('meetingId', 'meetingId');
        db.createObjectStore('recordingMeta', { keyPath: 'meetingId' });
      }
    },
  });
  return dbPromise;
}

/** Test helper: close and forget the cached connection. */
export async function closeDB(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

// Meetings
export async function putMeeting(meeting: Meeting): Promise<void> {
  await (await getDB()).put('meetings', meeting);
}
export async function getMeeting(id: string): Promise<Meeting | undefined> {
  return (await getDB()).get('meetings', id);
}
/** Newest first by startedAt. */
export async function listMeetings(): Promise<Meeting[]> {
  const all = await (await getDB()).getAll('meetings');
  return all.sort((a, b) => b.startedAt - a.startedAt);
}
/** Deletes the meeting and all its segments, notes, markers, chunks, asks and recorded audio. */
export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['meetings', 'recordingMeta', ...CHILD_STORES], 'readwrite');
  const ops: Promise<unknown>[] = [tx.objectStore('meetings').delete(id), tx.objectStore('recordingMeta').delete(id)];
  for (const name of CHILD_STORES) {
    const keys = await tx.objectStore(name).index('meetingId').getAllKeys(id);
    for (const key of keys) ops.push(tx.objectStore(name).delete(key));
  }
  await Promise.all([...ops, tx.done]);
}

// Child records, sorted by time
async function listBy<S extends ChildStore>(store: S, meetingId: string): Promise<RekordDB[S]['value'][]> {
  // Every child store has a string `meetingId` index; the cast bridges idb's per-store generic typing.
  const db = (await getDB()) as unknown as IDBPDatabase<Pick<RekordDB, 'segments'>>;
  return db.getAllFromIndex(store as 'segments', 'meetingId', meetingId) as Promise<RekordDB[S]['value'][]>;
}
const byStart = (a: { startMs: number }, b: { startMs: number }) => a.startMs - b.startMs;
const byAt = (a: { atMs: number }, b: { atMs: number }) => a.atMs - b.atMs;

export async function putSegment(s: Segment): Promise<void> { await (await getDB()).put('segments', s); }
export async function getSegment(id: string): Promise<Segment | undefined> { return (await getDB()).get('segments', id); }
export async function listSegments(meetingId: string): Promise<Segment[]> { return (await listBy('segments', meetingId)).sort(byStart); }
export async function deleteSegment(id: string): Promise<void> { await (await getDB()).delete('segments', id); }

export async function putNote(n: Note): Promise<void> { await (await getDB()).put('notes', n); }
export async function getNote(id: string): Promise<Note | undefined> { return (await getDB()).get('notes', id); }
export async function listNotes(meetingId: string): Promise<Note[]> { return (await listBy('notes', meetingId)).sort(byAt); }
export async function deleteNote(id: string): Promise<void> { await (await getDB()).delete('notes', id); }

export async function putMarker(m: Marker): Promise<void> { await (await getDB()).put('markers', m); }
export async function getMarker(id: string): Promise<Marker | undefined> { return (await getDB()).get('markers', id); }
export async function listMarkers(meetingId: string): Promise<Marker[]> { return (await listBy('markers', meetingId)).sort(byAt); }
export async function deleteMarker(id: string): Promise<void> { await (await getDB()).delete('markers', id); }

export async function putChunk(c: Chunk): Promise<void> { await (await getDB()).put('chunks', c); }
export async function getChunk(id: string): Promise<Chunk | undefined> { return (await getDB()).get('chunks', id); }
export async function listChunks(meetingId: string): Promise<Chunk[]> { return (await listBy('chunks', meetingId)).sort(byStart); }
export async function deleteChunk(id: string): Promise<void> { await (await getDB()).delete('chunks', id); }

/** Chunks with status 'pending', oldest first; optionally for one meeting. */
export async function pendingChunks(meetingId?: string): Promise<Chunk[]> {
  const all = await (await getDB()).getAllFromIndex('chunks', 'status', 'pending');
  const chunks = all.filter((c) => !meetingId || c.meetingId === meetingId);
  if (meetingId) return chunks.sort(byStart);
  // Across meetings startMs is a per-meeting offset: order by absolute time.
  const meetings = await (await getDB()).getAll('meetings');
  const started = new Map(meetings.map((m) => [m.id, m.startedAt]));
  const abs = (c: Chunk) => (started.get(c.meetingId) ?? 0) + c.startMs;
  return chunks.sort((a, b) => abs(a) - abs(b));
}

// Ask turns, oldest first
export async function putAsk(a: AskTurn): Promise<void> { await (await getDB()).put('asks', a); }
export async function listAsks(meetingId: string): Promise<AskTurn[]> {
  return (await listBy('asks', meetingId)).sort((a, b) => a.createdAt - b.createdAt);
}

// Continuous recording: parts in seq order, plus pause metadata
export async function putRecordingPart(p: RecordingPart): Promise<void> { await (await getDB()).put('recordings', p); }
export async function listRecordingParts(meetingId: string): Promise<RecordingPart[]> {
  return (await listBy('recordings', meetingId)).sort((a, b) => a.seq - b.seq);
}
export async function getRecordingMeta(meetingId: string): Promise<RecordingMeta | undefined> {
  return (await getDB()).get('recordingMeta', meetingId);
}
export async function putRecordingMeta(m: RecordingMeta): Promise<void> { await (await getDB()).put('recordingMeta', m); }
/** Deletes a meeting's recorded audio parts and their metadata (the transcript is kept). */
export async function deleteRecording(meetingId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordings', 'recordingMeta'], 'readwrite');
  const keys = await tx.objectStore('recordings').index('meetingId').getAllKeys(meetingId);
  await Promise.all([
    ...keys.map((k) => tx.objectStore('recordings').delete(k)),
    tx.objectStore('recordingMeta').delete(meetingId),
    tx.done,
  ]);
}
