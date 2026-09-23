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
});
