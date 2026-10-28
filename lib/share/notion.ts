/**
 * Notion: validate an internal integration secret, list the pages it can see, and share a meeting as a child page.
 * The secret is only ever sent as a bearer token to api.notion.com; it is never logged or stored here.
 */
import { buildSections, dateLine, DEFAULT_OPTIONS, type ExportOptions } from '../export';
import { putMeeting } from '../db';
import type { Marker, Meeting, Note, Segment, ShareRecord } from '../types';

export const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';
export const NOTION_INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations';
export const NOTION_ADD_CONNECTIONS_URL = 'https://www.notion.com/help/add-and-manage-connections-with-the-api';

export type NotionErrorCode = 'auth' | 'offline' | 'rate-limited' | 'server' | 'no-access';

const MESSAGES: Record<NotionErrorCode, string> = {
  auth: 'Notion didn’t accept that secret. Check you copied all of it, then try again.',
  offline: 'Rekord couldn’t reach Notion. Check your connection and try again.',
  'rate-limited': 'Notion is busy right now. Try again in a moment.',
  server: 'Notion had a problem. Try again in a moment.',
  'no-access': 'Rekord can’t see that page anymore. Choose a page again.',
};

export class NotionError extends Error {
  constructor(readonly code: NotionErrorCode, readonly status?: number) {
    super(MESSAGES[code]);
    this.name = 'NotionError';
  }
}

export interface NotionDeps { fetch?: typeof fetch }

async function call(token: string, path: string, init: RequestInit = {}, deps: NotionDeps = {}): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new NotionError('offline');
  }
  if (res.status === 401) throw new NotionError('auth', 401);
  if (res.status === 403 || res.status === 404) throw new NotionError('no-access', res.status);
  if (res.status === 429) throw new NotionError('rate-limited', 429);
  if (!res.ok) throw new NotionError('server', res.status);
  return res.json().catch(() => ({}));
}

/** Checks the secret with GET /v1/users/me; resolves to the integration's name. */
export async function validateSecret(token: string, deps: NotionDeps = {}): Promise<{ name: string }> {
  const me = (await call(token, '/users/me', {}, deps)) as { name?: string };
  return { name: me.name ?? 'Rekord' };
}

export interface NotionPageInfo { id: string; title: string; parent?: 'Team space' | 'Private' }

interface RawPage {
  id: string; url?: string; archived?: boolean;
  parent?: { type?: string };
  properties?: Record<string, { type?: string; title?: { plain_text?: string }[] }>;
}

export function pageTitle(p: RawPage): string {
  const prop = Object.values(p.properties ?? {}).find((x) => x.type === 'title');
  return (prop?.title ?? []).map((t) => t.plain_text ?? '').join('').trim() || 'Untitled';
}

/** Parent kind is only shown when Notion tells us: top-level pages are "Private", teamspace pages "Team space". */
export function parentKind(type?: string): NotionPageInfo['parent'] {
  if (type === 'workspace') return 'Private';
  if (type === 'teamspace' || type === 'team_space') return 'Team space';
  return undefined;
}

