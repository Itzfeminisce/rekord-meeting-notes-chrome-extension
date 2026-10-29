import { describe, expect, it } from 'vitest';
import { fetchPenvKeys, PenvError, type PenvTarget } from './penv';

const target: PenvTarget = { org: 'acme', project: 'notes', env: 'dev' };

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('fetchPenvKeys', () => {
  it('sends the token as a bearer and maps keys by name', async () => {
    const { fetchImpl, calls } = stubFetch(200, {
      keys: [{ name: 'GROQ_API_KEY', value: 'gsk_test', kind: 'static' }],
    });

    await expect(fetchPenvKeys('pck_test', target, fetchImpl)).resolves.toEqual({
      GROQ_API_KEY: 'gsk_test',
    });
    expect(calls[0]!.url).toBe('https://penv.cloud/api/v1/envs/acme/notes/dev');
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBe('Bearer pck_test');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [500, 'http'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { fetchImpl } = stubFetch(status, {});
    await expect(fetchPenvKeys('pck_test', target, fetchImpl)).rejects.toMatchObject({ code });
  });

  it('rejects a write-only environment that returns redacted values', async () => {
    const { fetchImpl } = stubFetch(200, { keys: [{ name: 'GROQ_API_KEY', value: 'redacted' }] });
    const error = await fetchPenvKeys('pck_test', target, fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(PenvError);
    expect(error.code).toBe('write-only');
  });

  it('treats the server redacted: true entries (no value) as write-only too', async () => {
    const { fetchImpl } = stubFetch(200, { keys: [{ path: 'GROQ_API_KEY', name: 'GROQ_API_KEY', kind: 'secret', redacted: true }] });
    await expect(fetchPenvKeys('pck_test', target, fetchImpl)).rejects.toMatchObject({ code: 'write-only' });
  });

  it('rejects a body without a keys array', async () => {
    const { fetchImpl } = stubFetch(200, { data: [] });
    await expect(fetchPenvKeys('pck_test', target, fetchImpl)).rejects.toMatchObject({
      code: 'bad-response',
    });
  });
});

// Live check against penv.cloud. Runs only when PENV_TOKEN is set (e.g. `penv run -- npm test`)
// and asserts on key names only, never values.
describe.runIf(process.env.PENV_TOKEN)('penv.cloud (live)', () => {
  it('accepts the pck_ token and returns at least one key', async () => {
    const keys = await fetchPenvKeys(process.env.PENV_TOKEN!, {
      org: process.env.PENV_ORG ?? 'penvhq',
      project: process.env.PENV_PROJECT ?? 'meeting-notes-taker',
      env: process.env.PENV_ENV ?? 'testing',
    });
    expect(Object.keys(keys).length).toBeGreaterThan(0);
  });
});
