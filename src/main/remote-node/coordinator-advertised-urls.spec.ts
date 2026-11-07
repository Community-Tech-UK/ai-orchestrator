import { describe, expect, it, vi } from 'vitest';
import {
  buildCoordinatorUrls,
  MAX_ADVERTISED_COORDINATOR_URLS,
  readCoordinatorReachableHosts,
  resolveAdvertisedCoordinatorUrls,
} from './coordinator-advertised-urls';

const config = { serverHost: '0.0.0.0', serverPort: 4878, tlsCertPath: undefined, tlsKeyPath: undefined };

describe('buildCoordinatorUrls', () => {
  it('orders MagicDNS, Tailscale IP, then LAN IPs, de-duplicated', () => {
    expect(buildCoordinatorUrls(config, {
      tailscaleDnsName: 'macbook-pro.tail4fc107.ts.net',
      tailscaleIp: '100.68.10.5',
      localIps: ['192.168.0.156', '192.168.0.96', '100.68.10.5'],
    })).toEqual([
      'ws://macbook-pro.tail4fc107.ts.net:4878',
      'ws://100.68.10.5:4878',
      'ws://192.168.0.156:4878',
      'ws://192.168.0.96:4878',
    ]);
  });

  it('puts the Tailscale IPv6 address after the Tailscale IPv4 address, in brackets', () => {
    expect(buildCoordinatorUrls(config, {
      tailscaleDnsName: 'mac.ts.net',
      tailscaleIp: '100.68.10.5',
      tailscaleIpv6: 'fd7a:115c:a1e0::1234',
      localIps: ['192.168.0.156'],
    })).toEqual([
      'ws://mac.ts.net:4878',
      'ws://100.68.10.5:4878',
      'ws://[fd7a:115c:a1e0::1234]:4878',
      'ws://192.168.0.156:4878',
    ]);
  });

  it('brackets an explicit IPv6 bind host and treats `::` as all interfaces', () => {
    expect(buildCoordinatorUrls(
      { serverHost: 'fd00::5', serverPort: 9000, tlsCertPath: undefined, tlsKeyPath: undefined },
      { tailscaleDnsName: null, tailscaleIp: null, localIps: [] },
    )).toEqual(['ws://[fd00::5]:9000']);
    expect(buildCoordinatorUrls(
      { serverHost: '::', serverPort: 9000, tlsCertPath: undefined, tlsKeyPath: undefined },
      { tailscaleDnsName: null, tailscaleIp: null, localIps: [] },
    )).toEqual([]);
  });

  it('uses wss when TLS is configured and includes an explicit bind host', () => {
    expect(buildCoordinatorUrls(
      { serverHost: '10.1.2.3', serverPort: 9000, tlsCertPath: '/c.pem', tlsKeyPath: '/k.pem' },
      { tailscaleDnsName: null, tailscaleIp: null, localIps: [] },
    )).toEqual(['wss://10.1.2.3:9000']);
  });

  it('caps the list at the schema limit', () => {
    const localIps = Array.from({ length: 30 }, (_, i) => `192.168.1.${i + 1}`);
    expect(buildCoordinatorUrls(config, { tailscaleDnsName: null, tailscaleIp: null, localIps }))
      .toHaveLength(MAX_ADVERTISED_COORDINATOR_URLS);
  });
});

describe('resolveAdvertisedCoordinatorUrls', () => {
  it('includes the MagicDNS name only while Tailscale reports Running', async () => {
    const running = await resolveAdvertisedCoordinatorUrls(config, {
      getTailscaleIp: () => '100.68.10.5',
      getTailscaleIpv6: () => null,
      readTailscaleStatus: async () => ({ backendState: 'Running', dnsName: 'mac.ts.net' }),
      getLocalIps: () => ['192.168.0.156'],
    });
    expect(running[0]).toBe('ws://mac.ts.net:4878');

    const starting = await resolveAdvertisedCoordinatorUrls(config, {
      getTailscaleIp: () => '100.68.10.5',
      getTailscaleIpv6: () => null,
      readTailscaleStatus: async () => ({ backendState: 'Starting', dnsName: 'mac.ts.net' }),
      getLocalIps: () => ['192.168.0.156'],
    });
    expect(starting).not.toContain('ws://mac.ts.net:4878');
  });

  it('skips the Tailscale CLI entirely when there is no Tailscale interface', async () => {
    const readTailscaleStatus = vi.fn();
    const urls = await resolveAdvertisedCoordinatorUrls(config, {
      getTailscaleIp: () => null,
      getTailscaleIpv6: () => null,
      readTailscaleStatus,
      getLocalIps: () => ['192.168.0.156'],
    });
    expect(readTailscaleStatus).not.toHaveBeenCalled();
    expect(urls).toEqual(['ws://192.168.0.156:4878']);
  });

  it('advertises the Tailscale IPv6 address even when only IPv6 is present', async () => {
    const urls = await resolveAdvertisedCoordinatorUrls(config, {
      getTailscaleIp: () => null,
      getTailscaleIpv6: () => 'fd7a:115c:a1e0::1234',
      readTailscaleStatus: async () => ({ backendState: 'Running', dnsName: 'mac.ts.net' }),
      getLocalIps: () => ['192.168.0.156'],
    });
    expect(urls).toEqual([
      'ws://mac.ts.net:4878',
      'ws://[fd7a:115c:a1e0::1234]:4878',
      'ws://192.168.0.156:4878',
    ]);
  });
});

describe('readCoordinatorReachableHosts', () => {
  it('drops the MagicDNS name when Tailscale is stopped but keeps its addresses', async () => {
    await expect(readCoordinatorReachableHosts({
      getTailscaleIp: () => '100.68.10.5',
      getTailscaleIpv6: () => 'fd7a:115c:a1e0::1234',
      readTailscaleStatus: async () => ({ backendState: 'Stopped', dnsName: 'mac.ts.net' }),
      getLocalIps: () => ['192.168.0.156'],
    })).resolves.toEqual({
      tailscaleDnsName: null,
      tailscaleIp: '100.68.10.5',
      tailscaleIpv6: 'fd7a:115c:a1e0::1234',
      localIps: ['192.168.0.156'],
    });
  });
});
