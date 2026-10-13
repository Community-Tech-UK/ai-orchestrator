/** Captured-runtime ownership across reconciliation awaits and observer callbacks. */
import type { Instance } from '../../../shared/types/instance.types';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RuntimeReconciler');

export function assertRuntimeChangeOwner(deps: Pick<RuntimeReconcilerDeps, 'getInstance'>, instance: Instance): void {
  if (deps.getInstance(instance.id) !== instance || instance.status === 'terminated'
    || instance.status === 'failed' || instance.status === 'superseded') {
    throw new Error('This session is no longer available after the runtime change.');
  }
}

/** Every probe, including an inconclusive retry, must still belong to the captured runtime. */
export function evaluateOwnedResumeHealth(
  deps: Pick<RuntimeReconcilerDeps, 'getInstance' | 'evaluateResumeHealth'>,
  instance: Instance,
): ReturnType<RuntimeReconcilerDeps['evaluateResumeHealth']> {
  assertRuntimeChangeOwner(deps, instance);
  return deps.evaluateResumeHealth(instance.id);
}

/** A late construction must neither register against a replacement nor leak its private adapter. */
export async function createOwnedRuntimeAdapter(
  deps: RuntimeReconcilerDeps,
  instance: Instance,
  ...args: Parameters<RuntimeReconcilerDeps['createRuntimeAdapter']>
): ReturnType<RuntimeReconcilerDeps['createRuntimeAdapter']> {
  assertRuntimeChangeOwner(deps, instance);
  const adapter = await deps.createRuntimeAdapter(...args);
  try {
    assertRuntimeChangeOwner(deps, instance);
    deps.setupAdapterEvents(instance.id, adapter);
    assertRuntimeChangeOwner(deps, instance);
    deps.setAdapter(instance.id, adapter);
    assertRuntimeChangeOwner(deps, instance);
    return adapter;
  } catch (error) {
    // Never strip listeners or terminate an adapter the current owner adopted.
    if (deps.getAdapter(instance.id) !== adapter) {
      try { adapter.removeAllListeners(); }
      catch (cleanupError) {
        logger.warn('Could not strip a discarded runtime adapter listener', { instanceId: instance.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      }
      // Listener teardown can itself invoke observers that adopt this adapter.
      if (deps.getAdapter(instance.id) !== adapter) {
        try { await adapter.terminate(true); }
        catch (cleanupError) {
          logger.warn('Could not terminate a discarded runtime adapter', { instanceId: instance.id,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
        }
      }
    }
    throw error;
  }
}

/** Publish the applied runtime only while its captured instance still owns the ID. */
export function publishRuntimeChange(
  deps: RuntimeReconcilerDeps,
  instance: Instance,
  params: {
    isYoloOnlyChange: boolean;
    model: string | undefined;
    nextReasoningEffort: Instance['reasoningEffort'];
    yoloModeChanged: boolean;
    nextYoloMode: boolean;
  },
): void {
  assertRuntimeChangeOwner(deps, instance);
  deps.queueUpdate(
    instance.id,
    instance.status,
    instance.contextUsage,
    undefined,
    undefined,
    undefined,
    instance.executionLocation,
    undefined,
    undefined,
    instance.currentModel,
    undefined,
    { provider: instance.provider, desiredRuntime: instance.desiredRuntime ?? null },
  );
  assertRuntimeChangeOwner(deps, instance);
  if (!params.isYoloOnlyChange) {
    // A pure permission-posture flip is not a model/provider change —
    // the old toggleYoloMode never announced one either.
    deps.emitRuntimeChanged({
      instanceId: instance.id,
      model: params.model,
      provider: instance.provider,
      reasoningEffort: params.nextReasoningEffort,
    });
    assertRuntimeChangeOwner(deps, instance);
  }
  if (params.yoloModeChanged) {
    // Live push for the renderer's pending-yolo convenience state. This
    // also covers the deferred auto-apply path, which never goes through
    // the requestYoloModeToggle wrapper.
    deps.emitYoloToggled({ instanceId: instance.id, yoloMode: params.nextYoloMode });
    assertRuntimeChangeOwner(deps, instance);
  }
}
