import type { ComputerUseAutonomyLevel } from '../../../shared/types/desktop-gateway-settings.types';

const MAX_ENTRIES = 1_000;
const modesByInstanceId = new Map<string, ComputerUseAutonomyLevel>();

export type ComputerUseAutonomySource = 'global' | 'session';

export interface ResolvedComputerUseAutonomy {
  level: ComputerUseAutonomyLevel;
  source: ComputerUseAutonomySource;
}

export function resolveComputerUseAutonomy(
  perInstance: ComputerUseAutonomyLevel | undefined,
  globalLevel: ComputerUseAutonomyLevel,
): ResolvedComputerUseAutonomy {
  return perInstance === undefined
    ? { level: globalLevel, source: 'global' }
    : { level: perInstance, source: 'session' };
}

export function setInstanceComputerUseMode(
  instanceId: string,
  mode: ComputerUseAutonomyLevel | undefined,
): void {
  modesByInstanceId.delete(instanceId);
  if (mode === undefined) {
    return;
  }
  modesByInstanceId.set(instanceId, mode);
  if (modesByInstanceId.size > MAX_ENTRIES) {
    const oldest = modesByInstanceId.keys().next().value;
    if (oldest !== undefined) {
      modesByInstanceId.delete(oldest);
    }
  }
}

export function getInstanceComputerUseMode(
  instanceId: string,
): ComputerUseAutonomyLevel | undefined {
  return modesByInstanceId.get(instanceId);
}

export function removeInstanceComputerUseMode(instanceId: string): void {
  modesByInstanceId.delete(instanceId);
}

export function _resetComputerUseModeRegistryForTesting(): void {
  modesByInstanceId.clear();
}
