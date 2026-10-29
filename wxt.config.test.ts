import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PERMISSIONS = ['sidePanel', 'storage', 'tabCapture', 'offscreen', 'activeTab', 'identity'];
const OPTIONAL_HOSTS = [
  'https://penv.cloud/*',
  'https://api.groq.com/*',
  'https://api.openai.com/*',
  'https://openrouter.ai/*',
  'https://api.anthropic.com/*',
  'https://api.deepgram.com/*',
  'wss://api.deepgram.com/*',
  'https://api.notion.com/*',
  'https://www.googleapis.com/*',
  'https://oauth2.googleapis.com/*',
  'http://localhost:11434/*',
];

async function manifest() {
  vi.resetModules();
  // Typed loosely: the config's manifest field also allows a function form.
  return ((await import('./wxt.config')).default as { manifest: Record<string, unknown> }).manifest;
}

/** Chrome's extension id: the first 32 hex digits of SHA-256(public key), written with a-p. */
function extensionId(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

describe('manifest', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fixes the extension id with Rekord\'s public key by default', async () => {
    const key = (await manifest()).key as string;
    expect(key).toMatch(/^MIIBIjAN/);
    expect(extensionId(key)).toBe('flkicdahoghegnlgpkmdcemlooblblcd');
  });

  it('puts WXT_EXTENSION_KEY in manifest.key when set', async () => {
    vi.stubEnv('WXT_EXTENSION_KEY', 'test-public-key');
    expect((await manifest()).key).toBe('test-public-key');
  });

  it('asks for every service host only when its feature is turned on', async () => {
    const m = await manifest();
    expect(m.permissions).toEqual(PERMISSIONS);
    expect(m.host_permissions).toBeUndefined();
    expect([...(m.optional_host_permissions as string[])].sort()).toEqual([...OPTIONAL_HOSTS].sort());
  });

  it('signs in to Google with launchWebAuthFlow, not a manifest oauth2 client', async () => {
    expect((await manifest()).oauth2).toBeUndefined();
  });

  it('shows the Rekord icon in the toolbar and on the extensions page', async () => {
    const m = await manifest();
    const icons = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' };
    expect(m.icons).toEqual(icons);
    expect((m.action as { default_icon?: unknown }).default_icon).toEqual(icons);
    for (const path of Object.values(icons)) expect(existsSync(`public/${path}`)).toBe(true);
  });
});
