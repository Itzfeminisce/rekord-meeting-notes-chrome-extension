import { describe, expect, it } from 'vitest';
import type { Chunk, Meeting, Message, Segment } from '@/lib/types';
import {
  GRANT_URL, HOLD_MS, LIVE_CHUNK_ID, RETRY_MS, RealtimeSession, StreamError, liveLabels, liveSpeakerCount, listenUrl,
  mintToken, parseResult, requestToken, supersede, toSegments, tokenReply, wantsRealtime, type SocketLike, type StreamDeps,
} from './stream';

const KEY = 'dg_test';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('token grant', () => {
  it('posts to /v1/auth/grant with "Token <key>" and returns the JWT', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json({ access_token: 'jwt-1', expires_in: 30 });
    }) as unknown as typeof fetch;
    expect(await mintToken(KEY, fetchFn)).toBe('jwt-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GRANT_URL);
    expect(GRANT_URL).toBe('https://api.deepgram.com/v1/auth/grant');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Token ${KEY}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ttl_seconds: 30 });
  });

  it('maps failures without leaking the key', async () => {
    const status = (n: number) => (async () => json({ err: KEY }, n)) as unknown as typeof fetch;
    await expect(mintToken(KEY, status(401))).rejects.toMatchObject({ kind: 'auth' });
    await expect(mintToken(KEY, status(500))).rejects.toMatchObject({ kind: 'server' });
    const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const err = await mintToken(KEY, offline).catch((e: StreamError) => e);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).kind).toBe('offline');
    expect(String((err as StreamError).message)).not.toContain(KEY);
  });

  it('background reply and offscreen request', async () => {
    const ok = (async () => json({ access_token: 'jwt-2' })) as unknown as typeof fetch;
    expect(await tokenReply(async () => ({ DEEPGRAM_API_KEY: KEY }), ok)).toEqual({ ok: true, token: 'jwt-2' });
    expect(await tokenReply(async () => ({}), ok)).toEqual({ ok: false, reason: 'auth' });
    expect(await requestToken(async () => ({ ok: true, token: 'jwt-3' }))).toBe('jwt-3');
    await expect(requestToken(async () => ({ ok: false, reason: 'auth' }))).rejects.toMatchObject({ kind: 'auth' });
  });

  it('realtime only with Deepgram as provider and its key loaded', () => {
    const settings = { transcription: { provider: 'deepgram', model: 'nova-3' } } as never;
    expect(wantsRealtime({ settings, keys: { DEEPGRAM_API_KEY: KEY } })).toBe(true);
    expect(wantsRealtime({ settings, keys: {} })).toBe(false);
    expect(wantsRealtime({ settings: { transcription: { provider: 'groq' } } as never, keys: { DEEPGRAM_API_KEY: KEY } })).toBe(false);
  });

  it('listen URL: nova-3, interim results, smart format, diarize only for others', () => {
    const others = new URL(listenUrl('en', true));
    expect(others.origin + others.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(others.searchParams)).toEqual({ model: 'nova-3', interim_results: 'true', smart_format: 'true', language: 'en', diarize: 'true' });
    expect(new URL(listenUrl('auto', false)).searchParams.get('diarize')).toBeNull();
    expect(new URL(listenUrl('auto', false)).searchParams.get('language')).toBe('multi');
  });
});

const result = (start: number, duration: number, words: [string, number, number, number?][], final: boolean) => JSON.stringify({
  type: 'Results', is_final: final, start, duration,
  channel: { alternatives: [{ transcript: words.map((w) => w[0]).join(' '), words: words.map(([w, s, e, spk]) => ({ word: w.toLowerCase(), punctuated_word: w, start: s, end: e, ...(spk !== undefined && { speaker: spk }) })) }] },
});

