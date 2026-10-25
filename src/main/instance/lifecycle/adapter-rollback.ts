import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { captureAutomaticStartupAdapter } from '../../work-admission/automatic-startup';
import type { SpawnTransaction } from './spawn-transaction';

interface AdapterRollbackPort {
  getAdapter(id: string): unknown;
  deleteAdapter(id: string): void;
  deleteDiffTracker?(id: string): void;
}

export function addAdapterRollbackResource(transaction: SpawnTransaction, instanceId: string, adapter: CliAdapter,
  deps: AdapterRollbackPort, clearActivity: () => void): void {
  const stop = captureAutomaticStartupAdapter(adapter, () => adapter.terminate(false));
  transaction.addRollback('adapter-registration', async () => {
    (adapter as { removeAllListeners?: () => void }).removeAllListeners?.();
    // Failed automatic cleanup must retain both the actual adapter and its registration.
    if (stop) await stop();
    if (deps.getAdapter(instanceId) === adapter) deps.deleteAdapter(instanceId);
    deps.deleteDiffTracker?.(instanceId);
    clearActivity();
    if (!stop) await adapter.terminate(false).catch(() => { /* manual-create rollback keeps its existing best-effort behavior */ });
  });
}
