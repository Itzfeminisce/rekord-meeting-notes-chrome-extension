import { describe, expect, it, vi } from 'vitest';
import {
  askAll, attendeeLine, BUDGET_CHARS, filterByRange, parseSources, pickContext, queryWords, rankCandidates, scoreMeeting, stripCitations, type MeetingData,
} from './askAll';
import { DEFAULT_SETTINGS } from './settings';
import type { Meeting, Segment } from './types';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const meeting = (id: string, ageDays: number, over: Partial<Meeting> = {}): Meeting => ({
  id, title: id, startedAt: NOW - ageDays * DAY, endedAt: NOW - ageDays * DAY + 1000, status: 'done', language: 'en', ...over,
});
const seg = (meetingId: string, startMs: number, text: string): Segment => ({
  id: `${meetingId}${startMs}`, meetingId, speaker: 'others', startMs, endMs: startMs + 1000, text, chunkId: 'c',
});
const data = (m: Meeting, texts: [number, string][] = []): MeetingData => ({
  meeting: m, segments: texts.map(([ms, t]) => seg(m.id, ms, t)), notes: [],
});
const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('filterByRange', () => {
  const ms = [meeting('a', 2), meeting('b', 20), meeting('c', 60), meeting('d', 1, { status: 'recording' })];
  it('keeps finished meetings inside the range', () => {
    expect(filterByRange(ms, '7', NOW).map((m) => m.id)).toEqual(['a']);
    expect(filterByRange(ms, '30', NOW).map((m) => m.id)).toEqual(['a', 'b']);
    expect(filterByRange(ms, 'all', NOW).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('scoring', () => {
  it('drops stop words and plural s', () => {
    expect(queryWords('What did we decide about pricing plans?')).toEqual(['decide', 'pricing', 'plan']);
  });
  it('scores title, summary, notes and transcript', () => {
    const s = { ...meeting('s', 1, { title: 'Pricing sync' }), summary: { overview: 'We covered pricing', decisions: [], actions: [], questions: [], generatedAt: 0, model: 'm' } };
    expect(scoreMeeting(data(s), 'pricing')).toBe(5 + 3);
    expect(scoreMeeting(data(meeting('x', 1), [[0, 'pricing is high']]), 'pricing')).toBe(1);
    expect(scoreMeeting(data(meeting('y', 1), [[0, 'lunch']]), 'pricing')).toBe(0);
  });
  it('ranks best first and drops zero scores', () => {
    const r = rankCandidates([data(meeting('low', 1), [[0, 'pricing']]), data(meeting('none', 1), [[0, 'x']]), data(meeting('hi', 5, { title: 'Pricing' }))], 'pricing');
    expect(r.map((c) => c.meeting.id)).toEqual(['hi', 'low']);
  });
});

describe('pickContext budget', () => {
  it('stays within the budget, keeping the best meetings first', () => {
    const big = 'pricing '.repeat(20);
    const ds = ['a', 'b', 'c', 'd'].map((id, i) =>
      data(meeting(id, i + 1), Array.from({ length: 12 }, (_, k) => [k * 1000, big] as [number, string])));
    const ranked = rankCandidates(ds, 'pricing');
    const { text, included } = pickContext(ranked, 'pricing', 3000);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(included.length).toBeGreaterThan(0);
    expect(text.match(/Excerpts:/g)).toHaveLength(1); // the rest fell back to summary only
    expect(included[0]?.meeting.id).toBe('a');
    expect(text).toContain('[00:00]');
    expect(BUDGET_CHARS).toBe(60_000);
  });
  it('truncates a single oversized meeting rather than dropping it', () => {
    const d = data(meeting('a', 1, { title: 'x'.repeat(500) }), [[0, 'pricing']]);
    const { text, included } = pickContext(rankCandidates([d], 'pricing'), 'pricing', 100);
    expect(included).toHaveLength(1);
    expect(text.length).toBeLessThanOrEqual(100);
  });
});

describe('citations across meetings', () => {
  const ms = [meeting('m1', 1, { title: 'Sync' }), meeting('m2', 2, { title: 'Call' })];
  it('gives one source per meeting with its first moment', () => {
    const a = 'Price stays [m1@19:12]. Annual open [m2@31:40] [m1@02:00] [ghost@01:00] [m2@1:02:03].';
    const s = parseSources(a, ms);
    expect(s.map((x) => [x.meetingId, x.atMs])).toEqual([['m1', 1152000], ['m2', 1900000]]);
    expect(s[0]?.title).toBe('Sync');
  });
  it('strips markers from the text', () => {
    expect(stripCitations('Price stays [m1@19:12]. Done [m2@31:40].')).toBe('Price stays. Done.');
  });
});

describe('askAll', () => {
  const ms = [meeting('m1', 1), meeting('m2', 3), meeting('old', 60)];
  const load = async (m: Meeting) => data(m, m.id === 'old' ? [[0, 'pricing']] : m.id === 'm1' ? [[5000, 'pricing stays']] : [[7000, 'budget']]);
  const config = { settings: DEFAULT_SETTINGS, keys: { GROQ_API_KEY: 'gsk_test' } };
  it('answers with sources and uses only meetings in range', async () => {
    const fetchFn = vi.fn(async (_u: string, _i?: RequestInit) => reply('Stays the same [m1@00:05].'));
    const r = await askAll('pricing?', '30', ms, { fetch: fetchFn, load, now: NOW, config });
    expect(r.status).toBe('answer');
    expect(r.answer).toBe('Stays the same.');
    expect(r.sources?.map((s) => s.meetingId)).toEqual(['m1']);
    const sent = String(fetchFn.mock.calls[0]?.[1]?.body);
    expect(sent).toContain('Meeting m1');
    expect(sent).not.toContain('Meeting old');
  });
  it('reports nothing found without calling the model', async () => {
    const fetchFn = vi.fn();
    const r = await askAll('unicorns', '30', ms, { fetch: fetchFn, load, now: NOW, config });
    expect(r.status).toBe('none');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('attendeeLine', () => {
  const ev = (over = {}) => ({ id: 'e', title: 't', start: 0, end: 1, attendees: [{ name: 'Me', email: 'me@x.com', self: true }, { name: 'Priya', email: 'p@x.com' }, { email: 'sam@x.com' }, { name: 'Leo', email: 'l@x.com' }], ...over });
  it('lists attendees except you', () => {
    expect(attendeeLine({ event: ev() })).toBe('With Priya, sam and Leo');
    expect(attendeeLine({})).toBeUndefined();
  });
  it('adds the app for desktop-app meetings', () => {
    expect(attendeeLine({ source: 'app', event: ev({ app: 'teams', attendees: [{ name: 'Dana', email: 'd@n.com' }] }) })).toBe('With Dana · Teams app');
  });
});
