import { describe, expect, it } from 'vitest';
import { dateLabel, groupMeetings, matchesQuery, matchIds, openActions, splitMatches, transcriptToText } from './library';
import { buildTimeline } from './live';
import type { Meeting, Segment } from './types';

const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const mt = (id: string, daysAgo: number, extra: Partial<Meeting> = {}): Meeting => ({
  id, title: id, startedAt: NOW - daysAgo * 86_400_000, status: 'done', language: 'en', ...extra,
});
const seg = (id: string, startMs: number, text: string, speaker: Segment['speaker'] = 'you'): Segment => ({
  id, meetingId: 'm', speaker, startMs, endMs: startMs + 1000, text, chunkId: id,
});

describe('library', () => {
  it('labels dates', () => {
    expect(dateLabel(NOW - 1000, NOW)).toBe('Today');
    expect(dateLabel(NOW - 86_400_000, NOW)).toBe('Yesterday');
    expect(dateLabel(new Date(2026, 9, 21).getTime(), NOW)).toBe('Oct 21');
  });
  it('groups newest first', () => {
    const g = groupMeetings([mt('old', 20), mt('new', 0), mt('mid', 3)], NOW);
    expect(g.map((x) => x.label)).toEqual(['This week', 'Earlier']);
    expect(g[0]!.meetings.map((m) => m.id)).toEqual(['new', 'mid']);
    expect(groupMeetings([], NOW)).toEqual([]);
  });
  it('searches title and transcript', () => {
    const m = mt('Weekly sync', 0);
    expect(matchesQuery(m, 'we talked Pricing', 'pricing')).toBe(true);
    expect(matchesQuery(m, '', 'weekly')).toBe(true);
    expect(matchesQuery(m, 'x', 'zzz')).toBe(false);
    expect(matchesQuery(m, undefined, '  ')).toBe(true);
  });
  it('counts open actions', () => {
    expect(openActions(mt('a', 0))).toBe(0);
    const s = { overview: '', decisions: [], questions: [], generatedAt: 0, model: 'x', actions: [{ text: 'a' }, { text: 'b' }] };
    expect(openActions(mt('a', 0, { summary: s }))).toBe(2);
  });
  it('splits matches', () => {
    expect(splitMatches('On pricing and Pricing', 'pricing')).toEqual([
      { text: 'On ', hit: false }, { text: 'pricing', hit: true }, { text: ' and ', hit: false }, { text: 'Pricing', hit: true },
    ]);
    expect(splitMatches('abc', '')).toEqual([{ text: 'abc', hit: false }]);
  });
  it('finds matches and builds copy text', () => {
    const items = buildTimeline(
      [seg('a', 0, 'hello'), seg('b', 65000, 'the pricing plan', 'others')],
      [{ id: 'n', meetingId: 'm', atMs: 70000, text: 'ask about pricing', createdAt: 0 }],
      [],
    );
    expect(matchIds(items, 'pricing')).toEqual(['b', 'n']);
    expect(transcriptToText(items)).toBe('[0:00] You: hello\n[1:05] Others: the pricing plan\n[1:10] Your note: ask about pricing');
  });
});
