/**
 * Per-turn cost recording and estimate-vs-actual telemetry.
 *
 * Extracted from `instance-communication.ts` so the coordinator stays inside
 * its LOC ceiling. Behaviour matches the previous private methods.
 */

import { getLogger } from '../logging/logger';
import { getCostTracker } from '../core/system/cost-tracker';
import { recordInstanceTurnAttribution } from '../core/system/cost-attribution';
import { getCacheAnalyticsService } from '../context/cache-analytics-service';
import { normalizeUsage, type UsageLike } from '../../shared/util/usage-normalization';
import { getTokenCounter } from '../rlm/token-counter';
import type { Instance } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';

const logger = getLogger('InstanceCommunication');

export function recordCompletionCost(
  instanceId: string,
  instance: Instance,
  response: CliResponse,
): void {
  try {
    const usage = normalizeUsage(response.usage as UsageLike | undefined);
    if (!usage) {
      return;
    }
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const reasoning = usage.reasoning ?? 0;
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) {
      return;
    }
    const model = instance.currentModel || instance.provider;
    const providerCost = response.usage?.cost;
    const isEstimated = response.usage?.isEstimated === true;
    getCostTracker().recordUsage(
      instanceId,
      instance.sessionId,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      typeof providerCost === 'number' ? providerCost : undefined,
      reasoning,
      isEstimated,
    );
    recordInstanceTurnAttribution({
      instanceId,
      parentId: instance.parentId,
      agentId: instance.agentId,
      provider: instance.provider,
      model,
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: reasoning, cost: typeof providerCost === 'number' ? providerCost : undefined },
      costKnown: typeof providerCost === 'number',
      isEstimated,
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
