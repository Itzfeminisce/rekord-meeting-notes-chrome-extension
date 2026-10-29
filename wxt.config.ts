import { defineConfig } from 'wxt';
import { OPTIONAL_HOSTS } from './lib/hosts';

// Rekord's public key fixes the extension id (flkicdahoghegnlgpkmdcemlooblblcd) for Penv Cloud, Google and the Web Store.
// It is public; the private key stays with the owner and is uploaded once, with the first Web Store zip. See docs/GOOGLE.md.
const REKORD_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxVukoIgjV4ZMhNpHu0gGwWj3T9fsPlEzpUnSlHRscU581QJSGsLB3EpXnbZzsRE1TCKwxvmenqgD81uKsZ64bwUlNHvM9ekXB8IVaooXgmSm0wQzTitR6tRYoXRHJyjpQp1pxvYEnZlBaDbvNQhfaLKPMJWoeR6RT7tTMm5vObdEEr8eNEvkCRSSPewdzIgh0MC40F1jBHUbXYpWSxhfPKHxjoCvScqc+5c/J8gE6DrYqLNBWk2i5g6sNtZvUK+zsDEAHH4ONaSUbdkgJOTfXe0mzE1iEaUZZYNIZQFDKE3YYPbDOkliGq/viwwfikycvri8WxHFTdR9y2MRTssOjwIDAQAB';
const extensionKey = process.env.WXT_EXTENSION_KEY || REKORD_KEY;
const ICONS = { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' };

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    key: extensionKey,
    name: 'Rekord',
    description: 'Personal AI meeting note taker',
    icons: ICONS,
    permissions: ['sidePanel', 'storage', 'tabCapture', 'offscreen', 'activeTab', 'identity'],
    // Requested only when the user turns on Penv Cloud, a cloud AI key, Deepgram, Google, Notion or Ollama (lib/hosts.ts).
    optional_host_permissions: OPTIONAL_HOSTS,
    action: { default_title: 'Open Rekord', default_icon: ICONS },
  },
});
