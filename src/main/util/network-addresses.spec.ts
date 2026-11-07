import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';
import {
  getTailscaleIpv6Address,
  isTailscaleIpv6Address,
  readTailscaleSelfStatus,
} from './network-addresses';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, networkInterfaces: vi.fn(actual.networkInterfaces) };
});

function iface(family: 'IPv4' | 'IPv6', address: string, internal = false): os.NetworkInterfaceInfo {
  return { family, address, internal } as os.NetworkInterfaceInfo;
}

describe('readTailscaleSelfStatus', () => {
  it('reads backend state and MagicDNS name without blocking', async () => {
    const exec = vi.fn(async () => JSON.stringify({
      BackendState: 'Stopped',
      Self: { DNSName: 'macbook-pro.tail4fc107.ts.net.' },
    }));
    await expect(readTailscaleSelfStatus(exec)).resolves.toEqual({
      backendState: 'Stopped',
      dnsName: 'macbook-pro.tail4fc107.ts.net',
    });
    expect(exec).toHaveBeenCalledWith(expect.any(String), ['status', '--json', '--self'], 1_500);
  });

  it('returns null when no Tailscale CLI answers', async () => {
    const exec = vi.fn(async () => { throw new Error('ENOENT'); });
    await expect(readTailscaleSelfStatus(exec)).resolves.toBeNull();
  });

  // macOS: without a shell environment (no TERM or SHLVL), the App Store
  // Tailscale binary prints this sentence and exits 0 instead of acting as a
  // CLI. Accepting it as the answer stopped the search at the first candidate
  // and dropped the MagicDNS name from every worker address advertisement.
  it('skips a candidate that answers with non-JSON text and tries the next one', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce('The Tailscale GUI failed to start: The operation couldn’t be completed. (Tailscale.CLIError error 3.)')
      .mockResolvedValue(JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'macbook-pro.tail4fc107.ts.net.' },
      }));
    await expect(readTailscaleSelfStatus(exec, 1_500, ['gui-mode', 'cli-mode'])).resolves.toEqual({
      backendState: 'Running',
      dnsName: 'macbook-pro.tail4fc107.ts.net',
    });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('returns null when every candidate answers with non-JSON text', async () => {
    const exec = vi.fn(async () => 'The Tailscale GUI failed to start');
    await expect(readTailscaleSelfStatus(exec, 1_500, ['a', 'b'])).resolves.toBeNull();
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('isTailscaleIpv6Address', () => {
  it('accepts addresses inside fd7a:115c:a1e0::/48 in any case, with or without brackets or a zone', () => {
    expect(isTailscaleIpv6Address('fd7a:115c:a1e0::1234')).toBe(true);
    expect(isTailscaleIpv6Address('FD7A:115C:A1E0:ab12::1')).toBe(true);
    expect(isTailscaleIpv6Address('[fd7a:115c:a1e0::1]')).toBe(true);
    expect(isTailscaleIpv6Address('fd7a:115c:a1e0::1%utun6')).toBe(true);
  });

  it('rejects other IPv6 addresses, IPv4 and nonsense', () => {
    expect(isTailscaleIpv6Address('fd7a:115c:a1e1::1')).toBe(false);
    expect(isTailscaleIpv6Address('fd7a:115c::1')).toBe(false);
    expect(isTailscaleIpv6Address('fe80::1')).toBe(false);
    expect(isTailscaleIpv6Address('::ffff:100.68.10.5')).toBe(false);
    expect(isTailscaleIpv6Address('100.68.10.5')).toBe(false);
    expect(isTailscaleIpv6Address('fd7a:115c:a1e0:zz::1')).toBe(false);
  });
});

describe('getTailscaleIpv6Address', () => {
  it('returns the Tailscale IPv6 address from the interface list, ignoring other addresses', () => {
    vi.mocked(os.networkInterfaces).mockReturnValueOnce({
      en0: [iface('IPv4', '192.168.0.156'), iface('IPv6', 'fe80::1')],
      utun6: [iface('IPv4', '100.68.10.5'), iface('IPv6', 'fd7a:115c:a1e0::1234')],
    });
    expect(getTailscaleIpv6Address()).toBe('fd7a:115c:a1e0::1234');
  });

  it('returns null when there is none, or only an internal one', () => {
    vi.mocked(os.networkInterfaces).mockReturnValueOnce({
      en0: [iface('IPv6', 'fe80::1')],
      lo0: [iface('IPv6', 'fd7a:115c:a1e0::1', true)],
    });
    expect(getTailscaleIpv6Address()).toBeNull();
  });
});
