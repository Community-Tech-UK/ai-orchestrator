/**
 * Dev-app debugging ports for livetest items.
 *
 * A port derived from the item id alone clashed with another item's about 7% of the time with
 * eight workers. Instead each port is checked free on this machine and not recorded on another
 * item that is still in play. Allocation is serialised so two workers starting together cannot
 * both be given the same free port.
 */

import * as net from 'net';

export const LIVETEST_PORT_FIRST = 9500;
export const LIVETEST_PORT_COUNT = 400;

/** The port the item id alone would pick. Used for items recorded before ports were saved, and as the search start. */
export function derivedLivetestPort(itemId: string): number {
  let hash = 0;
  for (const char of itemId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return LIVETEST_PORT_FIRST + (hash % LIVETEST_PORT_COUNT);
}

/** True when nothing is listening on the loopback port (the dev app's debugging port binds there). */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export interface LivetestPortDeps {
  /** Ports recorded on other items that are still in play. */
  portsInUse(exceptItemId: string): readonly number[];
  isFree?(port: number): Promise<boolean>;
  /** Records the chosen port on the item. Runs before the next allocation starts, so it is seen by it. */
  persist(port: number): void;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * The item's port: its recorded one while it is still free and unclaimed, otherwise the first free
 * port searching from the item's derived start. Throws when the whole range is taken.
 */
export function allocateLivetestPort(itemId: string, recorded: number | null | undefined, deps: LivetestPortDeps): Promise<number> {
  const run = chain.then(async () => {
    const isFree = deps.isFree ?? isLoopbackPortFree;
    const taken = new Set(deps.portsInUse(itemId));
    const start = derivedLivetestPort(itemId) - LIVETEST_PORT_FIRST;
    const candidates = [
      ...(recorded ? [recorded] : []),
      ...Array.from({ length: LIVETEST_PORT_COUNT }, (_, i) => LIVETEST_PORT_FIRST + ((start + i) % LIVETEST_PORT_COUNT)),
    ];
    for (const port of candidates) {
      if (!taken.has(port) && await isFree(port)) {
        deps.persist(port);
        return port;
      }
    }
    throw new Error(`No free dev-app port between ${LIVETEST_PORT_FIRST} and ${LIVETEST_PORT_FIRST + LIVETEST_PORT_COUNT - 1}`);
  });
  chain = run.catch(() => undefined);
  return run;
}
