import type { ProviderTurnEndingReason } from '@contracts/types/provider-runtime-events';

// Instance identity survives compaction and provider respawn. An adapter/thread ID does not.
const lastEndings = new Map<string, ProviderTurnEndingReason>();
const recoveryEpochs = new Map<string, number>();
let nextRecoveryEpoch = 0;

/** Invalidated at the actual user-input/Stop boundary, before asynchronous work. */
export function captureInstanceRecoveryEpoch(instanceId: string): number {
  let epoch = recoveryEpochs.get(instanceId);
  if (epoch === undefined) { epoch = ++nextRecoveryEpoch; recoveryEpochs.set(instanceId, epoch); }
  return epoch;
}
export function isInstanceRecoveryEpochCurrent(instanceId: string, epoch: number): boolean {
  return recoveryEpochs.get(instanceId) === epoch;
}
export function invalidateInstanceRecoveryEpoch(instanceId: string): void {
  recoveryEpochs.delete(instanceId);
}

export function recordInstanceTurnEnding(instanceId: string, reason: ProviderTurnEndingReason): void {
  if (reason === 'completed') lastEndings.delete(instanceId);
  else lastEndings.set(instanceId, reason);
}

export function getInstanceTurnEnding(instanceId: string): ProviderTurnEndingReason | undefined {
  return lastEndings.get(instanceId);
}

export function clearInstanceTurnEnding(instanceId: string): void {
  lastEndings.delete(instanceId);
}
