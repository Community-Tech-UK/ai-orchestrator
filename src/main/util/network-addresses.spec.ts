import { describe, expect, it, vi } from 'vitest';
import { readTailscaleSelfStatus } from './network-addresses';

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
