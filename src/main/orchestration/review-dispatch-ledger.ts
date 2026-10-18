import { appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { getCostAttributionFilePath, getCostAttributionDirectory, recordCostAttribution } from '../core/system/cost-attribution';

export interface ReviewDailyUsage { used: number; limit: number; resetsAt: number; limitReached: boolean }
const memoryDispatches = new Map<string, number>();

function dayWindow(now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return { start, end };
}

export function getReviewDailyUsage(limit: number, now = new Date()): ReviewDailyUsage {
  const { start, end } = dayWindow(now);
  let used = memoryDispatches.get(String(start)) ?? 0;
  const dir = getCostAttributionDirectory();
  if (dir && getCostAttributionFilePath()) {
    for (let utc = Math.floor(start / 86_400_000) * 86_400_000; utc < end; utc += 86_400_000) {
      try {
        for (const line of readFileSync(join(dir, `cost-attribution-${new Date(utc).toISOString().slice(0, 10)}.jsonl`), 'utf8').split('\n')) {
          try {
            const row = JSON.parse(line) as { ts?: number; reviewDispatch?: boolean };
            if (row.reviewDispatch === true && typeof row.ts === 'number' && row.ts >= start && row.ts < end) used++;
          } catch { /* Ignore unrelated or partial JSONL rows. */ }
        }
      } catch { /* Missing day files contain no dispatches. */ }
    }
  }
  return { used, limit, resetsAt: end, limitReached: used >= limit };
}

export function reserveReviewDispatch(input: { limit: number; reviewId: string; instanceId: string; trigger: 'automatic' | 'manual'; now?: Date }): ReviewDailyUsage & { allowed: boolean } {
  const now = input.now ?? new Date();
  const usage = getReviewDailyUsage(input.limit, now);
  if (input.trigger === 'automatic' && usage.limitReached) return { ...usage, allowed: false };
  const row = { ts: now.getTime(), source: 'one-shot', taskType: 'review-dispatch', reviewDispatch: true, correlationId: input.reviewId, instanceId: input.instanceId, trigger: input.trigger };
  try {
    const file = getCostAttributionFilePath();
    if (!file) throw new Error('Attribution sink disabled');
    // Use the supplied time's UTC file, so local-day counting also works in tests.
    appendFileSync(join(getCostAttributionDirectory()!, `cost-attribution-${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n', 'utf8');
  } catch {
    const key = String(dayWindow(now).start);
    memoryDispatches.set(key, (memoryDispatches.get(key) ?? 0) + 1);
  }
  return { ...usage, used: usage.used + 1, limitReached: usage.used + 1 >= input.limit, allowed: true };
}

export function _resetReviewDispatchLedgerForTesting(): void { memoryDispatches.clear(); }

/** Informational decisions, never an additional model charge. */
export function recordReviewLifecycle(input: { reviewId: string; instanceId: string; verdict?: string; action?: string; reviewerId?: string }): void {
  recordCostAttribution({ source: 'one-shot', taskType: 'cross-model-review-lifecycle', purpose: 'cross-model-review',
    reviewLifecycle: true, correlationId: input.reviewId, instanceId: input.instanceId,
    ...(input.verdict ? { reviewVerdict: input.verdict } : {}),
    ...(input.action ? { reviewAction: input.action } : {}),
    ...(input.reviewerId ? { reviewerId: input.reviewerId } : {}),
  });
}
