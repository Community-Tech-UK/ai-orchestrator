import { isBrowserExtensionCommandId } from '../browser-gateway/browser-extension-command-delivery';
import { getLogger } from '../logging/logger';
import { NODE_TO_COORDINATOR, type RpcRequest } from './worker-node-rpc';

const logger = getLogger('BrowserCommandReplies');

/** Record arrivals before auth, schema or rate-limit guards can discard them. */
export function recordBrowserCommandReplyArrival(nodeId: string, request: RpcRequest): void {
  const reply = request.method === NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RECEIVED ? 'receipt'
    : request.method === NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT ? 'result' : undefined;
  if (!reply || !request.params || typeof request.params !== 'object') return;
  const commandId = (request.params as Record<string, unknown>)['commandId'];
  if (!isBrowserExtensionCommandId(commandId)) return;
  // No request ID, auth token, runtime evidence or reply body from the peer.
  logger.info('Browser command reply arrived', { nodeId, commandId, reply });
}

/** Runtime-incompatible receipts are evidence of a handoff, never an accepted ack. */
export function recordBrowserCommandReceiptRejection(nodeId: string, commandId: string): void {
  if (!isBrowserExtensionCommandId(commandId)) return;
  logger.info('Browser command receipt rejected', {
    nodeId, commandId, accepted: false, reason: 'runtime_incompatible',
  });
}
