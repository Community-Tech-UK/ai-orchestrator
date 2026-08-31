import * as fs from 'node:fs';
import type { Stats } from 'node:fs';
import { writeContinuityPayloadAsyncAtomic } from './continuity-recovery-metadata';
import { getSessionMutex } from './session-mutex';

export interface SessionContinuityPersistenceOperations {
  writePayloadAtomic(
    filePath: string,
    serialized: string,
    canCommit?: () => boolean,
  ): Promise<boolean>;
  statStateFile(filePath: string): Promise<Stats>;
  acquireSaveLock(instanceId: string, source: string): Promise<() => void>;
}

/** Typed persistence seams for deterministic crash/interleaving tests. */
export function createSessionContinuityPersistenceOperations(
  overrides: Partial<SessionContinuityPersistenceOperations> = {},
): SessionContinuityPersistenceOperations {
  return {
    writePayloadAtomic: overrides.writePayloadAtomic ?? writeContinuityPayloadAsyncAtomic,
    statStateFile: overrides.statStateFile ?? ((filePath) => fs.promises.stat(filePath)),
    acquireSaveLock: overrides.acquireSaveLock
      ?? ((instanceId, source) => getSessionMutex().acquire(instanceId, source)),
  };
}
