/** Reads API keys from a penv.cloud environment with a read-only `pck_` machine token. */

export const PENV_BASE_URL = 'https://penv.cloud/api/v1';

export interface PenvTarget {
  org: string;
  project: string;
  env: string;
}

export type PenvErrorCode = 'unauthorized' | 'not-found' | 'write-only' | 'http' | 'bad-response';

export class PenvError extends Error {
  constructor(
    readonly code: PenvErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PenvError';
  }
}

interface PenvKey {
  name: string;
  value: string;
}

/** Fetches every key in the environment as a name → value map. Never logs values. */
export async function fetchPenvKeys(
  token: string,
  target: PenvTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const path = [target.org, target.project, target.env].map(encodeURIComponent).join('/');
  const response = await fetchImpl(`${PENV_BASE_URL}/envs/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 || response.status === 403) {
    throw new PenvError('unauthorized', 'penv rejected the token.', response.status);
  }
  if (response.status === 404) {
    throw new PenvError('not-found', 'penv could not find that environment.', response.status);
  }
  if (!response.ok) {
    throw new PenvError('http', `penv returned HTTP ${response.status}.`, response.status);
  }

  const body: unknown = await response.json().catch(() => null);
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || !keys.every(isPenvKey)) {
    throw new PenvError('bad-response', 'penv sent a response Rekord does not understand.');
  }

  const redacted = keys.filter((key) => key.value === 'redacted').map((key) => key.name);
  if (redacted.length > 0) {
    throw new PenvError(
      'write-only',
      `This penv environment is write-only, so ${redacted.join(', ')} came back redacted.`,
    );
  }

  return Object.fromEntries(keys.map((key) => [key.name, key.value]));
}

function isPenvKey(value: unknown): value is PenvKey {
  const key = value as PenvKey | null;
  return typeof key?.name === 'string' && typeof key?.value === 'string';
}
