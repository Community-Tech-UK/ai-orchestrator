/**
 * Types for scripts/claude-cost-audit-report.mjs (consumed by its fixture
 * spec; the script itself is plain ESM JavaScript).
 */

export declare const SUBAGENT_VERDICT_RULES: {
  spendDrop: number;
  respawnRisePoints: number;
  errorRisePoints: number;
  landedDropPoints: number;
  reviewerGuardShare: number;
  minDays: number;
  maxDays: number;
  minGeneralPurposePerGroup: number;
  waitingRuleRewriteDrop: number;
  waitingRuleRuntimeRise: number;
  respawnWindowMs: number;
  longWaitMinMs: number;
  longWaitMaxMs: number;
};

export type SubagentArm = 'sonnet' | 'same-as-session';

export declare function armForSessionId(nativeSessionId: string | null | undefined): SubagentArm;

export declare function requestUsd(
  r: {
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    model: string | null;
  },
  prices?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null,
): number;

export declare function reviewKeywordMatch(description: unknown): boolean;

/** Agent types the subagent-model policy moves (general-purpose and the built-in `claude` catch-all). */
export declare function policyMovedAgentType(agentType: unknown): boolean;

export interface RespawnWindow {
  firstAt: number;
  lastAt: number;
  returnedAt?: number | null;
  parentSessionId?: string;
  parentTurnId?: string | null;
}

export declare function detectRespawns(
  generalPurpose: RespawnWindow[],
  windowMs?: number,
): number;

export interface LongWait {
  at: number;
  /** Whole cache write; the split fields price each part at its own multiple. */
  rewrittenTokens: number;
  rewrittenTokens5m?: number;
  rewrittenTokens1h?: number;
  model: string | null;
}

export interface SubagentRecord {
  meta: { agentType?: string; description?: string; spawnDepth?: number; toolUseId?: string } | null;
  model: string | null;
  parentModel: string | null;
  spendUsd: number | null;
  unknownUsageRecords?: number;
  finalContext: number | null;
  /** Recorded run time joined on toolUseId (7i records); null when unknown. */
  runMs: number | null;
  /** Recorded tool uses joined on toolUseId; null when unknown. */
  toolUses?: number | null;
  firstAt: number;
  lastAt: number;
  isError: boolean | null;
  longWaits: LongWait[];
  parentTurnId?: string | null;
  startedAt?: number | null;
  returnedAt?: number | null;
}

export interface ParentSessionRecord {
  sessionId: string;
  arm: SubagentArm;
  parentModel: string | null;
  firstAt: number | null;
  activityAt?: number[];
  subagents: SubagentRecord[];
  unplacedUsageRecords?: number;
}

export declare function collectSubagentSessions(
  projectsDir: string | string[],
  prices?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null,
  opts?: {
    /** Phase 0's `subagentUsage` rows: `{ toolUseId, durationMs, toolUses }` finals. */
    subagentUsage?: Array<{
      subagentUsage?: boolean;
      toolUseId?: string;
      durationMs?: number;
      toolUses?: number;
    }>;
  },
): Promise<ParentSessionRecord[]>;

export interface LongWaitBuckets {
  unknownUsageRecords?: number;
  before: { count: number; tokens: number; usd: number; runMsMedian: number | null };
  after: { count: number; tokens: number; usd: number; runMsMedian: number | null };
}

export declare function longWaitCacheMetric(
  sessions: ParentSessionRecord[],
  waitingRuleMs: number,
  prices?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null,
  opts?: { sinceMs?: number; untilMs?: number; delivered?: Map<string, number> },
): LongWaitBuckets;

/** One stretch of verified trial exposure for a session: [start, end). */
export interface ClaudeExposureSpan {
  start: number;
  /** Number.POSITIVE_INFINITY while the exposure is still open. */
  end: number;
}

/** Exposure history before exclusive `toMs`, retaining starts before `fromMs`. */
export declare function eligibleClaudeExposures(
  policyEntries: Array<Record<string, unknown>>,
  fromMs: number,
  toMs: number,
): {
  eligible: Array<Record<string, unknown>>;
  firstBySession: Map<string, number>;
  intervalsBySession: Map<string, ClaudeExposureSpan[]>;
};

export interface PlanQueueShare {
  'sonnet': { items: number; landed: number };
  'same-as-session': { items: number; landed: number };
  mixedItems: number;
  unassignedItems: number;
  /** Landings whose `updated_at` settles at or after `untilMs`: outside the window. */
  landedAfterWindow: number;
  /** Landings without a usable `updated_at`: unknown, never counted as landed. */
  landedUnplaced: number;
  /** Undated landings by first-worker arm, for conservative quality bounds. */
  landedUnplacedByArm: Record<SubagentArm, number>;
}

/**
 * `policyEntries` is the worker history, including before `sinceMs`: an item
 * keeps its first worker's group even when `sinceMs` starts later (Step 2's
 * first-worker rule). Exclusive `untilMs` bounds workers as well as landings;
 * future workers cannot assign an item or make it mixed.
 */
export declare function planQueueShare(
  policyEntries: Array<{ provider?: string; armKey?: string; arm?: string; at: string }>,
  items: Array<{ id: string; landed_commit?: string | null; updated_at?: number | null }>,
  untilMs?: number,
): PlanQueueShare;

export declare function parsePolicyLog(
  dir: string | null,
  fromMs: number,
  toMs: number,
): { entries: Array<Record<string, unknown>>; unparsableLines: number };

export interface ArmMetrics {
  sessions: number;
  subagents: number;
  gpSubagents: number;
  spendUsd: number | null;
  unknownUsageRecords?: number;
  spendPerSessionUsd: number | null;
  spendPerGpUsd: number | null;
  models: Map<string, number>;
  finalContextMedian: number | null;
  finalContextP90: number | null;
  spawnDepthMedian: number | null;
  respawnRate: number;
  respawnUnknown?: number;
  errorRate: number;
  errorCount: number;
  outcomesUnknown: number;
  reviewerGuardChecked: number;
  reviewerGuardViolations: number;
  runMsMedian: number | null;
  /** Helpers without a recorded final joined on toolUseId (unknown, never zero). */
  runMsUnknown?: number;
  toolUsesMedian?: number | null;
  toolUsesUnknown?: number;
}

export interface SubagentTrialMetrics {
  policyUnparsableLines: number;
  arms: Record<SubagentArm, ArmMetrics>;
  sample: { days: number; gp: Record<SubagentArm, number> };
  waitingRule: LongWaitBuckets;
  trialExposureMs: number | null;
  waitingRuleActivationMs: number | null;
  planQueue: PlanQueueShare;
}

/** All policy-derived evidence is bounded by exclusive `untilMs`, retaining pre-`sinceMs` history. */
export declare function aggregateSubagentMetrics(
  sessions: ParentSessionRecord[],
  opts: {
    sinceMs: number;
    untilMs: number;
    policyEntries?: Array<Record<string, unknown>>;
    /** Unplaceable log records can change exposure even before sinceMs. */
    policyUnparsableLines?: number;
    items?: Array<{ id: string; landed_commit?: string | null; updated_at?: number | null }>;
    prices?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null;
  },
): SubagentTrialMetrics;

export declare function evaluateSubagentVerdict(
  metrics: SubagentTrialMetrics,
  rules?: typeof SUBAGENT_VERDICT_RULES,
): { verdict: string; waitingRule: string; notes: string[] };
