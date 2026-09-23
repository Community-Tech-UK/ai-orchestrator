import { COORDINATOR_TO_NODE } from '../main/remote-node/worker-node-rpc';
import { CoordinatorAddressesParamsSchema } from '../main/remote-node/rpc-schemas';
import { normalizeCoordinatorUrl, type WorkerConfig } from './worker-config';
import type { RpcMessage } from './worker-rpc-types';

/**
 * Extract the URL list from a `node.coordinatorAddresses` notification, or null
 * when `msg` is some other message or fails validation.
 *
 * Requires scope=service: these URLs decide where the worker sends its
 * credentials on the next reconnect, so only the privileged channel may set them.
 */
export function parseCoordinatorAddressesNotification(msg: RpcMessage): string[] | null {
  if (msg.method !== COORDINATOR_TO_NODE.COORDINATOR_ADDRESSES || msg.id !== undefined) return null;
  if (msg.scope !== 'service') return null;
  const parsed = CoordinatorAddressesParamsSchema.safeParse(msg.params ?? {});
  return parsed.success ? parsed.data.urls : null;
}

/**
 * Replace the worker's advertised coordinator URLs. Returns true when the stored
 * list changed (so the caller knows to persist).
 *
 * When the worker's configured route is wss://, plain ws:// advertisements are
 * dropped: an advertisement must never downgrade a TLS-pinned worker to a
 * cleartext route that would carry its bearer token.
 */
export function applyAdvertisedCoordinatorUrls(config: WorkerConfig, urls: string[]): boolean {
  const requireTls = normalizeCoordinatorUrl(config.coordinatorUrl)?.startsWith('wss://') ?? false;
  const next: string[] = [];
  for (const raw of urls) {
    const url = normalizeCoordinatorUrl(raw);
    if (!url || (requireTls && !url.startsWith('wss://')) || next.includes(url)) continue;
    next.push(url);
  }
  if (next.length === 0) return false;
  const previous = config.advertisedCoordinatorUrls ?? [];
  if (previous.length === next.length && previous.every((url, index) => url === next[index])) {
    return false;
  }
  config.advertisedCoordinatorUrls = next;
  return true;
}
