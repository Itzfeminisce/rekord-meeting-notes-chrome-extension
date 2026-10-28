import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Rekord',
    description: 'Personal AI meeting note taker',
    permissions: ['sidePanel', 'storage', 'tabCapture', 'offscreen', 'activeTab'],
    host_permissions: [
      'https://penv.cloud/*',
      'https://api.groq.com/*',
      'https://api.openai.com/*',
      'https://openrouter.ai/*',
      'https://api.anthropic.com/*',
      'https://api.deepgram.com/*',
      'http://localhost:11434/*',
    ],
    action: { default_title: 'Open Rekord' },
  },
});
