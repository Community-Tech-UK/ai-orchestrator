import type { CompactionBoundaryOptions } from '../../shared/types/compaction-preview.types';

/** In-process recovery authority; never serialized into prompts or IPC payloads. */
export interface CompactionRecoveryOwner {
  signal?: AbortSignal;
  /** Logical request lifetime, independent of an intentional runtime replacement. */
  assertCurrent(): void;
  /** Original request/provider identity, checked under the restart mutex before teardown. */
  assertBeforeRestart(): void;
  /** Original caller eligibility, rechecked at the replacement's actual input boundary. */
  assertProviderDispatchCurrent(): void;
}

/** Main-process execution options extend the serializable manual-compaction boundary. */
export interface CompactionExecutionOptions extends CompactionBoundaryOptions {
  recoveryOwner?: CompactionRecoveryOwner;
}
