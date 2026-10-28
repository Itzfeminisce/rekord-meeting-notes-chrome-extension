import { describe, expect, it } from 'vitest';
import { appSources, captureSources, needsTabGrant, tabRefusedReply, TAB_GRANT_HINT } from './capture';

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

describe('captureSources (v3 "Where is the meeting?")', () => {
  it('in this tab records the tab, with the mic as chosen', () => {
    expect(captureSources('tab', true)).toEqual({ sources: { mic: true, tab: true }, app: false });
    expect(captureSources('tab', false)).toEqual({ sources: { mic: false, tab: true }, app: false });
  });
  it('in an app records the shared audio instead of the tab', () => {
    expect(captureSources('app', true)).toEqual({ sources: { mic: true, tab: false }, app: true });
    expect(captureSources('app', false)).toEqual({ sources: { mic: false, tab: false }, app: true });
  });
  it('keeps the mic on when the app shared no audio', () => {
    expect(captureSources('app', false, false)).toEqual({ sources: { mic: true, tab: false }, app: true });
  });
});

describe('appSources', () => {
  it('never captures the tab for an app start and never forces it back on', () => {
    expect(appSources({ app: true, sources: { mic: false } })).toEqual({ mic: false, tab: false });
    expect(appSources({ app: true })).toEqual({ mic: true, tab: false });
    expect(appSources({ sources: { mic: true } })).toBeNull();
  });
});
