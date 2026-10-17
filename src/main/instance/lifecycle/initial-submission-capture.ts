import type { Instance, OutputMessage } from '../../../shared/types/instance.types';

// Main-only provenance cannot be copied into imported, serialized or forked instance records.
const currentSubmissions = new WeakMap<Instance, string>();
export function markFreshInitialSubmission(instance: Instance, message: OutputMessage): void {
  currentSubmissions.set(instance, JSON.stringify(message));
}
export function hasFreshInitialSubmission(instance: Instance): boolean {
  const expected = currentSubmissions.get(instance);
  return expected !== undefined && instance.outputBuffer.length === 1
    && JSON.stringify(instance.outputBuffer[0]) === expected;
}
