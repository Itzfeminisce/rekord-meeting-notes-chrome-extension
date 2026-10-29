import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadKeyStatus } from './connect';
import { loadKeys } from './keys';
import { DEFAULT_SETTINGS } from './settings';
import {
  addKey,
  applyPreset,
  canStart,
  classifyPaste,
  keyUse,
  missingKeys,
  neededKeys,
  rowDetail,
  startHint,
} from './setup';

const base = {
  transcription: DEFAULT_SETTINGS.transcription,
  summary: DEFAULT_SETTINGS.summary,
  realtimeBackup: false,
};

describe('presets', () => {
  it('free uses Groq for transcription and the assistant', () => {
    const p = applyPreset('free', { ...base, transcription: { provider: 'deepgram', model: 'nova-3' } });
    expect(p.setup).toBe('free');
    expect(p.transcription).toEqual({ provider: 'groq', model: 'whisper-large-v3-turbo' });
    expect(p.summary.provider).toBe('groq');
  });

  it('real time uses Deepgram plus Groq and turns the backup on', () => {
    const p = applyPreset('realtime', base);
    expect(p.transcription).toEqual({ provider: 'deepgram', model: 'nova-3' });
    expect(p.summary.provider).toBe('groq');
    expect(p.realtimeBackup).toBe(true);
  });

  it('custom keeps the current choices', () => {
    const current = { transcription: { provider: 'openai' as const, model: 'whisper-1' }, summary: { provider: 'anthropic' as const, model: 'x' }, realtimeBackup: false };
    expect(applyPreset('custom', current)).toEqual({ setup: 'custom', ...current });
  });
});

describe('needed keys', () => {
  it('free needs one Groq key', () => {
    expect(neededKeys(applyPreset('free', base))).toEqual(['GROQ_API_KEY']);
  });

  it('real time needs Deepgram then Groq', () => {
    expect(neededKeys(applyPreset('realtime', base))).toEqual(['DEEPGRAM_API_KEY', 'GROQ_API_KEY']);
  });

  it('custom lists each service once, and Ollama needs none', () => {
    expect(neededKeys({ transcription: { provider: 'openai', model: 'whisper-1' }, summary: { provider: 'openai', model: 'm' } })).toEqual(['OPENAI_API_KEY']);
    expect(neededKeys({ transcription: { provider: 'groq', model: 'm' }, summary: { provider: 'ollama', model: 'm' } })).toEqual(['GROQ_API_KEY']);
  });

  it('reports what is missing and whether Start is allowed', () => {
    const needed = ['DEEPGRAM_API_KEY', 'GROQ_API_KEY'];
    expect(missingKeys(needed, ['GROQ_API_KEY'])).toEqual(['DEEPGRAM_API_KEY']);
    expect(startHint(needed, ['GROQ_API_KEY'], {})).toBe('Add your Deepgram key to continue.');
    expect(canStart(needed, ['GROQ_API_KEY'], { GROQ_API_KEY: 'ok' })).toBe(false);
    expect(canStart(needed, needed, { DEEPGRAM_API_KEY: 'ok', GROQ_API_KEY: 'checking' })).toBe(false);
    expect(canStart(needed, needed, { DEEPGRAM_API_KEY: 'rejected', GROQ_API_KEY: 'ok' })).toBe(false);
    expect(startHint(needed, needed, { DEEPGRAM_API_KEY: 'rejected', GROQ_API_KEY: 'ok' })).toContain('Deepgram didn’t accept');
    expect(canStart(needed, needed, { DEEPGRAM_API_KEY: 'ok', GROQ_API_KEY: 'unreachable' })).toBe(true);
  });
});

describe('pasted key rows', () => {
  it('recognised: names the service and what it covers', () => {
    expect(classifyPaste('gsk_test')).toEqual({
      kind: 'known',
      name: 'GROQ_API_KEY',
      title: 'This is a Groq key',
      jobs: 'transcription and the assistant',
    });
    expect(rowDetail('GROQ_API_KEY', 'ok')).toBe('Ready for transcription and the assistant');
    expect(rowDetail('DEEPGRAM_API_KEY', 'ok')).toBe('Ready for transcription');
    expect(rowDetail('ANTHROPIC_API_KEY', 'ok')).toBe('Ready for the assistant');
  });

  it('unknown: asks which service', () => {
    expect(classifyPaste('dg_test')).toEqual({ kind: 'unknown' });
    expect(classifyPaste('   ')).toEqual({ kind: 'empty' });
  });

  it('rejected: says the service did not accept it', () => {
    expect(rowDetail('GROQ_API_KEY', 'rejected')).toBe('Groq didn’t accept this key');
  });
});

describe('addKey', () => {
  beforeEach(() => fakeBrowser.reset());

  it('saves a recognised key and remembers an ok check', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await addKey('GROQ_API_KEY', ' gsk_test ', fetchImpl as unknown as typeof fetch)).toBe('ok');
    expect((await loadKeys()).GROQ_API_KEY).toBe('gsk_test');
    expect((await loadKeyStatus()).GROQ_API_KEY).toBe('ok');
  });

  it('marks a refused key as rejected but keeps it in memory', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    expect(await addKey('GROQ_API_KEY', 'gsk_test', fetchImpl as unknown as typeof fetch)).toBe('rejected');
    expect((await loadKeyStatus()).GROQ_API_KEY).toBe('rejected');
  });

  it('saves the key before the host prompt answers, and skips the check when it is refused', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    let answer: (ok: boolean) => void = () => {};
    const pending = addKey('GROQ_API_KEY', 'gsk_test', fetchImpl as unknown as typeof fetch, new Promise((r) => { answer = r; }));
    await vi.waitFor(async () => expect((await loadKeys()).GROQ_API_KEY).toBe('gsk_test'));
    answer(false);
    expect(await pending).toBe('unreachable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks the key as the service the user picked', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await addKey('DEEPGRAM_API_KEY', 'dg_test', fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls as unknown[][])[0]?.[0]).toBe('https://api.deepgram.com/v1/projects');
  });
});

describe('key use and the Penv Cloud flag', () => {
  const s = { ...DEFAULT_SETTINGS, ...applyPreset('realtime', base) };
  it('describes what each key does', () => {
    expect(keyUse('DEEPGRAM_API_KEY', s)).toBe('transcription');
    expect(keyUse('GROQ_API_KEY', s)).toBe('assistant and backup');
    expect(keyUse('OPENAI_API_KEY', s)).toBe('not in use');
  });
});
