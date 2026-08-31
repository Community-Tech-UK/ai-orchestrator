import { getLogger } from '../../logging/logger';
import { createSpawnTransaction, type SpawnTransaction } from './spawn-transaction';

const logger = getLogger('InstanceLifecycle');

/** Redact rollback diagnostics for transactions seeded from a recovery cursor. */
export function createInstanceSpawnTransaction(
  label: string,
  isCrashRecovery: boolean,
): SpawnTransaction {
  if (!isCrashRecovery) return createSpawnTransaction(label);
  return createSpawnTransaction(label, {
    warn: (message, metadata) => logger.warn(message, {
      transactionId: metadata['transactionId'],
      label: metadata['label'],
      recoverySession: true,
    }),
  });
}
