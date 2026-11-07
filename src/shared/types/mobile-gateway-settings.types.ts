/**
 * Mobile Gateway (phone control app) settings.
 *
 * Extracted from `settings.types.ts` (LOC ratchet split): self-contained —
 * no dependency on `AppSettings` itself — so it can live in its own module
 * while `AppSettings` extends it and `settings.types.ts` keeps the single
 * import surface. See docs/mobile-app/.
 */

export interface MobileGatewaySettings {
  // Mobile Gateway (phone control app — see docs/mobile-app/)
  mobileGatewayEnabled: boolean;
  mobileGatewayPort: number;
  mobileGatewayBindInterface: 'tailscale' | 'all';
  /** JSON array of paired MobileDevice records. */
  mobileGatewayDevices: string;
  // Optional TLS (wss://). Tailscale already encrypts the link E2E, so this is
  // extra hardening only. Point these at a `tailscale cert <host>.<tailnet>.ts.net`
  // key/cert (publicly trusted, so iOS connects without a trust prompt). Empty =>
  // plain ws:// over the tailnet. Both must be set to enable TLS.
  mobileGatewayTlsCertPath: string;
  mobileGatewayTlsKeyPath: string;
  // APNs push (direct from Mac → Apple). Empty key => push disabled.
  /** PEM contents of the APNs Auth Key (.p8). */
  mobileGatewayApnsKeyP8: string;
  mobileGatewayApnsKeyId: string;
  mobileGatewayApnsTeamId: string;
  mobileGatewayApnsBundleId: string;
  /** true → api.push.apple.com, false → api.sandbox.push.apple.com. */
  mobileGatewayApnsProduction: boolean;
}
