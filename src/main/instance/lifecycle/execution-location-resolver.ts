import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('InstanceLifecycle');

/**
 * Determine where an instance should execute based on its creation config.
 * Returns local by default. Remote is selected only for an explicit forced node
 * or when placement preferences match an available worker.
 */
export function resolveExecutionLocation(config: InstanceCreateConfig): ExecutionLocation {
  if (config.forceNodeId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWorkerNodeRegistry } = require('../../remote-node');
      const registry = getWorkerNodeRegistry();
      const node = registry.getNode(config.forceNodeId);
      if (node?.status === 'connected' || node?.status === 'degraded') {
        logger.info('Resolved execution location', {
          type: 'remote',
          reason: 'forceNodeId',
          nodeId: config.forceNodeId,
          nodeStatus: node.status,
        });
        return { type: 'remote', nodeId: config.forceNodeId };
      }
      logger.warn('Forced nodeId not reachable — falling through to local', {
        nodeId: config.forceNodeId,
        nodeStatus: node?.status ?? 'not-found',
      });
    } catch (err) {
      logger.warn('Remote node module unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (config.nodePlacement) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWorkerNodeRegistry } = require('../../remote-node');
      const registry = getWorkerNodeRegistry();
      const node = registry.selectNode(config.nodePlacement);
      if (node) {
        logger.info('Resolved execution location', {
          type: 'remote',
          reason: 'nodePlacement',
          nodeId: node.id,
        });
        return { type: 'remote', nodeId: node.id };
      }
    } catch {
      // Remote node module not available — fall through to local.
    }
  }

  logger.info('Resolved execution location', {
    type: 'local',
    forceNodeId: config.forceNodeId ?? null,
    hasNodePlacement: Boolean(config.nodePlacement),
  });
  return { type: 'local' };
}
