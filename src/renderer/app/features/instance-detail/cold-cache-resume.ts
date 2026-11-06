/** The screen waits longer than loops before offering a restart: loops can re-anchor cheaply. */
export const COLD_CACHE_MIN_TOKENS = 100_000;
export const COLD_CACHE_IDLE_MS = 70 * 60_000;

export interface ColdCacheResumeFacts {
  provider: string;
  status: string;
  usage: { used: number; occupancyReported?: boolean; occupancyIsAggregate?: boolean } | undefined;
  lastAssistantAt: number | undefined;
  now: number;
  compacting: boolean;
  hasQueued: boolean;
  quotaParked: boolean;
}

export type ColdCacheResumeEvaluation = { offer: false } | { offer: true; tokens: number; idleMinutes: number };

export function evaluateColdCacheResume(facts: ColdCacheResumeFacts): ColdCacheResumeEvaluation {
  const usage = facts.usage;
  if (facts.provider !== 'claude' || facts.status !== 'idle'
    || !usage?.occupancyReported || usage.occupancyIsAggregate
    || !Number.isFinite(usage.used) || usage.used < COLD_CACHE_MIN_TOKENS
    || facts.lastAssistantAt === undefined || !Number.isFinite(facts.lastAssistantAt)
    || facts.compacting || facts.hasQueued || facts.quotaParked) return { offer: false };
  const idleMs = facts.now - facts.lastAssistantAt;
  return idleMs >= COLD_CACHE_IDLE_MS
    ? { offer: true, tokens: usage.used, idleMinutes: Math.floor(idleMs / 60_000) }
    : { offer: false };
}
