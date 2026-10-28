import { describe, expect, it } from 'vitest';
import { needsTabGrant, tabRefusedReply, TAB_GRANT_HINT } from './capture';

describe('needsTabGrant', () => {
  it('asks for the icon click when the tab is on and its url is hidden', () => {
    expect(needsTabGrant({ tabOn: true, tabUrl: undefined })).toBe(true);
    expect(needsTabGrant({ tabOn: true, tabUrl: '' })).toBe(true);
  });
  it('stays quiet once the tab is granted', () => {
    expect(needsTabGrant({ tabOn: true, tabUrl: 'https://meet.google.com/abc-defg-hij' })).toBe(false);
  });
  it('never shows for mic only', () => {
    expect(needsTabGrant({ tabOn: false, tabUrl: undefined })).toBe(false);
  });
});

describe('tabRefusedReply', () => {
  it('tells the user how to grant the tab, with a curly apostrophe', () => {
    expect(tabRefusedReply()).toEqual({
      ok: false,
      error: 'Click the Rekord icon in the toolbar while you’re on the meeting tab, then press Start.',
    });
    expect(TAB_GRANT_HINT).not.toContain("'");
  });
});
