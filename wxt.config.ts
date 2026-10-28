import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Rekord',
    description: 'Personal AI meeting note taker',
    permissions: ['sidePanel', 'storage', 'tabCapture', 'offscreen', 'activeTab'],
    host_permissions: ['https://penv.cloud/*'],
    action: { default_title: 'Open Rekord' },
  },
});
