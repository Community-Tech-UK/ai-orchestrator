/** The transport boundary only; model validation and continuity stay in RuntimeReconciler. */
import { RemoteCliAdapter } from '../../cli/adapters/remote-cli-adapter';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { Instance } from '../../../shared/types/instance.types';
import type { RuntimeDiff, RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { hasRemoteRpcErrorCode } from '../../cli/adapters/remote-model-change-rpc';
import { RPC_ERROR_CODES } from '../../remote-node/worker-node-rpc';
import { isAdapterStopping } from '../../providers/adapter-stop-state';

export function prepareRemoteModelChange(
  deps: RuntimeReconcilerDeps,
  instance: Instance,
  oldAdapter: CliAdapter | undefined,
  diff: RuntimeDiff,
  localModelTarget: boolean,
) {
  if (!(oldAdapter instanceof RemoteCliAdapter) || diff.providerChanged || diff.accountProfileChanged
    || diff.copilotAccountChanged || diff.runtimeTargetChanged || localModelTarget
    || (!diff.modelChanged && !diff.reasoningChanged)) return undefined;
  oldAdapter.assertModelChangeSupported();
  const previousStatus = instance.status;
  const previous = {
    sessionId: instance.sessionId, currentModel: instance.currentModel, reasoningEffort: instance.reasoningEffort,
    contextUsage: instance.contextUsage, yoloMode: instance.yoloMode, executionLocation: instance.executionLocation,
    modelRuntimeTarget: instance.modelRuntimeTarget, runtimeSummary: instance.runtimeSummary, processId: instance.processId,
  };
  let mayRetry = false;
  return {
    canRetryAfterFailure: () => mayRetry,
    async spawn(adapter: CliAdapter): Promise<number> {
      if (!(adapter instanceof RemoteCliAdapter)) throw new Error('The replacement must run on the same worker.');
      try {
        const pid = await oldAdapter.changeModel(adapter);
        mayRetry = true;
        return pid;
      } catch (error) {
        mayRetry = hasRemoteRpcErrorCode(error, RPC_ERROR_CODES.MODEL_CHANGE_FAILED_AFTER_TEARDOWN);
        throw error;
      }
    },
    restoreIfUnacknowledged(): boolean {
      if (!oldAdapter.isRunning() || isAdapterStopping(oldAdapter)) return false;
      Object.assign(instance, previous);
      deps.setupAdapterEvents(instance.id, oldAdapter);
      deps.setAdapter(instance.id, oldAdapter);
      // Initializing may return directly to ready/idle/error, but a parked
      // input prompt must pass through idle to preserve the state machine.
      if (instance.status === 'initializing' && previousStatus === 'waiting_for_input') deps.transitionState(instance, 'idle');
      deps.transitionState(instance, previousStatus);
      deps.queueUpdate(instance.id, instance.status, instance.contextUsage, undefined, undefined,
        undefined, instance.executionLocation, undefined, undefined, instance.currentModel);
      return true;
    },
  };
}
