import { describe, expect, it } from 'vitest';
import { canResumeShare } from './Share';

describe('canResumeShare', () => {
  it('does not resume docs/link when Google Docs is still not connected (Back / Not now)', () => {
    expect(canResumeShare('save', { googleDocs: false })).toBe(false);
    expect(canResumeShare('link', { googleDocs: false })).toBe(false);
  });
  it('resumes docs/link once connected', () => {
    expect(canResumeShare('save', { googleDocs: true })).toBe(true);
    expect(canResumeShare('link', { googleDocs: true })).toBe(true);
  });
  it('resumes notion only with both a token and a page', () => {
    expect(canResumeShare('notion', { googleDocs: true })).toBe(false);
    expect(canResumeShare('notion', { googleDocs: false, notionToken: 't' })).toBe(false);
    expect(canResumeShare('notion', { googleDocs: false, notionPageId: 'p' })).toBe(false);
    expect(canResumeShare('notion', { googleDocs: false, notionToken: 't', notionPageId: 'p' })).toBe(true);
  });
});
