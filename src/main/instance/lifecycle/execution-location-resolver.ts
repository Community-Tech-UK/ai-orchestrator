import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { decodeLocalModelSelector } from '../../../shared/utils/local-model-selector';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import { isPooledProvider } from '../../../shared/types/provider-account.types';
import { normalizeOpenCodeAdditionalDirectories } from '../../../shared/utils/opencode-additional-directories';
import type { WorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import { getLogger } from '../../logging/logger';

const logger = getLogger('InstanceLifecycle');

/**
 * Determine where an instance should execute based on its creation config.
 * Returns local by default. Remote is selected only for an explicit forced node
 * or when placement preferences match an available worker.
 */
export function resolveExecutionLocation(config: InstanceCreateConfig, registryOverride?: Pick<WorkerNodeRegistry, 'getNode' | 'selectNode'>): ExecutionLocation {
  const directories = normalizeOpenCodeAdditionalDirectories(config.additionalDirectories,
    config.modelRuntimeTarget?.kind === 'local-model' ? 'local-model' : config.provider);
  if (directories?.length && config.nodePlacement?.requiresOpenCodeMajor === 1) throw new Error('Additional directories require OpenCode 2; version 1 placement conflicts with this request.');
  if (directories?.length && config.nodePlacement?.requiresCli && config.nodePlacement.requiresCli !== 'opencode') throw new Error('Additional directories require OpenCode; the requested worker CLI conflicts with this request.');
  const nodePlacement = config.nodePlacement && directories?.length
    ? { ...config.nodePlacement, requiresCli: 'opencode' as const, requiresOpenCodeMajor: 2 as const }
    : config.nodePlacement;
  const runtimeTarget = config.modelRuntimeTarget;
  if (runtimeTarget?.kind === 'local-model') {
    const decodedSelector = decodeLocalModelSelector(runtimeTarget.selectorId);
    if (
      decodedSelector.source !== runtimeTarget.source ||
      decodedSelector.endpointProvider !== runtimeTarget.endpointProvider ||
      decodedSelector.endpointId !== runtimeTarget.endpointId ||
      decodedSelector.modelId !== runtimeTarget.modelId
    ) {
      throw new Error('Local model runtime target does not match its selector');
    }
    const nodeId = runtimeTarget.nodeId?.trim();
    if (runtimeTarget.source === 'worker-node' && !nodeId) {
      throw new Error('Worker local-model runtime targets require a nodeId');
    }
    if (runtimeTarget.source === 'worker-node' && decodedSelector.nodeId !== nodeId) {
      throw new Error('Local model runtime target does not match its selector');
    }
    if (runtimeTarget.source === 'this-device' && runtimeTarget.nodeId !== undefined) {
      throw new Error('this-device local-model runtime targets cannot include nodeId');
    }
    if (nodeId) {
      logger.info('Resolved execution location', {
        type: 'remote',
        reason: 'localModelRuntimeTarget',
        nodeId,
      });
      return { type: 'remote', nodeId };
    }

    logger.info('Resolved execution location', {
      type: 'local',
      reason: 'localModelRuntimeTarget',
      source: runtimeTarget.source,
    });
    return { type: 'local' };
  }

  if (config.forceNodeId) {
    let registry: Pick<WorkerNodeRegistry, 'getNode' | 'selectNode'>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      registry = registryOverride ?? require('../../remote-node').getWorkerNodeRegistry();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Forced worker node "${config.forceNodeId}" is unavailable: ${detail}`);
    }
    const node = registry.getNode(config.forceNodeId);
    if (directories?.length && node?.capabilities.openCodeMajor !== 2) throw new Error('Additional directories require a worker with OpenCode 2.');
    if (node?.status === 'connected' || node?.status === 'degraded') {
      logger.info('Resolved execution location', {
        type: 'remote',
        reason: 'forceNodeId',
        nodeId: config.forceNodeId,
        nodeStatus: node.status,
      });
      return { type: 'remote', nodeId: config.forceNodeId };
    }
    throw new Error(
      `Forced worker node "${config.forceNodeId}" is unavailable (${node?.status ?? 'not found'})`,
    );
  }

  if (nodePlacement) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const registry = registryOverride ?? require('../../remote-node').getWorkerNodeRegistry();
      // An explicitly chosen Claude/Codex account prefers a node that has that
      // profile. Never the other way round: placement does not change the account.
      const node = registry.selectNode(
        config.accountProfileId && isPooledProvider(config.provider)
          ? { ...nodePlacement, prefersAccountProfile: { provider: config.provider, profileId: config.accountProfileId } }
          : nodePlacement,
      );
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
