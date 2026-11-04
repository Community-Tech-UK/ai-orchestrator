import * as net from 'net';
import { describe, expect, it } from 'vitest';
import {
  allocateLivetestPort,
  derivedLivetestPort,
  isLoopbackPortFree,
  LIVETEST_PORT_COUNT,
  LIVETEST_PORT_FIRST,
} from './plan-queue-livetest-port';

describe('allocateLivetestPort', () => {
  it('starts from the port the item id derives and keeps it when it is free', async () => {
    const saved: number[] = [];
    const port = await allocateLivetestPort('item-aaaa1111', null, { portsInUse: () => [], isFree: async () => true, persist: (p) => saved.push(p) });
    expect(port).toBe(derivedLivetestPort('item-aaaa1111'));
    expect(saved).toEqual([port]);
  });

  it('skips a port something is listening on and a port recorded on another live item', async () => {
    const first = derivedLivetestPort('item-bbbb2222');
    const busy = new Set([first]);
    const port = await allocateLivetestPort('item-bbbb2222', null, {
      portsInUse: () => [first + 1],
      isFree: async (p) => !busy.has(p),
      persist: () => undefined,
    });
    expect(port).toBe(LIVETEST_PORT_FIRST + ((first - LIVETEST_PORT_FIRST + 2) % LIVETEST_PORT_COUNT));
  });

  it('reuses its recorded port while it is still free, and replaces it when it is not', async () => {
    const reuse = await allocateLivetestPort('item-cccc3333', 9777, { portsInUse: () => [], isFree: async () => true, persist: () => undefined });
    expect(reuse).toBe(9777);
    const replaced = await allocateLivetestPort('item-cccc3333', 9777, { portsInUse: () => [], isFree: async (p) => p !== 9777, persist: () => undefined });
    expect(replaced).not.toBe(9777);
  });

  it('wraps around the range and fails plainly when every port is taken', async () => {
    const lastStart = Array.from({ length: LIVETEST_PORT_COUNT }, (_, i) => LIVETEST_PORT_FIRST + i);
    await expect(allocateLivetestPort('item-dddd4444', null, { portsInUse: () => lastStart, isFree: async () => true, persist: () => undefined }))
      .rejects.toThrow(/No free dev-app port/);
  });

  it('never hands two workers starting together the same port', async () => {
    const [idA, idB] = ['item-aaaa1111', 'item-bbbb2222'];
    // Only two ports are free, and both items would reach the lower one first.
    const free = new Set([LIVETEST_PORT_FIRST, LIVETEST_PORT_FIRST + 1]);
    expect(derivedLivetestPort(idA)).toBeGreaterThan(LIVETEST_PORT_FIRST + 1);
    expect(derivedLivetestPort(idB)).toBeGreaterThan(LIVETEST_PORT_FIRST + 1);
    const recorded = new Map<string, number>();
    const deps = (id: string) => ({
      portsInUse: (except: string) => [...recorded].filter(([key]) => key !== except).map(([, port]) => port),
      isFree: async (port: number) => free.has(port),
      persist: (port: number) => { recorded.set(id, port); },
    });
    const [a, b] = await Promise.all([allocateLivetestPort(idA, null, deps(idA)), allocateLivetestPort(idB, null, deps(idB))]);
    expect(new Set([a, b])).toEqual(free);
  });
});

describe('isLoopbackPortFree', () => {
  it('reports a port with a listener as taken and a closed one as free', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const { port } = server.address() as net.AddressInfo;
    expect(await isLoopbackPortFree(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isLoopbackPortFree(port)).toBe(true);
  });
});
