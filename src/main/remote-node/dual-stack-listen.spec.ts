import { describe, expect, it, vi } from 'vitest';
import { listenDualStack } from './dual-stack-listen';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`listen ${code}`), { code });
}

describe('listenDualStack', () => {
  it('listens on the IPv6 wildcard when the host is the IPv4 wildcard', async () => {
    const listen = vi.fn(async (host: string) => host);
    await expect(listenDualStack('0.0.0.0', listen)).resolves.toBe('::');
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith('::');
  });

  it('leaves any other host exactly as configured', async () => {
    const listen = vi.fn(async (host: string) => host);
    await expect(listenDualStack('127.0.0.1', listen)).resolves.toBe('127.0.0.1');
    await expect(listenDualStack('192.168.1.5', listen)).resolves.toBe('192.168.1.5');
    await expect(listenDualStack('::', listen)).resolves.toBe('::');
  });

  it('falls back to the configured IPv4 wildcard on a computer without IPv6', async () => {
    const listen = vi.fn(async (host: string) => {
      if (host === '::') throw errnoError('EAFNOSUPPORT');
      return host;
    });
    await expect(listenDualStack('0.0.0.0', listen)).resolves.toBe('0.0.0.0');
    expect(listen.mock.calls.map(([host]) => host)).toEqual(['::', '0.0.0.0']);
  });

  it('does not hide other failures, such as the port being taken', async () => {
    const listen = vi.fn(async () => { throw errnoError('EADDRINUSE'); });
    await expect(listenDualStack('0.0.0.0', listen)).rejects.toThrow('EADDRINUSE');
    expect(listen).toHaveBeenCalledTimes(1);
  });
});
