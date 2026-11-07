import { describe, expect, it, vi } from 'vitest';
import { LocalNetworkEvidence, localNetworkBlockedMessage } from './local-network-evidence';
import { isLocalNetworkAddress } from './local-network-address';

vi.mock('./router-reachability', () => ({
  isRouterUnreachable: vi.fn(async () => {
    throw new Error('specs must not probe the real router');
  }),
}));

function unreachable(address?: string): NodeJS.ErrnoException {
  const error = new Error('connect EHOSTUNREACH') as NodeJS.ErrnoException & { address?: string };
  error.code = 'EHOSTUNREACH';
  if (address) error.address = address;
  return error;
}

describe('LocalNetworkEvidence', () => {
  it('names the macOS setting when a home-network address and the router are both unreachable', async () => {
    const evidence = new LocalNetworkEvidence('darwin', async () => true);

    evidence.noteFailure('ws://192.168.0.95:4878', unreachable());
    expect(evidence.current).toBe('unknown');
    await evidence.settle();

    expect(evidence.current).toBe('blocked');
    expect(evidence.notice()).toBe(localNetworkBlockedMessage());
    expect(evidence.notice()).toContain('System Settings > Privacy & Security > Local Network');
  });

  it('blames nothing when the router answers, because the main Mac is just asleep or off', async () => {
    const evidence = new LocalNetworkEvidence('darwin', async () => false);

    evidence.noteFailure('ws://192.168.0.95:4878', unreachable());
    await evidence.settle();

    expect(evidence.current).toBe('unknown');
    expect(evidence.notice()).toBeUndefined();
  });

  it('clears an earlier block once the router answers again', async () => {
    const routerBlocked = vi.fn<() => Promise<boolean | undefined>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const evidence = new LocalNetworkEvidence('darwin', routerBlocked);

    evidence.noteFailure('ws://192.168.0.95:4878', unreachable());
    await evidence.settle();
    expect(evidence.current).toBe('blocked');

    evidence.noteFailure('ws://192.168.0.95:4878', unreachable());
    await evidence.settle();
    expect(evidence.current).toBe('unknown');
  });

  it('uses the resolved address for a .local name, and checks the router only once per failure', async () => {
    const routerBlocked = vi.fn(async () => true);
    const evidence = new LocalNetworkEvidence('darwin', routerBlocked);

    evidence.noteFailure('ws://macbook-pro-2.local:4878', unreachable('192.168.0.95'));
    await evidence.settle();
    await evidence.settle();

    expect(evidence.current).toBe('blocked');
    expect(routerBlocked).toHaveBeenCalledTimes(1);
  });

  it('never suspects Tailscale, other errors or other platforms', async () => {
    const routerBlocked = vi.fn(async () => true);
    const mac = new LocalNetworkEvidence('darwin', routerBlocked);
    mac.noteFailure('ws://100.68.10.5:4878', unreachable());
    mac.noteFailure('ws://[fd7a:115c:a1e0::bd01:a1d]:4878', unreachable());
    const refused = new Error('refused') as NodeJS.ErrnoException;
    refused.code = 'ECONNREFUSED';
    mac.noteFailure('ws://192.168.0.95:4878', refused);
    await mac.settle();
    expect(mac.current).toBe('unknown');

    const windows = new LocalNetworkEvidence('win32', routerBlocked);
    windows.noteFailure('ws://192.168.0.95:4878', unreachable());
    await windows.settle();
    expect(windows.notice()).toBeUndefined();
    expect(routerBlocked).not.toHaveBeenCalled();
  });

  it('clears once a home-network address answers, but not for a Tailscale answer', async () => {
    const evidence = new LocalNetworkEvidence('darwin', async () => true);
    evidence.noteFailure('ws://192.168.0.95:4878', unreachable());
    await evidence.settle();

    evidence.noteReachable('ws://[fd7a:115c:a1e0::bd01:a1d]:4878', 'fd7a:115c:a1e0::bd01:a1d');
    expect(evidence.current).toBe('blocked');

    evidence.noteReachable('ws://macbook-pro-2.local:4878', '::ffff:192.168.0.95');
    expect(evidence.current).toBe('reachable');
    expect(evidence.notice()).toBeUndefined();
  });
});

describe('isLocalNetworkAddress', () => {
  it.each([
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.0.95', true],
    ['169.254.10.1', true],
    ['100.68.10.5', false],
    ['8.8.8.8', false],
    ['fe80::1', true],
    ['fd12:3456::1', true],
    ['fd7a:115c:a1e0::bd01:a1d', false],
    ['2001:db8::1', false],
    ['macbook.local', false],
  ])('%s → %s', (address, expected) => {
    expect(isLocalNetworkAddress(address)).toBe(expected);
  });
});
