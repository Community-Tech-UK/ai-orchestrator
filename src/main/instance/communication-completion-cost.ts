import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import { extractProviderErrorDiagnostics } from './instance-communication.diagnostics';
import { machineSessionReasonOf } from '../../shared/utils/machine-session';
/**
 * Per-turn cost recording and estimate-vs-actual telemetry.
 *
 * Extracted from `instance-communication.ts` so the coordinator stays inside
 * its LOC ceiling. Behaviour matches the previous private methods.
 */

import { getLogger } from '../logging/logger';
import { getCostTracker } from '../core/system/cost-tracker';
import { recordInstanceTurnAttribution, type PlanQueueCostContext } from '../core/system/cost-attribution';
import { getCacheAnalyticsService } from '../context/cache-analytics-service';
import { normalizeUsage, type UsageLike } from '../../shared/util/usage-normalization';
import { getTokenCounter } from '../rlm/token-counter';
import type { Instance } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { computeProviderTokenCost } from '../../shared/data/model-pricing';
import { deferUntilResponseUsageSettled } from '../cli/adapters/deferred-response-usage';

const logger = getLogger('InstanceCommunication');

export type CompletionCostIdentity = Pick<Instance, 'sessionId' | 'provider' | 'currentModel' | 'parentId' | 'agentId' | 'metadata'>;
export function captureCompletionCostIdentity(instance: Instance): CompletionCostIdentity {
  return { sessionId: instance.sessionId, provider: instance.provider, currentModel: instance.currentModel,
    parentId: instance.parentId, agentId: instance.agentId, metadata: { ...instance.metadata } };
}

function queueCostContext(metadata: Instance['metadata']): PlanQueueCostContext | undefined {
  const runId = metadata?.['planQueueRunId'];
  const role = metadata?.['planQueueRole'];
  if (typeof runId !== 'string' || typeof role !== 'string') return undefined;
  const itemId = metadata?.['planQueueItemId'];
  const round = metadata?.['planQueueRound'];
  return { runId, role, itemId: typeof itemId === 'string' ? itemId : null,
    round: typeof round === 'number' && Number.isSafeInteger(round) && round >= 0 ? round : null };
}

export function recordCompletionCost(
  instanceId: string,
  instance: Instance,
  response: CliResponse,
  onUsageSettled?: () => void,
  identity = captureCompletionCostIdentity(instance),
): void {
  if (deferUntilResponseUsageSettled(response, () => {
    recordCompletionCost(instanceId, instance, response, undefined, identity);
    onUsageSettled?.();
  })) return;
  const billingInstance = { ...instance, ...identity };
  try {
    const rawProviderCost = response.usage?.cost;
    const providerCost = typeof rawProviderCost === 'number' && Number.isFinite(rawProviderCost) && rawProviderCost >= 0 ? rawProviderCost : undefined;
    const positiveProviderCost = providerCost !== undefined && providerCost > 0;
    const usage = normalizeUsage(response.usage as UsageLike | undefined) ?? (positiveProviderCost ? {} : undefined);
    if (!usage) {
      return;
    }
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const reasoning = usage.reasoning ?? 0;
    if (!positiveProviderCost && input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) {
      return;
    }
    const model = billingInstance.currentModel || billingInstance.provider;
    const isEstimated = response.usage?.isEstimated === true;
    const observedTokens = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: reasoning };
    const freeProvider = ['copilot', 'cursor', 'ollama', 'lmstudio'].includes(billingInstance.provider.toLowerCase());
    const pricedCost = !isEstimated && !freeProvider
      ? computeProviderTokenCost(billingInstance.provider, model, observedTokens) : undefined;
    const attributionCost = providerCost ?? pricedCost ?? (freeProvider ? 0 : undefined);
    const entry = getCostTracker().recordUsage(
      instanceId,
      billingInstance.sessionId,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      attributionCost,
      reasoning,
      isEstimated,
      { provider: billingInstance.provider, byModel: response.usage?.byModel },
    );
    instance.contextUsage.costEstimate = (instance.contextUsage.costEstimate ?? 0) + entry.cost;
    recordInstanceTurnAttribution({
      planQueue: queueCostContext(billingInstance.metadata),
      purpose: machineSessionReasonOf(billingInstance) === 'plan-queue' ? 'plan-queue' : typeof billingInstance.metadata?.['spendPurpose'] === 'string' ? billingInstance.metadata['spendPurpose'] : undefined,
      instanceId,
      parentId: billingInstance.parentId,
      agentId: billingInstance.agentId,
      provider: billingInstance.provider,
      model,
      usage: { ...observedTokens, ...(attributionCost === undefined ? {} : { cost: attributionCost }) },
      costKnown: attributionCost !== undefined,
      costSource: providerCost !== undefined ? 'provider' : pricedCost !== undefined ? 'priced' : freeProvider ? 'free' : 'unknown',
      isEstimated,
      ...(billingInstance.metadata?.['spendPurpose'] === 'automation' || billingInstance.metadata?.['spendPurpose'] === 'channel'
        ? { spendPurpose: billingInstance.metadata['spendPurpose'] } : {}),
    });
    if (!isEstimated) {
      getCacheAnalyticsService().recordTurn(instanceId, { input, cacheRead, cacheWrite });
    }
  } catch (err) {
    logger.debug('recordCompletionCost failed', { instanceId, error: String(err) });
  }
}

