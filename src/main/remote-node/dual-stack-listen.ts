import { toListenHost } from '../../shared/remote-node/host-address';
import { getLogger } from '../logging/logger';

const logger = getLogger('DualStackListen');

/** Errors a computer with IPv6 switched off gives when asked to listen on `::`. */
const IPV6_UNAVAILABLE_CODES = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT']);

/**
 * Runs `listen` on the dual-stack address for `host` (see `toListenHost`). A
 * computer without IPv6 refuses `::`; then it listens on the configured address
 * instead, as it always did, so IPv4 workers keep working.
 */
export async function listenDualStack<T>(
  host: string,
  listen: (listenHost: string) => Promise<T>,
): Promise<T> {
  const listenHost = toListenHost(host);
  try {
    return await listen(listenHost);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (listenHost === host || !code || !IPV6_UNAVAILABLE_CODES.has(code)) {
      throw error;
    }
    logger.warn('IPv6 is not available on this computer; listening on IPv4 only', { host, code });
    return listen(host);
  }
}
