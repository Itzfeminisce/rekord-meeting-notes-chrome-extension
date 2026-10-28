import { getMeeting, listMarkers, listSegments, putMarker, putMeeting } from './db';
import { chat, transcriptLines, type FetchLike } from './llm';
import { getSettings } from './settings';
import type { Marker, Segment } from './types';

export const SUGGEST_INTERVAL_MS = 60_000;
export const SUGGEST_WINDOW_MS = 3 * 60_000;
export const MAX_SUGGESTIONS = 3;

export const SUGGEST_SYSTEM = [
  'You spot action items in a live meeting transcript. Reply with ONLY a JSON array, no prose, shaped as:',
  '[{"text": string, "owner"?: string, "due"?: string, "atMs": number}]',
  `Return at most ${MAX_SUGGESTIONS} items, and only clear commitments someone made to do something. Return [] when there are none.`,
  '"text" is a short imperative (for example "Draft launch email copy"). Use "You" or "Others" (or a name) as owner only when clear.',
  '"due" is free text such as "Thursday". "atMs" is the time of the line in milliseconds from the meeting start, matching its [m:ss] stamp.',
  'Do not repeat anything in the list of existing actions. Write in the language of the meeting.',
].join('\n');

export interface Suggestion { text: string; owner?: string; due?: string; atMs?: number }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** True when `text` equals, or contains / is contained in, any existing action text (case and spacing ignored). */
export function isDuplicate(text: string, existing: string[]): boolean {
  const t = norm(text);
  if (!t) return true;
  return existing.some((e) => {
    const x = norm(e);
    return x !== '' && (x === t || x.includes(t) || t.includes(x));
  });
}

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (m) return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
    if (/^\d+$/.test(v.trim())) return Number(v);
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Parses a model reply into suggestions; tolerates code fences, prose, and a {"actions": [...]} wrapper. */
export function parseSuggestions(raw: string): Suggestion[] {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data: unknown;
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a < 0 || b <= a) continue;
    try { data = JSON.parse(text.slice(a, b + 1)); break; } catch { /* try next shape */ }
  }
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    data = o.actions ?? o.suggestions ?? o.items;
  }
  if (!Array.isArray(data)) return [];
  const out: Suggestion[] = [];
  for (const it of data) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const t = str(o.text);
    if (!t) continue;
    out.push({ text: t, owner: str(o.owner), due: str(o.due), atMs: toMs(o.atMs) });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

export interface SuggestDeps { fetchFn?: FetchLike }

/**
 * One check: looks at transcript after the cursor, asks the model, saves new suggestions as markers.
 * Returns the new markers ([] if nothing to do). The cursor only moves when the model call succeeded.
 * Throws nothing: any failure leaves the cursor where it was.
 */
export async function runSuggest(meetingId: string, deps: SuggestDeps = {}): Promise<Marker[]> {
  try {
    const [settings, meeting, segments, markers] = await Promise.all([
      getSettings(), getMeeting(meetingId), listSegments(meetingId), listMarkers(meetingId),
    ]);
    if (!meeting || !settings.features.liveSuggestions) return [];
    const cursor = meeting.suggestCursorMs ?? -1;
    const fresh = segments.filter((s) => s.text.trim() && s.startMs > cursor);
    if (!fresh.length) return [];
    const latest = fresh[fresh.length - 1];
    if (!latest) return [];
    const from = latest.startMs - SUGGEST_WINDOW_MS;
    const windowSegs: Segment[] = segments.filter((s) => s.startMs >= from && s.startMs <= latest.startMs);
    const existing = markers.filter((m) => m.kind === 'action' && m.label).map((m) => m.label as string);

    const user = [
      'Existing actions:', ...(existing.length ? existing.map((t) => `- ${t}`) : ['(none)']),
      '', 'Transcript (last 3 minutes):', ...transcriptLines(windowSegs, meeting.speakers),
    ].join('\n');
    const reply = await chat(
      [{ role: 'system', content: SUGGEST_SYSTEM }, { role: 'user', content: user }],
      { json: true, maxTokens: 600 }, deps.fetchFn,
    );
    const found = parseSuggestions(reply);

    const created: Marker[] = [];
    const seen = [...existing];
    for (const s of found) {
      if (isDuplicate(s.text, seen)) continue;
      seen.push(s.text);
      const at = s.atMs !== undefined ? Math.min(latest.endMs, Math.max(from, s.atMs)) : latest.startMs;
      const m: Marker = {
        id: crypto.randomUUID(), meetingId, atMs: Math.max(0, at), kind: 'action', label: s.text,
        source: 'ai', status: 'suggested', ...(s.owner ? { owner: s.owner } : {}), ...(s.due ? { due: s.due } : {}),
      };
      await putMarker(m);
      created.push(m);
    }
    // Re-read so a concurrent meeting update (title, status) is not overwritten.
    const latestMeeting = (await getMeeting(meetingId)) ?? meeting;
    await putMeeting({ ...latestMeeting, suggestCursorMs: latest.startMs });
    return created;
  } catch (e) {
    void e;
    return [];
  }
}

export interface SuggesterOptions {
  meetingId: string;
  /** True when the connection is healthy; runs are skipped otherwise. */
  isOk: () => boolean;
  onNew: (markers: Marker[]) => void;
  intervalMs?: number;
  fetchFn?: FetchLike;
}

/** Runs `runSuggest` every minute (skipping while unhealthy or a run is in flight). Returns a stop function. */
export function startSuggester(o: SuggesterOptions): () => void {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped || !o.isOk()) return;
    busy = true;
    try {
      const made = await runSuggest(o.meetingId, { fetchFn: o.fetchFn });
      if (!stopped && made.length) o.onNew(made);
    } finally { busy = false; }
  };
  const t = setInterval(tick, o.intervalMs ?? SUGGEST_INTERVAL_MS);
  return () => { stopped = true; clearInterval(t); };
}

/** Saves the user's decision on a suggestion (with any edits to its text, owner or due). */
export async function resolveSuggestion(
  m: Marker, status: 'accepted' | 'dismissed', edits: { label?: string; owner?: string; due?: string } = {},
): Promise<Marker> {
  const next: Marker = { ...m, ...edits, label: edits.label?.trim() || m.label, status };
  await putMarker(next);
  return next;
}

/** Counts for the Live footer. */
export function suggestionCounts(markers: Marker[]): { added: number; waiting: number } {
  let added = 0, waiting = 0;
  for (const m of markers) {
    if (m.kind !== 'action') continue;
    if (m.source !== 'ai' || m.status === 'accepted') added++;
    else if (m.status === 'suggested') waiting++;
  }
  return { added, waiting };
}
