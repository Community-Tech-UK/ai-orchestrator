import { beforeEach, describe, expect, it, vi } from 'vitest';
const interfaces = vi.hoisted(() => ({ ipv4: null as string | null, ipv6: null as string | null }));
vi.mock('../util/network-addresses', () => ({ getTailscaleIpv4Address: () => interfaces.ipv4, getTailscaleIpv6Address: () => interfaces.ipv6 }));
import { resolveBindHost } from './tailscale-interface';
beforeEach(() => { interfaces.ipv4 = null; interfaces.ipv6 = null; });
describe('phone gateway private bind address', () => {
  it('never broadens a Tailscale-only request when the network is starting', () => {
    expect(resolveBindHost('tailscale')).toBeNull();
  });
  it('accepts IPv6-only Tailscale, and prefers IPv4 when both exist', () => {
    interfaces.ipv6 = 'fd7a:115c:a1e0::2';
    expect(resolveBindHost('tailscale')).toEqual({ host: interfaces.ipv6, tailscaleIp: interfaces.ipv6 });
    interfaces.ipv4 = '100.64.0.2';
    expect(resolveBindHost('tailscale')).toEqual({ host: interfaces.ipv4, tailscaleIp: interfaces.ipv4 });
  });
  it('only listens publicly when explicitly requested', () => {
    expect(resolveBindHost('all')).toEqual({ host: '0.0.0.0', tailscaleIp: null });
  });
});