describe('interim and final results', () => {
  let n = 0;
  const ctx = (diarize: boolean) => ({ meetingId: 'm1', speaker: diarize ? 'others' as const : 'you' as const, offsetMs: 5_000, diarize, newId: () => `s${++n}` });

  it('final with diarization → one segment per speaker run, labelled A/B, in meeting time', () => {
    const r = parseResult(result(1, 3, [['Hello', 1, 1.5, 0], ['there.', 1.5, 2, 0], ['Hi!', 2.2, 2.8, 1]], true))!;
    const segs = toSegments(r, ctx(true));
    expect(segs.map((s) => [s.text, s.speakerLabel, s.startMs, s.endMs, s.chunkId, s.interim])).toEqual([
      ['Hello there.', 'A', 6_000, 7_000, LIVE_CHUNK_ID, undefined],
      ['Hi!', 'B', 7_200, 7_800, LIVE_CHUNK_ID, undefined],
    ]);
  });

  it('interim → one greyed line for the current speaker, fixed id, flagged interim', () => {
    const r = parseResult(result(1, 1, [['Agreed,', 1, 1.4, 2], ['and', 1.5, 1.7, 2]], false))!;
    const [seg] = toSegments(r, ctx(true));
    expect(seg).toMatchObject({ id: 'interim:others', interim: true, speakerLabel: 'C', text: 'Agreed, and' });
    const mic = toSegments(parseResult(result(0, 1, [['Okay', 0, 0.5]], false))!, ctx(false));
    expect(mic[0]).toMatchObject({ id: 'interim:you', speaker: 'you', interim: true });
    expect(mic[0]!.speakerLabel).toBeUndefined();
  });

  it('ignores non-results and empty transcripts', () => {
    expect(parseResult('{"type":"Metadata"}')).toBeNull();
    expect(parseResult('not json')).toBeNull();
    expect(toSegments(parseResult(result(0, 1, [], true))!, ctx(true))).toEqual([]);
  });

  it('counts distinct live speakers; a Groq chunk supersedes streamed lines it covers', () => {
    const seg = (id: string, speaker: 'you' | 'others', startMs: number, endMs: number, extra: Partial<Segment> = {}): Segment =>
      ({ id, meetingId: 'm1', speaker, startMs, endMs, text: id, chunkId: LIVE_CHUNK_ID, ...extra });
    const list = [seg('a', 'others', 0, 2_000, { speakerLabel: 'A' }), seg('b', 'others', 3_000, 5_000, { speakerLabel: 'B' }), seg('y', 'you', 3_000, 4_000)];
    expect(liveSpeakerCount(list)).toBe(3);
    const groq = { id: 'c1', meetingId: 'm1', speaker: 'others' as const, startMs: 2_500, endMs: 12_500, text: 'x', chunkId: 'c1' };
    expect(supersede(list, groq).map((s) => s.id)).toEqual(['a', 'y']);
    expect(supersede(list, list[0]!)).toBe(list);
  });
});

// ---- fakes for the session ------------------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  sent: (Blob | string)[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string, readonly protocols: string[]) {}
  send(d: Blob | string) {
    this.sent.push(d);
    if (typeof d === 'string' && d.includes('CloseStream')) queueMicrotask(() => this.onclose?.({}));
  }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  drop() { this.onclose?.({}); }
  say(start: number, duration: number, words: [string, number, number, number?][], final = true) {
    this.onmessage?.({ data: result(start, duration, words, final) });
  }
}

function harness(opts: { backup?: boolean; tokens?: (string | Error)[] } = {}) {
  let t = 1_000_000;
  const startedAt = t;
  const sockets: FakeSocket[] = [];
  const emitted: Message[] = [];
  const segments = new Map<string, Segment>();
  const chunks = new Map<string, Chunk>();
  const enqueued: string[] = [];
  let timers: { fn: () => void; at: number; id: number }[] = [];
  let tid = 0;
  let ids = 0;
  const tokens = opts.tokens ?? [];
  const deps: StreamDeps = {
    getToken: async () => {
      const next = tokens.shift() ?? 'jwt';
      if (next instanceof Error) throw next;
      return next;
    },
    openSocket: (url, protocols) => { const s = new FakeSocket(url, protocols); sockets.push(s); return s; },
    saveSegment: async (s) => { segments.set(s.id, s); },
    deleteSegment: async (id) => { segments.delete(id); },
    putChunk: async (c) => { chunks.set(c.id, c); },
    enqueue: (id) => enqueued.push(id),
    emit: (m) => emitted.push(m),
    now: () => t,
    isOnline: () => true,
    setTimer: (fn, ms) => { const id = ++tid; timers.push({ fn, at: t + ms, id }); return id; },
    clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
    newId: () => `seg${++ids}`,
  };
  const session = new RealtimeSession({ meetingId: 'm1', startedAt, language: 'en', backup: opts.backup ?? true }, deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const advance = async (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) {
      timers = timers.filter((x) => x !== due);
      due.fn();
    }
    await flush();
  };
  const at = (ms: number) => advance(startedAt + ms - t);
  const chunk = (id: string, startMs: number, endMs: number, speaker: 'you' | 'others' = 'others'): Chunk =>
    ({ id, meetingId: 'm1', speaker, startMs, endMs, mimeType: 'audio/webm', audio: new Blob([id]), status: 'pending', attempts: 0 });
  const states = () => emitted.filter((m): m is Extract<Message, { type: 'stream/state' }> => m.type === 'stream/state').map((m) => m.state);
  const audio = { stops: 0 };
  const startAudio = (onData: (b: Blob) => void) => { onData(new Blob(['a'])); return () => { audio.stops++; }; };
  return { session, sockets, emitted, segments, chunks, enqueued, advance, at, chunk, states, flush, audio, startAudio };
}

