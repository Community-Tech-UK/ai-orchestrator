import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { Instance } from '../../../shared/types/instance.types';

type SessionDurabilityInstance = Pick<Instance, 'depth' | 'parentId'> | undefined;

export function shouldPersistProviderSession(
  cliType: string,
  instance: SessionDurabilityInstance,
): boolean {
  return cliType === 'codex'
    && instance?.depth === 0
    && instance.parentId == null;
}

export function applyProviderSessionDurability(
  cliType: string,
  instance: SessionDurabilityInstance,
  options: UnifiedSpawnOptions,
): UnifiedSpawnOptions {
  if (options.ephemeral !== undefined || !shouldPersistProviderSession(cliType, instance)) {
    return options;
  }

  return {
    ...options,
    ephemeral: false,
  };
}
