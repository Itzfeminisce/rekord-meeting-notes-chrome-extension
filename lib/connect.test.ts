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
  verifyOrForget,
  verifyTranscriptionKey,
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

  it('verifyOrForget forgets token and keys when the provider rejects the key', async () => {
    await connectPenv('pck_test', TARGET, penvOk());
    const rejected = vi.fn(async () => new Response('', { status: 401 }));
    await expect(verifyOrForget(DEFAULT_SETTINGS, rejected)).rejects.toThrow(/rejected GROQ_API_KEY/);
    expect(await loadKeys()).toEqual({});
    expect(await loadToken()).toBeUndefined();
    expect(await loadTokenTarget()).toBeUndefined();
    expect(await ensureKeys(penvOk())).toBe('reconnect');
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