describe('RealtimeSession', () => {
  it('opens one socket per speaker with a fresh token as the bearer subprotocol', async () => {
    const h = harness({ tokens: ['jwt-a', 'jwt-b'] });
    h.session.addTrack('others', h.startAudio);
    h.session.addTrack('you', h.startAudio);
    await h.flush();
    expect(h.sockets.map((s) => s.protocols)).toEqual([['bearer', 'jwt-a'], ['bearer', 'jwt-b']]);
    expect(new URL(h.sockets[0]!.url).searchParams.get('diarize')).toBe('true');
    expect(new URL(h.sockets[1]!.url).searchParams.get('diarize')).toBeNull();
    h.sockets.forEach((s) => s.open());
    expect(h.states()).toEqual(['live']);
    expect(h.sockets[0]!.sent[0]).toBeInstanceOf(Blob);
  });

  it('interim lines are emitted but never stored; finals are stored; covered chunks are done without Groq', async () => {
    const h = harness();
    h.session.addTrack('others', h.startAudio);
    await h.flush();
    h.sockets[0]!.open();
    h.sockets[0]!.say(0, 1, [['Okay', 0.2, 0.6, 0]], false);
    await h.flush();
    expect(h.segments.size).toBe(0);
    expect(h.emitted.at(-1)).toMatchObject({ type: 'segment/added', segment: { interim: true, text: 'Okay' } });
    const gated = h.session.saveChunk(h.chunk('c1', 0, 10_000));
    await gated;
    await h.flush();
    expect(h.chunks.size).toBe(0); // held until finals cover it
    h.sockets[0]!.say(0, 10.2, [['Okay,', 0.2, 0.6, 0], ['decided.', 0.7, 1.2, 0]]);
    await h.flush();
    expect([...h.segments.values()].map((s) => [s.text, s.speakerLabel])).toEqual([['Okay, decided.', 'A']]);
    expect(h.chunks.get('c1')).toMatchObject({ status: 'done' });
    expect(h.chunks.get('c1')!.audio).toBeUndefined();
    expect(h.enqueued).toEqual([]);
    // the interim was cleared when the final came
    expect(h.emitted.some((m) => m.type === 'segment/added' && m.segment.interim && m.segment.text === '')).toBe(true);
  });

  it('drop → backup → Groq from the drop → reconnect after 30 s → live again, no gaps or duplicates', async () => {
    const h = harness();
    h.session.addTrack('others', h.startAudio);
    await h.flush();
    const s1 = h.sockets[0]!;
    s1.open();
    // 0–10 s streamed and covered.
    s1.say(0, 10, [['One.', 1, 2, 0]]);
    await h.flush();
    await h.at(10_000);
    await h.session.saveChunk(h.chunk('c1', 0, 10_000));
    await h.flush();
    expect(h.chunks.get('c1')!.status).toBe('done');
    // 10–20 s: a final at 11 s, then the socket drops at 14 s; the chunk is held, then goes to Groq whole.
    s1.say(10, 2, [['Two.', 11, 11.5, 0]]);
    await h.flush();
    expect([...h.segments.values()].map((s) => s.text)).toEqual(['One.', 'Two.']);
    await h.at(14_000);
    s1.drop();
    await h.flush();
    expect(h.states()).toEqual(['live', 'backup']);
    await h.at(20_000);
    await h.session.saveChunk(h.chunk('c2', 10_000, 20_000));
    await h.flush();
    expect(h.chunks.get('c2')).toMatchObject({ status: 'pending' });
    expect(h.enqueued).toEqual(['c2']);
    // the streamed "Two." lies inside c2: removed so Groq's text for c2 doesn't repeat it
    expect([...h.segments.values()].map((s) => s.text)).toEqual(['One.']);
    // 30 s after the drop a new socket opens with a new token.
    await h.at(44_000);
    expect(h.sockets).toHaveLength(2);
    const s2 = h.sockets[1]!;
    expect(s2.protocols[0]).toBe('bearer');
    await h.at(45_000);
    s2.open();
    expect(h.states()).toEqual(['live', 'backup', 'live']);
    // the chunk that straddles the reconnect (40–50 s) goes to Groq; streamed words inside it are dropped
    s2.say(0, 2, [['Three.', 0.5, 1, 0]]); // 45.5 s
    await h.flush();
    await h.at(50_000);
    await h.session.saveChunk(h.chunk('c4', 40_000, 50_000));
    await h.flush();
    expect(h.chunks.get('c4')!.status).toBe('pending');
    s2.say(2, 1, [['Late.', 2.2, 2.6, 0]]); // 47.2 s, arrives after c4 went to Groq: not stored
    await h.flush();
    expect([...h.segments.values()].map((s) => s.text)).toEqual(['One.']);
    // 50–60 s is streamed again.
    s2.say(5, 10, [['Four.', 6, 7, 0]]); // 51–52 s, finals reach 60 s
    await h.flush();
    await h.at(60_000);
    await h.session.saveChunk(h.chunk('c5', 50_000, 60_000));
    await h.flush();
    expect(h.chunks.get('c5')!.status).toBe('done');
    expect(h.enqueued).toEqual(['c2', 'c4']);
    // Coverage check: every stored line lies in a streamed chunk, and Groq chunks hold no stored lines.
    const groq = ['c2', 'c4'].map((id) => h.chunks.get(id)!);
    for (const s of h.segments.values()) {
      const m = (s.startMs + s.endMs) / 2;
      expect(groq.some((c) => m >= c.startMs && m < c.endMs)).toBe(false);
    }
    expect([...h.segments.values()].map((s) => s.text)).toEqual(['One.', 'Four.']);
    expect(await h.session.stop()).toBe(true);
    expect(h.states().at(-1)).toBe('off');
  });

  it('"Try real time again" reconnects at once; a held chunk falls back to Groq after the hold time', async () => {
    const h = harness({ tokens: [new StreamError('auth', 'HTTP 401'), 'jwt-ok'] });
    h.session.addTrack('you', h.startAudio);
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.states()).toEqual(['backup']);
    h.session.retry();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.open();
    expect(h.states()).toEqual(['backup', 'live']);
    await h.at(10_000);
    await h.session.saveChunk(h.chunk('c1', 0, 10_000, 'you')); // no finals arrive
    await h.advance(HOLD_MS);
    expect(h.chunks.get('c1')!.status).toBe('pending');
    expect(h.enqueued).toEqual(['c1']);
  });

  it('backup off: shows the connection-lost state and never sends chunks to Groq', async () => {
    const h = harness({ backup: false });
    h.session.addTrack('others', h.startAudio);
    await h.flush();
    h.sockets[0]!.open();
    h.sockets[0]!.drop();
    await h.flush();
    expect(h.states()).toEqual(['live', 'off']);
    expect(h.emitted.find((m) => m.type === 'connection/state')).toMatchObject({ state: { ok: false, reason: 'server' } });
    await h.session.saveChunk(h.chunk('c1', 0, 10_000));
    await h.flush();
    expect(h.chunks.get('c1')!.status).toBe('failed');
    expect(h.enqueued).toEqual([]);
    await h.advance(RETRY_MS);
    h.sockets[1]!.open();
    expect(h.emitted.at(-1)).toMatchObject({ type: 'connection/state', state: { ok: true } });
  });

  it('stop flushes the socket (CloseStream) and settles the last chunk', async () => {
    const h = harness();
    h.session.addTrack('you', h.startAudio);
    await h.flush();
    const s = h.sockets[0]!;
    s.open();
    await h.at(4_000);
    await h.session.saveChunk(h.chunk('last', 0, 4_000, 'you'));
    const send = s.send.bind(s);
    s.send = (d) => {
      if (typeof d === 'string') s.say(0, 3.6, [['Bye.', 1, 1.5]]); // last final arrives on CloseStream
      send(d);
    };
    expect(await h.session.stop()).toBe(true);
    expect(s.sent.some((d) => typeof d === 'string' && d.includes('CloseStream'))).toBe(true);
    expect(h.audio.stops).toBe(1);
    expect(h.chunks.get('last')!.status).toBe('done');
  });
});

describe('liveLabels', () => {
  it('names step uses the live labels (no diarization pass)', async () => {
    let saved: Meeting | undefined;
    const meeting = { id: 'm1', speakers: { A: { name: 'Priya' } } } as unknown as Meeting;
    const segs = [
      { speaker: 'others', speakerLabel: 'B' }, { speaker: 'others', speakerLabel: 'A' }, { speaker: 'you' },
    ] as Segment[];
    const labels = await liveLabels('m1', { getMeeting: async () => meeting, listSegments: async () => segs, putMeeting: async (m) => { saved = m; } });
    expect(labels).toEqual(['A', 'B']);
    expect(saved!.speakers).toEqual({ A: { name: 'Priya' }, B: {} });
  });
});
