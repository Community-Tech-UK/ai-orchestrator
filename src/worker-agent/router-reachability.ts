import { execFile } from 'child_process';
import * as net from 'net';
import { isLocalNetworkAddress } from './local-network-address';

/**
 * Whether the default router refuses a connection with EHOSTUNREACH: true when
 * it does, false when anything else happens (it answers, refuses or times
 * out), undefined when there is no home-network router to try.
 */
export async function isRouterUnreachable(): Promise<boolean | undefined> {
  const router = await defaultRouter();
  if (!router || !isLocalNetworkAddress(router)) {
    return undefined;
  }
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: router, port: 53 });
    const finish = (blocked: boolean): void => {
      socket.destroy();
      resolve(blocked);
    };
    socket.setTimeout(1_500, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'EHOSTUNREACH'));
  });
}

function defaultRouter(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/sbin/route', ['-n', 'get', 'default'], { timeout: 2_000 }, (error, stdout) => {
      resolve(error ? undefined : /gateway:\s*(\S+)/.exec(stdout)?.[1]);
    });
  });
}
