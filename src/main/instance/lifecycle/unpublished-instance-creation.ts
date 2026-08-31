import type { Instance } from '../../../shared/types/instance.types';
import type { SpawnTransaction } from './spawn-transaction';

export interface UnpublishedInstanceCreation {
  readonly instance: Instance;
  publish(): Promise<void>;
  rollback(cause: unknown): Promise<void>;
}

export interface InternalInstanceCreation {
  readonly instance: Instance;
  readonly publish?: () => Promise<void>;
  readonly rollback?: (cause: unknown) => Promise<void>;
}

interface UnpublishedCreationDeps {
  instance: Instance;
  backgroundInit: Promise<void>;
  backgroundSucceeded(): boolean;
  abortController: AbortController;
  spawnTransaction: SpawnTransaction;
  isCrashRecovery: boolean;
  publishInstance(): void;
  releasePendingUpdate(): void;
}

/** Own the unpublished runtime until readiness and recovery setup both succeed. */
export function createUnpublishedInstanceCreation(
  deps: UnpublishedCreationDeps,
): UnpublishedInstanceCreation {
  let state: 'pending' | 'publishing' | 'published' | 'publication-failed'
    | 'rolling-back' | 'rolled-back' = 'pending';
  let publicationPromise: Promise<void> | undefined;
  let rollbackPromise: Promise<void> | undefined;
  return {
    instance: deps.instance,
    publish: (): Promise<void> => {
      if (state === 'published') return Promise.resolve();
      if (state === 'publishing' && publicationPromise) return publicationPromise;
      if (state === 'rolling-back' || state === 'rolled-back' || !deps.backgroundSucceeded()) {
        return Promise.reject(new Error('Cannot publish an incomplete recovery instance'));
      }
      state = 'publishing';
      publicationPromise = Promise.resolve().then(() => {
        try {
          deps.publishInstance();
          deps.spawnTransaction.commit();
          deps.releasePendingUpdate();
          state = 'published';
        } catch (error) {
          state = 'publication-failed';
          throw error;
        }
      });
      return publicationPromise;
    },
    rollback: (cause: unknown): Promise<void> => {
      if (state === 'published' || state === 'rolled-back') return Promise.resolve();
      if (state === 'publishing') {
        return Promise.reject(new Error('Cannot roll back while publication is in progress'));
      }
      if (state === 'rolling-back' && rollbackPromise) return rollbackPromise;
      state = 'rolling-back';
      rollbackPromise = (async () => {
        deps.abortController.abort();
        await deps.backgroundInit.catch(() => undefined);
        await deps.spawnTransaction.rollback(deps.isCrashRecovery
          ? new Error('Recovery runtime rollback')
          : cause);
        state = 'rolled-back';
      })();
      return rollbackPromise;
    },
  };
}
