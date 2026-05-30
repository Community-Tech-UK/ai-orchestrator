import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.shutupandshave.aiorchestrator',
  appName: 'AI Orchestrator',
  webDir: 'www',
  ios: {
    // Allow ws:// over the Tailscale tunnel (WireGuard already encrypts the link).
    // For off-tailnet wss:// later, this can be tightened.
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