export function recordEstimationTelemetry(
  instance: Instance,
  response: CliResponse,
  sampleCount: { value: number },
): void {
  try {
    if (response.usage?.isEstimated) return;
    if (response.toolCalls && response.toolCalls.length > 0) return;
    const text = response.content;
    const actualOutput = response.usage?.outputTokens;
    if (!text || typeof actualOutput !== 'number' || actualOutput <= 0) return;

    const model = instance.currentModel || instance.provider;
    const counter = getTokenCounter();
    if (!counter.recordEstimationSample(actualOutput, text, model)) return;
    counter.calibrate(actualOutput, text, model);

    sampleCount.value += 1;
    if (sampleCount.value % 25 === 0) {
      const telemetry = counter.getEstimationTelemetry(model);
      if (telemetry) {
        logger.info('Token estimate-vs-actual drift', {
          family: telemetry.family,
          sampleCount: telemetry.sampleCount,
          medianRatio: Number(telemetry.medianRatio.toFixed(3)),
          meanAbsErrorPct: Number(telemetry.meanAbsErrorPct.toFixed(1)),
        });
      }
    }
  } catch (err) {
    logger.debug('recordEstimationTelemetry failed', { error: String(err) });
  }
}

export function toProviderCompleteEvent(
  response: CliResponse,
  requestCountAtCompletion?: number,
): ProviderRuntimeEvent {
  const usage = normalizeUsage(response.usage as UsageLike | undefined);
  return {
    kind: 'complete',
    ...(usage?.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage?.output !== undefined ? { outputTokens: usage.output } : {}),
    ...(usage?.cacheRead !== undefined ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage?.cacheWrite !== undefined ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(usage?.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
    ...(requestCountAtCompletion !== undefined ? { requestCountAtCompletion } : {}),
    ...(response.usage?.totalTokens !== undefined ? { tokensUsed: response.usage.totalTokens } : {}),
    ...(response.usage?.cost !== undefined ? { costUsd: response.usage.cost } : {}),
    ...(response.usage?.duration !== undefined ? { durationMs: response.usage.duration } : {}),
    // A3: surface the adapter-layer degraded-output tag onto the normalized
    // event so downstream consumers (renderer, coordinator) can see it.
    ...(response.degradedReason ? { degradedReason: response.degradedReason } : {}),
    ...extractProviderErrorDiagnostics(response.metadata),
  };
}

/** No timeout: only the provider can declare its response usage final. */
export function waitForCompletionUsage(response: CliResponse): Promise<void> | undefined {
  let resolve!: () => void;
  const settled = new Promise<void>(done => { resolve = done; });
  return deferUntilResponseUsageSettled(response, resolve) ? settled : undefined;
}

/** Track publication separately from cleanup: native termination can finalize usage. */
export class InstanceCompletionTasks {
  private readonly tasks = new Map<Promise<void>, {
    instanceId: string; ancestors: Set<string>; cleanupReady: Promise<void>;
  }>();

  constructor(private readonly parentOf: (id: string) => string | null | undefined) {}

  track(instanceId: string, run: Promise<void>, cleanupReady: Promise<void>): void {
    const ancestors = new Set<string>();
    let parentId = this.parentOf(instanceId);
    while (parentId && parentId !== instanceId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      parentId = this.parentOf(parentId);
    }
    // Capture lineage while the child exists; removal must not lose its late usage.
    this.tasks.set(run, { instanceId, ancestors, cleanupReady });
    const release = () => { this.tasks.delete(run); };
    void run.then(release, release);
  }

  descendants(instanceId: string): Promise<void> | undefined {
    const pending = [...this.tasks].filter(([, task]) => task.ancestors.has(instanceId)).map(([run]) => run);
    return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
  }

  cleanupReady(instanceId: string): Promise<void>[] {
    return [...this.tasks.values()].filter(task => task.instanceId === instanceId).map(task => task.cleanupReady);
  }
}
