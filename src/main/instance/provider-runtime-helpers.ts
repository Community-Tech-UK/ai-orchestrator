/**
 * Pure helpers for building provider runtime envelopes from instance state.
 *
 * Split out of instance-manager.ts. Neither function reads InstanceManager
 * state (only the module-level logger), so they live here as free functions
 * and are unit-tested directly.
 */
import { getLogger } from '../logging/logger';
import type { Instance } from '../../shared/types/instance.types';
import type {
  ProviderName,
  ProviderRuntimeEvent,
} from '@contracts/types/provider-runtime-events';

const logger = getLogger('ProviderRuntimeHelpers');

export function resolveRuntimeEventTurnId(
  event: ProviderRuntimeEvent,
  instance?: Instance,
): string | undefined {
  if (event.kind === 'output' && typeof event.metadata?.['turnId'] === 'string') {
    return event.metadata['turnId'];
  }

  return instance?.activeTurnId;
}

export function resolveProviderName(
  instanceId: string,
  explicitProvider: ProviderName | undefined,
  instanceProvider: Instance['provider'] | undefined,
): ProviderName | null {
  if (explicitProvider) {
    return explicitProvider;
  }

  switch (instanceProvider) {
    case 'claude':
    case 'codex':
    case 'gemini':
    case 'antigravity':
    case 'copilot':
    case 'cursor':
    case 'grok':
      return instanceProvider;
    case 'auto':
    case undefined:
      logger.debug('Skipping provider runtime event before provider resolution', { instanceId });
      return null;
    default:
      logger.warn('Unsupported provider for runtime envelope', {
        instanceId,
        provider: instanceProvider,
      });
      return null;
  }
}
