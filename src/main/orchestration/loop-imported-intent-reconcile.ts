/**
 * Boot-time reconciliation of imported terminal-intent orphans.
 *
 * Closes the residual crash window where the DB transaction committed but the
 * source-file rename in `<controlDir>/imported/` had not completed. Extracted
 * from `loop-coordinator.ts` to keep that file inside its size ceiling; the
 * behaviour is unchanged.
 */

import { getLogger } from '../logging/logger';
import { listArchivedImportedIntents } from './loop-control';
import type { LoopControlRuntime } from './loop-control';
import type { LoopTerminalIntent } from '../../shared/types/loop.types';

const logger = getLogger('LoopCoordinator');

/**
 * Returns the orphan intents found on disk, having run `persistHook` on each.
 * Files stay in `imported/`, so the call is safe to repeat. With no hook
 * registered the orphans are returned unpersisted and the gap is logged —
 * silently dropping a terminal intent is never acceptable.
 */
export async function reconcileImportedIntentOrphans(args: {
  loopRunId: string;
  loopControl: LoopControlRuntime;
  persistedIntentIds: ReadonlySet<string>;
  persistHook: ((intent: LoopTerminalIntent) => Promise<void> | void) | null;
}): Promise<LoopTerminalIntent[]> {
  const { loopRunId, loopControl, persistedIntentIds, persistHook } = args;
  const onDisk = await listArchivedImportedIntents(loopControl);
  const orphans = onDisk.filter((intent) => !persistedIntentIds.has(intent.id));
  if (orphans.length === 0) return [];
  if (!persistHook) {
    logger.warn('reconcileImportedOrphans: no persist hook registered; orphans cannot be recovered', {
      loopRunId,
      orphanCount: orphans.length,
    });
    return orphans;
  }
  const persisted: LoopTerminalIntent[] = [];
  for (const intent of orphans) {
    try {
      await persistHook(intent);
      persisted.push(intent);
    } catch (err) {
      logger.warn('reconcileImportedOrphans: persist hook failed for orphan', {
        loopRunId,
        intentId: intent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (persisted.length > 0) {
    logger.info('Reconciled imported intent orphans on boot', {
      loopRunId,
      recovered: persisted.length,
      totalOnDisk: onDisk.length,
    });
  }
  return persisted;
}
