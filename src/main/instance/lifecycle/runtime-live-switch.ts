/**
 * Live model/effort switch for resident Claude sessions (A8.3, Step 14d).
 *
 * A model or thinking change switches the running session in place — same
 * process, same session id, whole conversation (tool results included) kept.
 * It is NOT cheaper on the first reply (Claude's cache is per model), and the
 * notice says so. Anything that looks wrong falls through to the existing
 * replay path, which owns the degradation messaging.
 */

import { getLogger } from '../../logging/logger';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';
import type { ReasoningEffort } from '../../../shared/types/provider.types';
import type { RuntimeDiff } from './runtime-reconciler.types';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import { isModelTier, resolveModelForTier } from '../../../shared/types/provider-model-utils';
import { getKnownModelsForCli } from './create-validation-helpers';
import { getProviderModelContextWindow } from '../../../shared/types/provider-context-window';
import { resolveSwapContextUsage } from './context-usage-restore';

const logger = getLogger('RuntimeLiveSwitch');

export interface LiveSwitchAdapter {
  applyLiveRuntime?: (change: {
    model?: string;
    effort?: string | null;
  }) => Promise<{ ok: boolean; reason?: string }>;
  getAdapterCapabilities?: () => { residentSession?: boolean };
}

export function canTryLiveSwitch(params: {
  diff: RuntimeDiff;
  desired: DesiredRuntime;
  instance: Instance;
  adapter: unknown;
}): boolean {
  const { diff, desired, instance, adapter } = params;
  if (instance.provider !== 'claude') return false;
  const live = adapter as LiveSwitchAdapter | undefined;
  if (!live || typeof live.applyLiveRuntime !== 'function') return false;
  if (!live.getAdapterCapabilities?.().residentSession) return false;
  if (!diff.modelChanged && !diff.reasoningChanged) return false;
  if (diff.providerChanged || diff.runtimeTargetChanged || diff.yoloModeChanged
    || diff.copilotAccountChanged || diff.accountProfileChanged) {
    return false;
  }
  if (instance.executionLocation?.type === 'remote') return false;
  // 'workflow' is a settings overlay at spawn, not a live flag.
  if (desired.reasoningEffort === 'workflow') return false;
  return true;
}

/** A tier resolves to its concrete id; anything else must be a known Claude id. */
export async function resolveLiveModel(model: string | undefined): Promise<string | null> {
  if (!model) return null;
  if (isModelTier(model)) return resolveModelForTier(model, 'claude') ?? null;
  try {
    const known = await getKnownModelsForCli('claude');
    return known.includes(model) ? model : null;
  } catch {
    return null;
  }
}

export interface TryLiveClaudeSwitchParams {
  diff: RuntimeDiff;
  desired: DesiredRuntime;
  instance: Instance;
  adapter: unknown;
  oldModel: string | undefined;
  oldReasoningEffort: ReasoningEffort | null | undefined;
  /** The caller must retain runtime-change ownership across the switch. */
  assertCurrent(): void;
  emitSystemNotice(instance: Instance, content: string, metadata?: Record<string, unknown>): void;
  queueUpdate: RuntimeReconcilerDeps['queueUpdate'];
  emitRuntimeChanged: RuntimeReconcilerDeps['emitRuntimeChanged'];
}

/**
 * Returns false to fall through to the replay path. On true the instance has
 * been updated, rebased and announced. Never calls `adapter.sendInput`.
 */
export async function tryLiveClaudeSwitch(params: TryLiveClaudeSwitchParams): Promise<boolean> {
  const { diff, desired, instance, adapter } = params;
  if (!canTryLiveSwitch(params)) return false;

  const targetModel = diff.modelChanged ? await resolveLiveModel(desired.model) : instance.currentModel;
  if (diff.modelChanged && !targetModel) return false;

  const live = adapter as LiveSwitchAdapter;
  let result: { ok: boolean; reason?: string };
  try {
    result = await live.applyLiveRuntime!({
      ...(diff.modelChanged && targetModel ? { model: targetModel } : {}),
      ...(diff.reasoningChanged ? { effort: desired.reasoningEffort } : {}),
    });
  } catch (error) {
    params.assertCurrent();
    logger.warn('Live model switch threw; falling back to replay', {
      instanceId: instance.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  params.assertCurrent();
  if (!result.ok) {
    logger.info('Live model switch refused; falling back to replay', {
      instanceId: instance.id,
      reason: result.reason,
    });
    return false;
  }

  if (diff.modelChanged && targetModel) instance.currentModel = targetModel;
  if (diff.reasoningChanged) instance.reasoningEffort = desired.reasoningEffort ?? undefined;
  const contextTotal = getProviderModelContextWindow('claude', instance.currentModel);
  instance.contextUsage = resolveSwapContextUsage(instance.contextUsage, contextTotal, true);

  const usage = instance.contextUsage;
  const count = usage.occupancyReported && !usage.occupancyIsAggregate
    && Number.isFinite(usage.used) && usage.used > 0
    ? ` (about ${Math.round(usage.used / 1_000)}K tokens)` : '';
  // An effort-only change did not touch the model, so say nothing about a
  // model switch or a new price.
  const notice = diff.modelChanged
    ? `Switched from ${params.oldModel ?? 'the previous model'} to ${instance.currentModel} in place. `
      + 'The whole conversation, including tool results, was kept. '
      + `The next reply re-reads it at the new model's price${count}.`
    : `Thinking changed from ${params.oldReasoningEffort ?? 'the default'} to ${instance.reasoningEffort ?? 'the default'} `
      + 'in place; the conversation was kept.';
  params.emitSystemNotice(
    instance,
    notice,
    { source: 'runtime-live-switch', method: 'live-switch' },
  );
  params.assertCurrent();
  params.queueUpdate(
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
  params.assertCurrent();
  params.emitRuntimeChanged({
    instanceId: instance.id,
    model: instance.currentModel,
    provider: instance.provider,
    reasoningEffort: instance.reasoningEffort,
  });
  params.assertCurrent();
  logger.info('Claude session switched in place', {
    instanceId: instance.id,
    model: instance.currentModel,
    reasoningEffort: instance.reasoningEffort,
  });
  return true;
}
