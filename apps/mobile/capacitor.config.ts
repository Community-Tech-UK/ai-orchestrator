import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.shutupandshave.aiorchestrator',
  appName: 'AI Orchestrator',
  // Angular's application builder emits the browser bundle under www/browser.
  webDir: 'www/browser',
  ios: {
    // Allow ws:// over the Tailscale tunnel (WireGuard already encrypts the link).
    // For off-tailnet wss:// later, this can be tightened.
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
