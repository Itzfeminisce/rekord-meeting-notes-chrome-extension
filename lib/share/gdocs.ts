/**
 * Share a meeting to Google Docs: find or create the "Rekord" Drive folder, upload the HTML as a Google Doc
 * (updating the earlier doc when the meeting was shared before), and optionally make it readable by anyone with the link.
 */
import { googleFetch, GoogleError, SCOPES, type GoogleDeps } from '../google';
import { putMeeting } from '../db';
import type { Meeting, ShareRecord } from '../types';

export const FOLDER_NAME = 'Rekord';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = [SCOPES.docs];

export const docUrl = (id: string): string => `https://docs.google.com/document/d/${id}/edit`;
export const docIdOf = (url: string): string | undefined => /\/document\/d\/([^/?#]+)/.exec(url)?.[1];

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** The id of the "Rekord" folder; creates it when it isn't there yet. */
export async function ensureFolder(deps: GoogleDeps = {}): Promise<string> {
  const q = `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const found = await googleFetch(`${API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id)')}&spaces=drive`, SCOPE, deps);
  const id = ((await found.json()) as { files?: { id: string }[] }).files?.[0]?.id;
  if (id) return id;
  const made = await googleFetch(`${API}?fields=id`, SCOPE, deps, jsonInit('POST', { name: FOLDER_NAME, mimeType: FOLDER_MIME }));
  const created = ((await made.json()) as { id?: string }).id;
  if (!created) throw new GoogleError('server');
  return created;
}

function multipart(metadata: unknown, html: string): RequestInit {
  const boundary = 'rekord' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
  return { headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body };
}

export interface SavedDoc { id: string; url: string }

/** Uploads `html` as a Google Doc in the Rekord folder. With `existingId` the doc is updated in place instead. */
export async function saveDoc(title: string, html: string, existingId?: string, deps: GoogleDeps = {}): Promise<SavedDoc> {
  if (existingId) {
    try {
      await googleFetch(`${UPLOAD}/${existingId}?uploadType=multipart&fields=id`, SCOPE, deps,
        { method: 'PATCH', ...multipart({ name: title, mimeType: DOC_MIME }, html) });
      return { id: existingId, url: docUrl(existingId) };
    } catch (err) {
      // The earlier doc was deleted in Drive: fall through and make a new one. Other problems stay errors.
      if (!(err instanceof GoogleError) || err.code !== 'server') throw err;
    }
  }
  const folder = await ensureFolder(deps);
  const res = await googleFetch(`${UPLOAD}?uploadType=multipart&fields=id`, SCOPE, deps,
    { method: 'POST', ...multipart({ name: title, mimeType: DOC_MIME, parents: [folder] }, html) });
  const id = ((await res.json()) as { id?: string }).id;
  if (!id) throw new GoogleError('server');
  return { id, url: docUrl(id) };
}

/** Anyone with the link can read the doc, not edit it. */
export async function makeLinkShared(id: string, deps: GoogleDeps = {}): Promise<void> {
  await googleFetch(`${API}/${id}/permissions`, SCOPE, deps, jsonInit('POST', { type: 'anyone', role: 'reader' }));
}

export const gdocsShare = (meeting: Meeting): ShareRecord | undefined => meeting.shares?.find((s) => s.kind === 'gdocs');

/** Saves (or updates) the meeting's doc, optionally opens the link, and stores the ShareRecord on the meeting. */
export async function shareToDocs(
  meeting: Meeting, html: string, opts: { link?: boolean } = {}, deps: GoogleDeps = {},
): Promise<{ meeting: Meeting; record: ShareRecord }> {
  const prev = gdocsShare(meeting);
  const doc = await saveDoc(meeting.title, html, prev ? docIdOf(prev.url) : undefined, deps);
  if (opts.link) await makeLinkShared(doc.id, deps);
  const linkShared = opts.link || (prev?.linkShared && docIdOf(prev.url) === doc.id);
  const record: ShareRecord = { kind: 'gdocs', url: doc.url, at: Date.now(), ...(linkShared ? { linkShared: true } : {}) };
  const next: Meeting = { ...meeting, shares: [...(meeting.shares ?? []).filter((s) => s.kind !== 'gdocs'), record] };
  await putMeeting(next);
  return { meeting: next, record };
}

/** Link only: when the doc already exists, just open the link; otherwise save it first. */
export async function shareLink(
  meeting: Meeting, html: string, deps: GoogleDeps = {},
): Promise<{ meeting: Meeting; record: ShareRecord }> {
  const prev = gdocsShare(meeting);
  const id = prev && docIdOf(prev.url);
  if (prev && id) {
    if (!prev.linkShared) await makeLinkShared(id, deps);
    const record: ShareRecord = { ...prev, linkShared: true };
    const next: Meeting = { ...meeting, shares: (meeting.shares ?? []).map((s) => (s === prev ? record : s)) };
    await putMeeting(next);
    return { meeting: next, record };
  }
  return shareToDocs(meeting, html, { link: true }, deps);
}
