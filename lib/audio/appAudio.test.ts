import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  APP_DISPLAY_OPTIONS, AppAudioController, appLabel, appName, audioOnly, endedBanner, pickAppAudio, SILENCE_MS, SilenceWatch,
  type AppAudioDeps, type PickResult,
} from './appAudio';

class FakeTrack extends EventTarget {
  stopped = false;
  constructor(public kind: 'audio' | 'video') { super(); }
  stop() { this.stopped = true; }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter((x) => x !== t); }
}

const stream = (...kinds: ('audio' | 'video')[]) => new FakeStream(kinds.map((k) => new FakeTrack(k))) as unknown as MediaStream;

describe('audioOnly', () => {
  it('stops the video at once and keeps the audio', () => {
    const s = stream('video', 'audio');
    const video = s.getVideoTracks()[0] as unknown as FakeTrack;
    expect(audioOnly(s)).toBe(s);
    expect(video.stopped).toBe(true);
    expect(s.getTracks().map((t) => t.kind)).toEqual(['audio']);
  });
  it('returns null and stops everything when no audio was shared', () => {
    const s = stream('video');
    const video = s.getVideoTracks()[0] as unknown as FakeTrack;
    expect(audioOnly(s)).toBeNull();
    expect(video.stopped).toBe(true);
  });
});

describe('pickAppAudio', () => {
  it('asks for the screen with system audio included', async () => {
    const gdm = vi.fn(async () => stream('video', 'audio'));
    expect((await pickAppAudio(gdm)).kind).toBe('audio');
    expect(gdm).toHaveBeenCalledWith(APP_DISPLAY_OPTIONS);
    expect(APP_DISPLAY_OPTIONS).toEqual({ video: true, audio: true, systemAudio: 'include' });
  });
  it('reports no audio, a cancelled picker and other failures', async () => {
    expect((await pickAppAudio(async () => stream('video'))).kind).toBe('no-audio');
    expect((await pickAppAudio(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); })).kind).toBe('cancelled');
    expect((await pickAppAudio(async () => { throw new Error('boom'); })).kind).toBe('error');
  });
});

describe('SilenceWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const run = (watch: SilenceWatch, ms: number, others: number, mic: number) => {
    for (let t = 0; t < ms; t += 125) {
      vi.advanceTimersByTime(125);
      watch.update(others, mic);
    }
  };

  it('fires once after 10 s of meeting silence while the mic has sound', () => {
    const onSilent = vi.fn();
    const watch = new SilenceWatch(onSilent);
    watch.update(0, 0.5);
    run(watch, SILENCE_MS - 250, 0, 0.5);
    expect(onSilent).not.toHaveBeenCalled();
    run(watch, 500, 0, 0.5);
    expect(onSilent).toHaveBeenCalledTimes(1);
    run(watch, 20_000, 0, 0.5);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });
  it('stays quiet while nobody talks, or when the meeting makes sound', () => {
    const onSilent = vi.fn();
    const watch = new SilenceWatch(onSilent);
    run(watch, 30_000, 0, 0);
    expect(onSilent).not.toHaveBeenCalled();
    watch.reset();
    for (let i = 0; i < 8; i++) {
      run(watch, 6_000, 0, 0.5);
      watch.update(0.4, 0.5); // the meeting speaks: a new stretch starts
    }
    expect(onSilent).not.toHaveBeenCalled();
  });
  it('starts over after a reset (Share again)', () => {
    const onSilent = vi.fn();
    const watch = new SilenceWatch(onSilent);
    run(watch, SILENCE_MS + 125, 0, 0.5);
    watch.reset();
    run(watch, SILENCE_MS + 125, 0, 0.5);
    expect(onSilent).toHaveBeenCalledTimes(2);
  });
});

describe('app names', () => {
  it('uses the calendar event when present, else "the meeting app"', () => {
    expect(appName({ app: 'zoom' })).toBe('Zoom');
    expect(appName(undefined)).toBe('the meeting app');
    expect(appLabel({})).toBeUndefined();
    expect(endedBanner('Zoom')).toEqual({ title: 'Rekord can’t hear Zoom anymore', body: 'Sharing was stopped. Your microphone is still recording.' });
  });
});

describe('AppAudioController', () => {
  beforeEach(() => fakeBrowser.reset());

  function setup(picks: PickResult[]) {
    const sender = { open: vi.fn(async () => undefined), replace: vi.fn(async () => undefined), close: vi.fn() };
    const deps: AppAudioDeps = {
      pick: vi.fn(async () => picks.shift() ?? { kind: 'cancelled' as const }),
      connectPort: vi.fn(() => ({}) as ReturnType<AppAudioDeps['connectPort']>),
      createSender: vi.fn(() => sender),
    };
    return { c: new AppAudioController(deps), sender };
  }

  it('turns a track ending mid-meeting into the "ended" banner state and tells the others', async () => {
    const s = stream('audio');
    const { c, sender } = setup([{ kind: 'audio', stream: s }]);
    const sent = vi.spyOn(fakeBrowser.runtime, 'sendMessage');
    expect(await c.pick()).toBe('audio');
    await c.connect();
    expect(c.status).toBe('on');
    expect(sender.open).toHaveBeenCalledWith(s.getAudioTracks()[0]);
    (s.getAudioTracks()[0] as unknown as FakeTrack).dispatchEvent(new Event('ended'));
    expect(c.status).toBe('ended');
    expect(sent).toHaveBeenCalledWith({ type: 'app-audio/ended' });
  });

  it('Share again swaps the track in the same meeting and resumes', async () => {
    const first = stream('audio');
    const second = stream('audio');
    const { c, sender } = setup([{ kind: 'audio', stream: first }, { kind: 'audio', stream: second }]);
    await c.pick();
    await c.connect();
    (first.getAudioTracks()[0] as unknown as FakeTrack).dispatchEvent(new Event('ended'));
    expect(await c.shareAgain()).toBe('audio');
    expect(sender.replace).toHaveBeenCalledWith(second.getAudioTracks()[0]);
    expect(c.status).toBe('on');
  });

  it('no audio shared → silent (V3NoSound); keep going with the mic stops asking', async () => {
    const { c, sender } = setup([{ kind: 'no-audio' }]);
    expect(await c.pick()).toBe('no-audio');
    await c.connect();
    expect(c.status).toBe('silent');
    await c.micOnly();
    expect(c.status).toBe('mic-only');
    expect(sender.replace).toHaveBeenCalledWith(null);
    c.silent();
    expect(c.status).toBe('mic-only');
  });

  it('a silence report only moves a hearing meeting to silent, and end stops sharing', async () => {
    const s = stream('audio');
    const { c, sender } = setup([{ kind: 'audio', stream: s }]);
    await c.pick();
    await c.connect();
    c.silent();
    expect(c.status).toBe('silent');
    c.end();
    expect(c.status).toBe('off');
    expect(sender.close).toHaveBeenCalled();
    expect((s.getAudioTracks()[0] as unknown as FakeTrack).stopped).toBe(true);
  });
});
