import { describe, expect, it } from 'vitest';
import {
  getTailscaleDnsNameFromStatusJson,
  isLinkLocalIpv4Address,
  isTailscaleIpv4Address,
  isVirtualInterfaceName,
  rankLocalIpv4Candidates,
} from '../network-addresses';

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

  it('flags APIPA link-local addresses', () => {
    expect(isLinkLocalIpv4Address('169.254.31.175')).toBe(true);
    expect(isLinkLocalIpv4Address('192.168.0.156')).toBe(false);
  });

  it('flags virtual / non-physical adapter names', () => {
    expect(isVirtualInterfaceName('vEthernet (Default Switch)')).toBe(true);
    expect(isVirtualInterfaceName('VMware Network Adapter VMnet8')).toBe(true);
    expect(isVirtualInterfaceName('docker0')).toBe(true);
    expect(isVirtualInterfaceName('Ethernet')).toBe(false);
    expect(isVirtualInterfaceName('Wi-Fi')).toBe(false);
  });

  it('ranks the real physical LAN address ahead of virtual adapters', () => {
    // The reported bug: a virtual .95 adapter was advertised instead of the
    // real .156 LAN NIC because the OS enumerated it first.
    const ranked = rankLocalIpv4Candidates([
      { name: 'vEthernet (Default Switch)', address: '172.21.16.1' },
      { name: 'Ethernet 7', address: '169.254.31.175' },
      { name: 'VMware Network Adapter VMnet1', address: '192.168.0.95' },
      { name: 'Ethernet', address: '192.168.0.156' },
      { name: 'Tailscale', address: '100.113.93.104' },
    ]);

    expect(ranked[0]).toBe('192.168.0.156');
    // APIPA link-local is dropped entirely.
    expect(ranked).not.toContain('169.254.31.175');
    // Tailscale CGNAT is surfaced separately and ranks last.
    expect(ranked[ranked.length - 1]).toBe('100.113.93.104');
  });

  it('keeps OS order for equally-scored physical adapters (stable sort)', () => {
    const ranked = rankLocalIpv4Candidates([
      { name: 'Ethernet', address: '192.168.0.95' },
      { name: 'Ethernet 2', address: '192.168.0.156' },
    ]);

    expect(ranked).toEqual(['192.168.0.95', '192.168.0.156']);
  });
});
