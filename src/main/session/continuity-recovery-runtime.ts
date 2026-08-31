import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import type { ContinuityRecoveryMetadata } from './session-recovery-candidate-service';
import type { RecoverableSessionSelectionInput } from './recoverable-session-selection';
import { buildRecoverableSessionList } from './continuity-recovery-metadata';
import {
  enumerateContinuityRecoveryMetadata,
  getStateRecoveryMetadata,
} from './continuity-recovery-metadata';
import type { SessionState } from './session-continuity.types';

const NON_LIVE_STATUSES = new Set<InstanceStatus>([
  'terminated', 'failed', 'error', 'cancelled', 'superseded', 'hibernated',
]);

interface DeleteStore {
  delete(instanceId: string): unknown;
}

/** Remove private recovery state and every not-yet-published persistence artifact. */
export async function discardContinuityTracking(
  instanceId: string,
  stores: readonly DeleteStore[],
  directories: readonly string[],
): Promise<void> {
  for (const store of stores) store.delete(instanceId);
  const finalName = `${instanceId}.json`;
  for (const directory of directories) {
    const entries = await fs.promises.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    await Promise.all(entries
      .filter((name) => name === finalName
        || name.startsWith(`${finalName}.`) && name.endsWith('.tmp'))
      .map((name) => fs.promises.unlink(path.join(directory, name)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      )));
  }
}

export async function listRecoveryMetadata(options: {
  stateDir: string;
  metadataDir: string;
  modifiedSince: number;
  preferredInstanceIds: readonly string[];
  normalizeState(state: SessionState): SessionState;
  warnSkipped(skipped: number): void;
}): Promise<ContinuityRecoveryMetadata[]> {
  const result = await enumerateContinuityRecoveryMetadata(options);
  if (result.skippedCorrupt > 0) options.warnSkipped(result.skippedCorrupt);
  return result.records;
}

export function buildRuntimeRecoverableSessionList(options: {
  states: readonly SessionState[];
  dehydratedIds: ReadonlySet<string>;
  metadata: ReadonlyMap<string, { messageCount: number; hasAssistantOutput: boolean }>;
  getActivity(state: SessionState): number;
  getInstance(instanceId: string): Pick<Instance, 'status'> | undefined;
}): RecoverableSessionSelectionInput[] {
  return buildRecoverableSessionList({
    states: options.states,
    now: Date.now(),
    getActivity: options.getActivity,
    getMetadata: (state) => getStateRecoveryMetadata(
      state, options.dehydratedIds.has(state.instanceId), options.metadata.get(state.instanceId),
    ),
    isLive: (instanceId) => {
      const instance = options.getInstance(instanceId);
      return instance !== undefined && !NON_LIVE_STATUSES.has(instance.status);
    },
  });
}
