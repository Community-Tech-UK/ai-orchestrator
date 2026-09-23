import { getLogger } from '../logging/logger';
import { COORDINATOR_TO_NODE, type RpcScope } from './worker-node-rpc';

const logger = getLogger('CoordinatorAddressAdvertiser');

export interface CoordinatorAddressAdvertiserDeps {
  /** Current coordinator URLs, best-first. */
  resolveUrls: () => Promise<string[]>;
  sendNotification: (nodeId: string, method: string, params: unknown, scope: RpcScope) => boolean;
}

/**
 * Tell a freshly registered worker every address this coordinator can currently
 * be reached on.
 *
 * Why: a worker paired against one LAN IP keeps that IP forever. On 2026-09-17
 * the host's DHCP lease moved, the worker's only fallback went stale, and from
 * then on it could reach the coordinator over Tailscale alone. When Tailscale
 * was off it stayed offline for hours with a working LAN path available.
 *
 * Fire-and-forget: a failure here only means the worker keeps the addresses it
 * already has, so it is logged and never allowed to affect registration.
 */
export async function advertiseCoordinatorAddresses(
  nodeId: string,
  deps: CoordinatorAddressAdvertiserDeps,
): Promise<void> {
  try {
    const urls = await deps.resolveUrls();
    if (urls.length === 0) return;
    const delivered = deps.sendNotification(
      nodeId,
      COORDINATOR_TO_NODE.COORDINATOR_ADDRESSES,
      { urls },
      'service',
    );
    if (delivered) {
      logger.info('Advertised coordinator addresses to node', { nodeId, urls });
    }
  } catch (error) {
    logger.warn('Could not advertise coordinator addresses to node', {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
