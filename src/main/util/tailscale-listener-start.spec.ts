import { afterEach, describe, expect, it, vi } from 'vitest';
import { TailscaleListenerStart, isMissingTailscaleHost } from './tailscale-listener-start';

vi.mock('os', () => ({ networkInterfaces: () => ({ tunnel: [{ address: 'fd7a:115c:a1e0::2', internal: false, family: 'IPv6' }] }) }));
afterEach(() => vi.useRealTimers());

describe('TailscaleListenerStart', () => {
  it('waits for the private address, starts once and shares concurrent requests', async () => {
    vi.useFakeTimers();
    let host: string | null = null;
    const started: string[] = [];
    const start = new TailscaleListenerStart<string>();
    const open = async (address: string) => { started.push(address); return address; };
    const first = start.run(() => host, open);
    const second = start.run(() => host, open);
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toEqual([]);
    host = '100.64.0.2';
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe(host);
    expect(started).toEqual([host]);
  });
  it('cancels a delayed start on shutdown and permits a later start', async () => {
    vi.useFakeTimers();
    const start = new TailscaleListenerStart<string>();
    const opened: string[] = [];
    const pending = start.run(() => null, async host => { opened.push(host); return host; });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    start.cancel();
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect(opened).toEqual([]);
    expect(await start.run(() => '100.64.0.2', async host => host)).toBe('100.64.0.2');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('queues an immediate restart after a cancelled wait', async () => {
    vi.useFakeTimers();
    const start = new TailscaleListenerStart<string>();
    const stopped = start.run(() => null, async host => host);
    const rejected = expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
    start.cancel();
    const restarted = start.run(() => '100.64.0.2', async host => host);
    await rejected;
    expect(await restarted).toBe('100.64.0.2');
  });
  it('propagates a real listen error instead of broadening its address', async () => {
    const start = new TailscaleListenerStart<void>();
    await expect(start.run(() => '100.64.0.2', async () => { throw new Error('address in use'); })).rejects.toThrow('address in use');
  });
  it('waits only for missing Tailscale literals, including IPv6', () => {
    expect(isMissingTailscaleHost('100.64.0.2')).toBe(true);
    expect(isMissingTailscaleHost('fd7a:115c:a1e0::2')).toBe(false);
    expect(isMissingTailscaleHost('0.0.0.0')).toBe(false);
    expect(isMissingTailscaleHost('192.168.1.2')).toBe(false);
  });
});