/** Pages the integration can see (POST /v1/search, object=page), following pagination up to `max`. */
export async function searchPages(token: string, deps: NotionDeps = {}, max = 100): Promise<NotionPageInfo[]> {
  const out: NotionPageInfo[] = [];
  let cursor: string | undefined;
  do {
    const body = { filter: { property: 'object', value: 'page' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = (await call(token, '/search', { method: 'POST', body: JSON.stringify(body) }, deps)) as
      { results?: RawPage[]; has_more?: boolean; next_cursor?: string | null };
    for (const p of res.results ?? []) {
      if (p.archived) continue;
      const parent = parentKind(p.parent?.type);
      out.push({ id: p.id, title: pageTitle(p), ...(parent ? { parent } : {}) });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor && out.length < max);
  return out;
}

// ---- blocks ----

export type NotionBlock = { object: 'block'; type: string; [k: string]: unknown };
const MAX_TEXT = 2000;
const MAX_BLOCKS = 100;

const rich = (text: string) => [{ type: 'text', text: { content: text } }];

function chunkText(text: string): string[] {
  if (text.length <= MAX_TEXT) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_TEXT) out.push(text.slice(i, i + MAX_TEXT));
  return out;
}

const block = (type: string, extra: Record<string, unknown> = {}, text = ''): NotionBlock =>
  ({ object: 'block', type, [type]: { rich_text: rich(text), ...extra } });

/** The meeting as Notion blocks: headings, paragraphs, bullets, and to-dos for action items. */
export function buildBlocks(
  meeting: Meeting, segments: Segment[], notes: Note[], markers: Marker[], opts: ExportOptions = DEFAULT_OPTIONS,
): NotionBlock[] {
  const out: NotionBlock[] = [block('paragraph', {}, dateLine(meeting))];
  for (const sec of buildSections(meeting, segments, notes, markers, opts)) {
    out.push(block('heading_2', {}, sec.heading));
    const kind = sec.list ? (sec.heading === 'Action items' ? 'to_do' : 'bulleted_list_item') : 'paragraph';
    for (const line of sec.lines) {
      for (const part of chunkText(line)) out.push(block(kind, kind === 'to_do' ? { checked: false } : {}, part));
    }
  }
  return out;
}

export const idOfUrl = (url: string): string | undefined => /([0-9a-f]{32})(?:[?#]|$)/i.exec(url.replace(/-/g, ''))?.[1];

async function appendBlocks(token: string, pageId: string, blocks: NotionBlock[], deps: NotionDeps) {
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS) {
    await call(token, `/blocks/${pageId}/children`, { method: 'PATCH', body: JSON.stringify({ children: blocks.slice(i, i + MAX_BLOCKS) }) }, deps);
  }
}

async function clearBlocks(token: string, pageId: string, deps: NotionDeps) {
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const res = (await call(token, `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`, {}, deps)) as
      { results?: { id: string }[]; has_more?: boolean; next_cursor?: string | null };
    ids.push(...(res.results ?? []).map((b) => b.id));
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  for (const id of ids) await call(token, `/blocks/${id}`, { method: 'DELETE' }, deps);
}

export const notionShare = (meeting: Meeting): ShareRecord | undefined => meeting.shares?.find((s) => s.kind === 'notion');

/**
 * Creates a child page of `parentId` with the meeting's blocks. When the meeting was shared before, that same
 * page gets its title and content replaced instead; if it was deleted in Notion, a new page is made.
 */
export async function shareToNotion(
  token: string, parentId: string, meeting: Meeting, blocks: NotionBlock[], deps: NotionDeps = {},
): Promise<{ meeting: Meeting; record: ShareRecord }> {
  const prev = notionShare(meeting);
  const prevId = prev && idOfUrl(prev.url);
  let url: string | undefined;
  if (prevId) {
    try {
      const page = (await call(token, `/pages/${prevId}`, { method: 'PATCH', body: JSON.stringify({
        archived: false, properties: { title: { title: rich(meeting.title) } },
      }) }, deps)) as RawPage;
      await clearBlocks(token, prevId, deps);
      await appendBlocks(token, prevId, blocks, deps);
      url = page.url ?? prev.url;
    } catch (err) {
      if (!(err instanceof NotionError) || err.code !== 'no-access') throw err;
    }
  }
  if (!url) {
    const page = (await call(token, '/pages', { method: 'POST', body: JSON.stringify({
      parent: { page_id: parentId },
      properties: { title: { title: rich(meeting.title) } },
      children: blocks.slice(0, MAX_BLOCKS),
    }) }, deps)) as RawPage;
    if (!page.id || !page.url) throw new NotionError('server');
    await appendBlocks(token, page.id, blocks.slice(MAX_BLOCKS), deps);
    url = page.url;
  }
  const record: ShareRecord = { kind: 'notion', url, at: Date.now() };
  const next: Meeting = { ...meeting, shares: [...(meeting.shares ?? []).filter((s) => s.kind !== 'notion'), record] };
  await putMeeting(next);
  return { meeting: next, record };
}
