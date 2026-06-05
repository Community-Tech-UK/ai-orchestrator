import { getLogger } from '../../logging/logger';
import type { CliResponse } from './base-cli-adapter.types';
import type { DegradedOutputSignals } from './degraded-output-classifier';
import { classifyDegradedOutput } from './degraded-output-classifier';
import { computeBoundedTrigramSimilarity } from './base-cli-adapter-utils';

const logger = getLogger('BaseCliAdapter');

export function isDegradedDetectionEnabled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSettingsManager } = require('../core/config/settings-manager') as {
      getSettingsManager: () => { get: (key: string) => unknown };
    };
    return getSettingsManager().get('detectDegradedAdapterOutput') === true;
  } catch {
    return false;
  }
}

export function tagResponseIfDegraded(params: {
  adapterName: string;
  response: CliResponse;
  signals: DegradedOutputSignals;
}): void {
  try {
    const result = classifyDegradedOutput(params.signals);
    if (result.degraded && result.reason) {
      params.response.degradedReason = result.reason;
      logger.debug('A3: degraded output detected', {
        adapter: params.adapterName,
        reason: result.reason,
        contentLength: params.signals.contentLength,
        elapsedMs: params.signals.elapsedMs,
      });
    }
  } catch (err) {
    logger.warn('A3: degraded-output classifier threw unexpectedly (ignored)', {
      adapter: params.adapterName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function tagResponseFromStreamState(params: {
  adapterName: string;
  response: CliResponse;
  opts?: { cancelled?: boolean };
  priorResponseContent: string | null;
  turnFirstActivityAt: number;
  responseStartedAt: number;
  streamIdleDidFire: boolean;
}): string {
  const content = params.response.content ?? '';
  const prior = params.priorResponseContent;

  let emptinessRatio: number | undefined;
  if (content.length > 0) {
    const nonWhitespace = content.replace(/\s/g, '').length;
    emptinessRatio = (content.length - nonWhitespace) / content.length;
  }

  const duplicateOfPrior = prior !== null && content.length > 0 && content === prior;
  let similarityToPrior: number | undefined;
  if (prior !== null && !duplicateOfPrior && content.length > 0 && prior.length > 0) {
    similarityToPrior = computeBoundedTrigramSimilarity(content, prior);
  }

  const turnOrigin =
    params.turnFirstActivityAt > 0 ? params.turnFirstActivityAt : params.responseStartedAt;

  tagResponseIfDegraded({
    adapterName: params.adapterName,
    response: params.response,
    signals: {
      contentLength: content.length,
      elapsedMs: turnOrigin > 0 ? Date.now() - turnOrigin : 0,
      streamIdleFired: params.streamIdleDidFire,
      cancelled: params.opts?.cancelled ?? false,
      duplicateOfPrior,
      similarityToPrior,
      emptinessRatio,
    },
  });

  return content;
}
