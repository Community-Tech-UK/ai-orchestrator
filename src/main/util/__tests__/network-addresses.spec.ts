import { describe, expect, it } from 'vitest';
import { getTailscaleDnsNameFromStatusJson, isTailscaleIpv4Address } from '../network-addresses';

describe('network-addresses', () => {
  it('identifies only valid Tailscale CGNAT IPv4 addresses', () => {
    expect(isTailscaleIpv4Address('100.64.0.1')).toBe(true);
    expect(isTailscaleIpv4Address('100.127.255.255')).toBe(true);

    expect(isTailscaleIpv4Address('100.63.255.255')).toBe(false);
    expect(isTailscaleIpv4Address('100.128.0.0')).toBe(false);
    expect(isTailscaleIpv4Address('192.168.1.50')).toBe(false);
    expect(isTailscaleIpv4Address('100.64.0.999')).toBe(false);
  });

  it('extracts and normalizes the local Tailscale MagicDNS name from status JSON', () => {
    const statusJson = JSON.stringify({
      Self: {
        DNSName: 'studio-mac.tailnet-abcd.ts.net.',
      },
    });

    expect(getTailscaleDnsNameFromStatusJson(statusJson)).toBe('studio-mac.tailnet-abcd.ts.net');
    expect(getTailscaleDnsNameFromStatusJson('not json')).toBeNull();
    expect(getTailscaleDnsNameFromStatusJson(JSON.stringify({ Self: {} }))).toBeNull();
  });
});
