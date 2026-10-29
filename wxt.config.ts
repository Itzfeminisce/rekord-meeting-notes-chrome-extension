import { defineConfig } from 'wxt';

// Google sign-in (chrome.identity) needs an OAuth client ID tied to a stable extension ID. See docs/GOOGLE.md.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => {
    // WXT loads .env files into the environment before building the manifest (import.meta.env in app code).
    const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? process.env;
    const clientId = env.WXT_GOOGLE_CLIENT_ID || undefined;
    const extensionKey = env.WXT_EXTENSION_KEY || undefined;
    // Release = `wxt zip` or `--mode release`. Plain dev builds work without either variable.
    const release = mode === 'release' || process.argv.includes('zip');
    if (release && (!clientId || !extensionKey)) {
      throw new Error(
        'Release build needs WXT_GOOGLE_CLIENT_ID and WXT_EXTENSION_KEY (see docs/GOOGLE.md). ' +
          'Set them in .env.local or the environment.',
      );
    }
    return {
      name: 'Rekord',
      description: 'Personal AI meeting note taker',
      permissions: ['sidePanel', 'storage', 'tabCapture', 'offscreen', 'activeTab', 'identity'],
      host_permissions: [
        'https://penv.cloud/*',
        'https://api.groq.com/*',
        'https://api.openai.com/*',
        'https://openrouter.ai/*',
        'https://api.anthropic.com/*',
        'https://api.deepgram.com/*',
        'wss://api.deepgram.com/*',
        'https://www.googleapis.com/*',
        'https://docs.googleapis.com/*',
        'https://oauth2.googleapis.com/*',
        'https://api.notion.com/*',
        'http://localhost:11434/*',
      ],
      action: { default_title: 'Open Rekord' },
      // Chrome rejects the whole manifest when oauth2.client_id is empty, so leave it out until one is set.
      ...(clientId
        ? {
            oauth2: {
              client_id: clientId,
              scopes: [
                'https://www.googleapis.com/auth/calendar.readonly',
                'https://www.googleapis.com/auth/drive.file',
              ],
            },
          }
        : {}),
      ...(extensionKey ? { key: extensionKey } : {}),
    };
  },
});
