import { describe, expect, it } from 'vitest';
import { MAILTO_BODY_LIMIT, parseInclude, printUrl, toMailto, toMarkdown, DEFAULT_OPTIONS } from './export';
import type { Meeting } from './types';

const meeting: Meeting = {
  id: 'm1', title: 'Weekly sync', startedAt: Date.UTC(2026, 0, 5, 10), endedAt: Date.UTC(2026, 0, 5, 10, 42), status: 'done', language: 'en',
  summary: { overview: 'We planned the launch.', decisions: ['Ship Friday'], actions: [{ text: 'Write notes', owner: 'Sam' }, { text: 'Book room' }], questions: ['Budget?'], generatedAt: 1, model: 'x' },
};
const segs = [{ id: 's1', meetingId: 'm1', speaker: 'you' as const, startMs: 65000, endMs: 70000, text: 'Hello there', chunkId: 'c' }];
const notes = [{ id: 'n1', meetingId: 'm1', atMs: 5000, text: 'Remember this', createdAt: 1 }];
const markers = [{ id: 'k1', meetingId: 'm1', atMs: 9000, kind: 'decision' as const, label: 'Go' }];

describe('toMarkdown', () => {
  it('includes title, summary, actions and decisions by default', () => {
    const md = toMarkdown(meeting, segs, notes, markers);
    expect(md.startsWith('# Weekly sync')).toBe(true);
    expect(md).toContain('## Summary\n\nWe planned the launch.');
    expect(md).toContain('- Write notes (Sam)');
    expect(md).toContain('- Book room');
    expect(md).toContain('## Decisions');
    expect(md).not.toContain('Transcript');
    expect(md).not.toContain('Remember this');
  });
  it('adds transcript, notes and markers when asked', () => {
    const md = toMarkdown(meeting, segs, notes, markers, { ...DEFAULT_OPTIONS, transcript: true, notes: true });
    expect(md).toContain('[1:05] You: Hello there');
    expect(md).toContain('- 0:05 Remember this');
    expect(md).toContain('- 0:09 Decision: Go');
  });
  it('works without a summary', () => {
    const md = toMarkdown({ ...meeting, summary: undefined }, segs, [], [], { ...DEFAULT_OPTIONS, transcript: true });
    expect(md).toContain('## Transcript');
    expect(md).not.toContain('## Summary');
  });
});

describe('toMailto', () => {
  it('uses the title as subject and overview, decisions, actions as body', () => {
    const { href, shortened } = toMailto(meeting);
    expect(shortened).toBe(false);
    expect(href).toContain('subject=Weekly%20sync');
    const body = decodeURIComponent(href.split("body=")[1]!);
    expect(body).toContain('We planned the launch.');
    expect(body).toContain('- Ship Friday');
    expect(body).toContain('- Write notes (Sam)');
  });
  it('truncates long bodies and says so', () => {
    const long = { ...meeting, summary: { ...meeting.summary!, overview: 'a'.repeat(3000) } };
    const { href, shortened } = toMailto(long);
    const body = decodeURIComponent(href.split("body=")[1]!);
    expect(shortened).toBe(true);
    expect(body.length).toBeLessThan(MAILTO_BODY_LIMIT + 100);
    expect(body).toContain('Shortened');
  });
});

describe('print url', () => {
  it('round-trips the include list', () => {
    const url = printUrl('m1', { ...DEFAULT_OPTIONS, transcript: true });
    const inc = new URL(url, 'https://x/').searchParams.get('include');
    expect(parseInclude(inc)).toEqual({ ...DEFAULT_OPTIONS, transcript: true });
  });
});
