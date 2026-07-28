import type {
  LocalAiHealthSample,
  LocalAiProbeResult,
} from '../../shared/types/local-ai-guard.types';
import type {
  LocalAiCheckKind,
  LocalAiHealthSchedulerLogger,
} from './local-ai-health-scheduler';

export function localAiCheckKey(targetId: string, kind: LocalAiCheckKind): string {
  return `${targetId}:${kind}`;
}

export function localAiDeferredCheckKey(key: string): string {
  return `deferred:${key}`;
}

export function newestLocalAiProbeTimestamp(samples: LocalAiProbeResult[]): number {
  return samples.reduce((latest, sample) => Math.max(latest, sample.checkedAt), 0);
}

export function groupLocalAiHealthSamples(
  samples: LocalAiHealthSample[],
): LocalAiHealthSample[][] {
  const groups = new Map<string, LocalAiHealthSample[]>();
  for (const sample of [...samples].sort((left, right) =>
    left.checkedAt - right.checkedAt || left.id.localeCompare(right.id))) {
    const key = `${sample.checkedAt}:${sample.checkType}:${sample.origin}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function runLocalAiFailSoft(
  operation: () => Promise<unknown>,
  logger: LocalAiHealthSchedulerLogger,
  reason: string,
): void {
  try {
    void operation().catch(() => logger.warn(
      'Local AI Guard asynchronous callback failed',
      { reason },
    ));
  } catch {
    logger.warn('Local AI Guard asynchronous callback failed', { reason });
  }
}
