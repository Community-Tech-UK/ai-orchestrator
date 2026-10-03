import { redactForSink } from '../../diagnostics/redaction';
import { getLogger } from '../../logging/logger';
import { errorDiagnostic } from '../../logging/source-diagnostics';

const logger = getLogger('SpawnTransaction');

export interface SpawnTransaction {
  readonly id: string;
  addRollback(label: string, action: () => Promise<void> | void): void;
  commit(): void;
  rollback(cause: unknown, options?: SpawnRollbackOptions): Promise<void>;
}

export interface SpawnRollbackOptions {
  /**
   * Labels whose rollback actions are discarded instead of run. Used to keep a
   * failed session's record (store entry, transcript, registrations) while
   * still releasing its runtime resources.
   */
  readonly retain?: ReadonlySet<string>;
}

interface RollbackAction {
  readonly label: string;
  readonly action: () => Promise<void> | void;
}

export interface SpawnTransactionOptions {
  readonly warn?: (message: string, metadata: Record<string, unknown>) => void;
}

export function createSpawnTransaction(
  id: string,
  options: SpawnTransactionOptions = {},
): SpawnTransaction {
  const rollbacks: RollbackAction[] = [];
  let committed = false;

  const warn = options.warn ?? ((message, metadata) => logger.warn(message, metadata));

  return {
    id,

    addRollback(label, action) {
      if (committed) {
        throw new Error(`Cannot add rollback action "${label}" after spawn transaction ${id} committed`);
      }
      rollbacks.push({ label, action });
    },

    commit() {
      committed = true;
      rollbacks.length = 0;
    },

    async rollback(cause, rollbackOptions) {
      if (committed) {
        return;
      }

      committed = true;
      for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
        const rollbackAction = rollbacks[index]!;
        if (rollbackOptions?.retain?.has(rollbackAction.label)) continue;
        try {
          await rollbackAction.action();
        } catch (error) {
          warn('Spawn transaction rollback action failed', {
            transactionId: id,
            label: rollbackAction.label,
            cause: errorDiagnostic(cause),
            error: errorDiagnostic(error),
          });
        }
      }
      rollbacks.length = 0;
    },
  };
}

/** Scrub secret-shaped values from spawn-failure text bound for logs or the transcript. */
export function redactSpawnFailureText(raw: string): string {
  const redacted = redactForSink(raw);
  return redacted.replace(
    /\b(api[_-]?key|token|secret|password|credential|authorization|cookie)\s*=\s*[^,\s]+/gi,
    '$1=<redacted-secret>',
  );
}
