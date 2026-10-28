import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  connectErrorMessage,
  connectPaste,
  connectPenv,
  ensureKeys,
  forgetAll,
  loadToken,
  loadTokenTarget,
  parseEnvPath,
  reconnect,
  optionalKeyNames,
  requiredKeyNames,
  verifyTranscriptionKey,
  checkKeys,
  pickProviders,
  saveKeyStatus,
  transcriptionKeyRejected,
  type KeyResults,
} from './connect';
import { loadKeys, saveKeys } from './keys';
import { PenvError } from './penv';
import { DEFAULT_SETTINGS, updateSettings } from './settings';

const TARGET = { org: 'acme', project: 'notes', env: 'dev' };
const penvOk = () =>
  vi.fn(async () => new Response(JSON.stringify({ keys: [{ name: 'GROQ_API_KEY', value: 'gsk_test' }] }), { status: 200 }));

describe('connect', () => {
  beforeEach(() => fakeBrowser.reset());

  it('parses org/project/env', () => {
    expect(parseEnvPath(' acme/notes/dev ')).toEqual(TARGET);
    expect(parseEnvPath('acme/notes')).toBeNull();
    expect(parseEnvPath('acme//dev')).toBeNull();
  });

  it('lists the key names the chosen providers need', () => {
    expect(requiredKeyNames(DEFAULT_SETTINGS)).toEqual(['GROQ_API_KEY']);
    expect(
      requiredKeyNames({ transcription: { provider: 'openai', model: 'whisper-1' }, summary: { provider: 'ollama', model: 'x' } }),
    ).toEqual(['OPENAI_API_KEY']);
  });

  it('connectPenv keeps token and keys in session storage only and returns names', async () => {
    const fetchImpl = penvOk();
    expect(await connectPenv('pck_test', TARGET, fetchImpl)).toEqual(['GROQ_API_KEY']);
    expect(await loadToken()).toBe('pck_test');
    expect(await loadKeys()).toEqual({ GROQ_API_KEY: 'gsk_test' });
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it('connectPaste drops blank keys', async () => {
    expect(await connectPaste({ GROQ_API_KEY: ' gsk_test ', OPENAI_API_KEY: '  ' })).toEqual(['GROQ_API_KEY']);
    expect(await loadKeys()).toEqual({ GROQ_API_KEY: 'gsk_test' });
  });

  it('connectPaste merges with keys already in memory', async () => {
    await connectPaste({ GROQ_API_KEY: 'gsk_test', DEEPGRAM_API_KEY: 'dg_test' });
    expect(await connectPaste({ GROQ_API_KEY: 'gsk_new', DEEPGRAM_API_KEY: '' })).toEqual(['DEEPGRAM_API_KEY', 'GROQ_API_KEY']);
    expect(await loadKeys()).toEqual({ GROQ_API_KEY: 'gsk_new', DEEPGRAM_API_KEY: 'dg_test' });
  });

  it('reconnect returns null without a token and refetches with one', async () => {
    expect(await reconnect(penvOk())).toBeNull();
    await fakeBrowser.storage.session.set({ penvToken: 'pck_test' });
    const fetchImpl = penvOk();
    expect(await reconnect(fetchImpl)).toEqual(['GROQ_API_KEY']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('ensureKeys reports ready or reconnect', async () => {
    expect(await ensureKeys(penvOk())).toBe('reconnect');
    await fakeBrowser.storage.session.set({ penvToken: 'pck_test' });
    expect(await ensureKeys(penvOk())).toBe('ready');
    await forgetAll();
    await fakeBrowser.storage.session.set({ penvToken: 'pck_test' });
    expect(await ensureKeys(vi.fn(async () => new Response('', { status: 401 })))).toBe('reconnect');
    expect(await loadToken()).toBe('pck_test');
  });

  it('reconnect uses the env the token was saved with, not settings.penv', async () => {
    await connectPenv('pck_test', TARGET, penvOk());
    expect(await loadTokenTarget()).toEqual(TARGET);
    await updateSettings({ penv: { org: 'old', project: 'old', env: 'old' } });
    const fetchImpl = penvOk();
    await reconnect(fetchImpl);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('acme');
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).not.toContain('old');
  });

  it('checkKeys checks each key against its own provider', async () => {
    const statusFor: Record<string, number> = {
      'https://api.groq.com/openai/v1/models': 200,
      'https://api.openai.com/v1/models': 401,
      'https://api.anthropic.com/v1/models': 403,
      'https://openrouter.ai/api/v1/models': 503,
    };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('deepgram')) throw new TypeError('offline');
      return new Response('{}', { status: statusFor[String(url)] ?? 500 });
    });
    const results = await checkKeys(
      {
        GROQ_API_KEY: 'gsk_test',
        OPENAI_API_KEY: 'sk_test',
        ANTHROPIC_API_KEY: 'sk_test',
        OPENROUTER_API_KEY: 'sk_test',
        DEEPGRAM_API_KEY: 'dg_test',
        OTHER_THING: 'x_test',
      },
      fetchImpl as typeof fetch,
    );
    expect(results).toEqual({
      GROQ_API_KEY: 'ok',
      OPENAI_API_KEY: 'rejected',
      ANTHROPIC_API_KEY: 'rejected',
      OPENROUTER_API_KEY: 'unreachable',
      DEEPGRAM_API_KEY: 'unreachable',
    });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const headersOf = (part: string) => calls.find(([u]) => u.includes(part))?.[1].headers;
    expect(headersOf('groq')).toEqual({ Authorization: 'Bearer gsk_test' });
    expect(headersOf('anthropic')).toMatchObject({ 'x-api-key': 'sk_test', 'anthropic-version': '2023-06-01' });
    expect(headersOf('deepgram')).toEqual({ Authorization: 'Token dg_test' });
    expect(JSON.stringify(results)).not.toMatch(/_test/);
  });

  it('checkKeys marks a key unreachable when the provider never answers', async () => {
    const hang = vi.fn(() => new Promise<Response>(() => {}));
    expect(await checkKeys({ GROQ_API_KEY: 'gsk_test' }, hang as typeof fetch, 20)).toEqual({ GROQ_API_KEY: 'unreachable' });
  });

  it('pickProviders keeps working providers and falls back in order', () => {
    const base = { ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features } };
    const all: KeyResults = { GROQ_API_KEY: 'ok', DEEPGRAM_API_KEY: 'ok' };
    expect(pickProviders(all, base)).toEqual({
      transcription: base.transcription,
      summary: base.summary,
      features: base.features,
    });
    const groqBad = pickProviders(
      { GROQ_API_KEY: 'rejected', OPENAI_API_KEY: 'ok', ANTHROPIC_API_KEY: 'ok', DEEPGRAM_API_KEY: 'unreachable' },
      base,
    );
    expect(groqBad.transcription).toEqual({ provider: 'openai', model: 'whisper-1' });
    expect(groqBad.summary.provider).toBe('openai');
    expect(groqBad.features).toEqual({ ...base.features, speakerNames: false });
    const onlyAnthropic = pickProviders({ GROQ_API_KEY: 'rejected', ANTHROPIC_API_KEY: 'ok' }, base);
    expect(onlyAnthropic.transcription).toEqual(base.transcription);
    expect(onlyAnthropic.summary.provider).toBe('anthropic');
    const ollama = pickProviders({}, { ...base, summary: { provider: 'ollama', model: 'llama3.2' } });
    expect(ollama.summary).toEqual({ provider: 'ollama', model: 'llama3.2' });
  });

  it('keeps a rejected key and reports it to Start', async () => {
    await connectPenv('pck_test', TARGET, penvOk());
    const rejected = vi.fn(async () => new Response('', { status: 401 }));
    const results = await checkKeys(await loadKeys(), rejected);
    await saveKeyStatus(results);
    expect(await loadKeys()).toEqual({ GROQ_API_KEY: 'gsk_test' });
    expect(await loadToken()).toBe('pck_test');
    expect(await ensureKeys(penvOk())).toBe('ready');
    expect(await transcriptionKeyRejected(DEFAULT_SETTINGS, rejected)).toBe(true);
    const fixed = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await transcriptionKeyRejected(DEFAULT_SETTINGS, fixed)).toBe(false);
    expect(await transcriptionKeyRejected(DEFAULT_SETTINGS, rejected)).toBe(false);
    await saveKeyStatus(results);
    await forgetAll();
    expect(await transcriptionKeyRejected(DEFAULT_SETTINGS)).toBe(false);
  });

  it('forgetAll clears token and keys', async () => {
    await saveKeys({ GROQ_API_KEY: 'gsk_test' });
    await fakeBrowser.storage.session.set({ penvToken: 'pck_test' });
    await forgetAll();
    expect(await loadKeys()).toEqual({});
    expect(await loadToken()).toBeUndefined();
  });

  it('verifies the transcription key with GET /models', async () => {
    const ok = vi.fn(async () => new Response('{}', { status: 200 }));
    await verifyTranscriptionKey(DEFAULT_SETTINGS, { GROQ_API_KEY: 'gsk_test' }, ok);
    expect(ok).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: 'Bearer gsk_test' },
    });
    const rejected = vi.fn(async () => new Response('', { status: 401 }));
    const err = await verifyTranscriptionKey(DEFAULT_SETTINGS, { GROQ_API_KEY: 'gsk_test' }, rejected).catch((e) => e);
    expect(connectErrorMessage(err)).toMatch(/rejected GROQ_API_KEY/);
    expect(connectErrorMessage(err)).not.toContain('gsk_test');
    await expect(verifyTranscriptionKey(DEFAULT_SETTINGS, {}, ok)).rejects.toThrow(/No GROQ_API_KEY/);
  });

  it('turns penv errors into plain words', () => {
    expect(connectErrorMessage(new PenvError('unauthorized', 'x', 401))).toMatch(/didn’t accept that token/);
    expect(connectErrorMessage(new PenvError('not-found', 'x', 404))).toMatch(/couldn’t find that environment/);
    expect(connectErrorMessage(new PenvError('write-only', 'x'))).toMatch(/write-only/);
    expect(connectErrorMessage(new TypeError('fetch failed'))).toMatch(/Couldn’t reach/);
  });

  it('keeps the optional DEEPGRAM_API_KEY but never requires it', async () => {
    expect(optionalKeyNames(DEFAULT_SETTINGS)).toEqual(['DEEPGRAM_API_KEY']);
    expect(requiredKeyNames(DEFAULT_SETTINGS)).not.toContain('DEEPGRAM_API_KEY');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ name: 'GROQ_API_KEY', value: 'gsk_test' }, { name: 'DEEPGRAM_API_KEY', value: 'dg_test' }],
    }), { status: 200 }));
    expect(await connectPenv('pck_test', TARGET, fetchImpl)).toEqual(['DEEPGRAM_API_KEY', 'GROQ_API_KEY']);
    expect((await loadKeys()).DEEPGRAM_API_KEY).toBe('dg_test');
    expect(await connectPaste({ GROQ_API_KEY: 'gsk_test', DEEPGRAM_API_KEY: ' dg_test ' })).toEqual(['DEEPGRAM_API_KEY', 'GROQ_API_KEY']);
    expect((await loadKeys()).DEEPGRAM_API_KEY).toBe('dg_test');
  });
});
