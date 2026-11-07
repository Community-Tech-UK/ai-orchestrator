import { describe, expect, it } from 'vitest';
import {
  buildCanonicalConnectionConfig,
  buildPairingCommand,
  buildPairingLink,
  selectPairingConnectionHosts,
  selectPairingConnectionPort,
} from './pairing-command';

describe('pairing-command', () => {
  it('prefers MagicDNS, then Tailscale IP, then LAN IPs when bound to 0.0.0.0, keeping the rest as fallbacks', () => {
    const status = {
      host: '0.0.0.0',
      port: 4878,
      localIps: ['192.168.1.50', '100.101.102.103'],
      tailscaleIp: '100.101.102.103',
      tailscaleDnsName: 'studio-mac.tailnet-abcd.ts.net',
    };

    expect(selectPairingConnectionHosts(status, '0.0.0.0')).toEqual({
      host: 'studio-mac.tailnet-abcd.ts.net',
      fallbackHosts: ['100.101.102.103', '192.168.1.50'],
    });
    expect(selectPairingConnectionPort(status, 4878)).toBe(4878);
    expect(selectPairingConnectionPort({}, 4878)).toBe(4878);
  });

  it('uses the first LAN IP when Tailscale is absent', () => {
    expect(selectPairingConnectionHosts({ host: '0.0.0.0', localIps: ['192.168.1.50', '10.0.0.4'] }, '0.0.0.0'))
      .toEqual({ host: '192.168.1.50', fallbackHosts: ['10.0.0.4'] });
  });

  it('uses an explicitly bound host alone, because the server answers nowhere else', () => {
    expect(selectPairingConnectionHosts({ localIps: ['192.168.1.50'], tailscaleIp: '100.64.0.1' }, '192.168.1.60'))
      .toEqual({ host: '192.168.1.60', fallbackHosts: [] });
  });

  it('keeps 0.0.0.0 when no address is known', () => {
    expect(selectPairingConnectionHosts({ host: '0.0.0.0' }, '0.0.0.0')).toEqual({ host: '0.0.0.0', fallbackHosts: [] });
  });

  it('builds canonical pairing artifacts from the resolved endpoint', () => {
    const input = {
      token: 'pair-token',
      label: 'Studio PC',
      host: 'studio-mac.tailnet-abcd.ts.net',
      port: 4878,
      namespace: 'default',
      requireTls: false,
    };

    const config = buildCanonicalConnectionConfig(input);
    expect(config).toMatchObject({
      name: 'Studio PC',
      authToken: 'pair-token',
      coordinatorUrl: 'ws://studio-mac.tailnet-abcd.ts.net:4878',
      namespace: 'default',
    });
    expect(config).not.toHaveProperty('coordinatorUrls');
    expect(buildPairingLink(input)).toBe(
      'ai-orchestrator://remote-node/pair?host=studio-mac.tailnet-abcd.ts.net&port=4878&namespace=default&token=pair-token&requireTls=false&name=Studio+PC',
    );
    expect(buildPairingCommand(input)).toBe(`aio-worker pair "${buildPairingLink(input)}"`);
  });

  it('puts Tailscale IPv4 then IPv6 between MagicDNS and the LAN addresses', () => {
    expect(selectPairingConnectionHosts({
      host: '0.0.0.0',
      localIps: ['192.168.1.50'],
      tailscaleIp: '100.101.102.103',
      tailscaleIpv6: 'fd7a:115c:a1e0::1234',
      tailscaleDnsName: 'mac.ts.net',
    }, '0.0.0.0')).toEqual({
      host: 'mac.ts.net',
      fallbackHosts: ['100.101.102.103', 'fd7a:115c:a1e0::1234', '192.168.1.50'],
    });
  });

  it('brackets IPv6 hosts in coordinator URLs but sends them bare in the link', () => {
    const input = {
      token: 'pair-token',
      host: 'fd7a:115c:a1e0::1234',
      port: 4878,
      namespace: 'default',
      requireTls: false,
      fallbackHosts: ['fd7a:115c:a1e0::5678', '192.168.1.50'],
    };

    expect(buildCanonicalConnectionConfig(input)).toMatchObject({
      coordinatorUrl: 'ws://[fd7a:115c:a1e0::1234]:4878',
      coordinatorUrls: ['ws://[fd7a:115c:a1e0::5678]:4878', 'ws://192.168.1.50:4878'],
    });
    const params = new URL(buildPairingLink(input)).searchParams;
    expect(params.get('host')).toBe('fd7a:115c:a1e0::1234');
    expect(params.getAll('fallbackHost')).toEqual(['fd7a:115c:a1e0::5678', '192.168.1.50']);
  });

  it('writes the label as the name parameter, encoded so the command stays one safe argument', () => {
    const link = buildPairingLink({
      token: 'pair-token',
      label: ' Studio "PC" $HOME ',
      host: '192.168.1.50',
      port: 4878,
      namespace: 'default',
      requireTls: false,
    });
    expect(new URL(link).searchParams.get('name')).toBe('Studio "PC" $HOME');
    expect(link).not.toMatch(/["$ ]/);
  });

  it('leaves the name parameter out without a label', () => {
    const link = buildPairingLink({
      token: 'pair-token',
      label: '  ',
      host: '192.168.1.50',
      port: 4878,
      namespace: 'default',
      requireTls: false,
    });
    expect(new URL(link).searchParams.has('name')).toBe(false);
  });

  it('carries fallback hosts in the link and as coordinatorUrls in the config', () => {
    const input = {
      token: 'pair-token',
      host: 'studio-mac.tailnet-abcd.ts.net',
      port: 4878,
      namespace: 'default',
      requireTls: true,
      fallbackHosts: ['100.101.102.103', '192.168.1.50'],
    };

    expect(buildCanonicalConnectionConfig(input)['coordinatorUrls'])
      .toEqual(['wss://100.101.102.103:4878', 'wss://192.168.1.50:4878']);
    expect(new URL(buildPairingLink(input)).searchParams.getAll('fallbackHost'))
      .toEqual(['100.101.102.103', '192.168.1.50']);
  });
});
