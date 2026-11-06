/**
 * Types for the Codex helper trial report script (consumed by its fixture
 * spec; the script itself is plain ESM JavaScript).
 */

export declare const VERDICT_RULES: {
  harnessWorkTokenDrop: number;
  harnessWorkLandedDropPoints: number;
  harnessWorkWallClockRatio: number;
  chatsTokenDrop: number;
  chatsWallClockRatio: number;
  minDays: number;
  maxDays: number;
  minChatThreadsPerGroup: number;
  minTurnsPerChatThread: number;
  minDecidedItemsPerGroup: number;
};

export interface TrialVerdict {
  harnessWork: string;
  chats: string;
  notes: string[];
}

/**
 * CLI options. The requested window is validated: an unreadable `--since` or
 * `--until` date throws, and `--since` must be earlier than `--until`.
 */
export declare function parseArgs(argv: string[]): {
  sinceMs: number;
  untilMs: number;
  json: boolean;
  userData: string;
  policyDir: string | null;
  stateDb: string;
  sessionsDir: string;
  loopDb: string | null;
  rlmDb: string | null;
  costDir: string | null;
};

export declare function computeVerdict(input: {
  chats: Record<string, unknown>;
  planQueue: Record<string, unknown>;
  kinds: Record<string, Record<string, unknown>>;
  counts: {
    /** Each comparison's own trial clock, in days since its first eligible logged exposure. */
    daysElapsed: { chats: number; harnessWork: number };
    chatThreads: Record<string, number>;
    decidedItems: Record<string, number>;
    measuredLandedItems: Record<string, number>;
    unknownItems?: number;
    /** Measured plan-queue items resting on at least one estimated cost row. */
    estimatedItems?: number;
    unreadableRollouts?: number;
    unparsablePolicyRecords?: number;
    offGraphBreaches?: number;
    unknownChatThreads?: number;
    /** False when the loop database was missing or unreadable: Harness-work evidence is unknown. */
    loopDbReadable?: boolean;
  };
}): TrialVerdict;

export interface RolloutTurn {
  start: number | null;
  end: number | null;
  requests: number;
  input: number;
  cached: number;
  output: number;
  helperInput: number;
  helperThreads: number;
  helperCached?: number;
  /** True when a usage snapshot in the turn carried no cached-input counter. */
  cacheUnknown?: boolean;
  helperOutput?: number;
  helperRequests?: number;
  helperMailDeliveries?: number;
  requestsAfterHelperMail?: number;
  cacheMissesAfterHelperMail?: number | null;
  unmeasuredHelperMailDeliveries?: number;
}

/**
 * Containment index for one turn list: for each queried `at`, the index of the
 * first turn in array order whose window contains it (a turn without a finite
 * start never contains; the window is `at >= start` and `at <= end`, with a
 * null `end` open), or -1 when none does or the query has no finite `at`.
 * Near-linear in turns plus queries, with the exact first-match rule of the
 * old per-query `turns.findIndex` walk.
 */
export declare function indexTurnContainment(
  turns: Array<{ start: number | null; end: number | null }>,
  ats: Array<number | null | undefined>,
): number[];

/**
 * Parse one rollout into turns, usage deltas and compaction markers, bounded to
 * `[sinceMs, untilMs)`. Only turns starting inside the window are returned;
 * pre-window snapshots keep the cumulative-counter baseline so in-window turns
 * measure their own growth. Defaults measure the whole rollout.
 */
export declare function parseRolloutSync(path: string, sinceMs?: number, untilMs?: number): {
  /** Unparsable or unattributable usage makes this rollout and its root sample unknown. */
  unknownUsageRecords: number;
  turns: RolloutTurn[];
  compactions: { at: number | null; midTask: boolean }[];
};

export interface PlanQueueArmAggregate {
  items: number;
  decided: number;
  landed: number;
  parked: number;
  skipped: number;
  /** Still queued or running: neither decided, measured nor unknown. */
  inFlight: number;
  /** Settled at or after --until: outside the window, neither decided nor unknown. */
  settledAfterWindow: number;
  measuredItems: number;
  measuredLanded: number;
  /** Finished items whose Harness records are missing or malformed (never zero-filled). */
  unknownItems: number;
  /** Measured items that include at least one estimated (not provider-measured) cost row. */
  estimatedItems: number;
  landedShare: number | null;
  meanVerifierRoundsPerItem: number | null;
  meanInputPerLandedItem: number | null;
  medianWallClockMsPerItem: number | null;
}

/** Why a finished plan-queue item could not be measured from Harness records. */
export type PlanQueueUnknownReason =
  | 'cost-records-unreadable'
  | 'no-instance-id'
  | 'no-cost-rows'
  | 'invalid-cost-row'
  | 'bad-timestamps';

/** What readCostAttribution returns: cost rows summed per Harness instance id. */
export interface CostRecords {
  readable: boolean;
  byInstance: Map<string, { rows: number; gross: number; estimatedRows: number; invalidRows: number }>;
  files: number;
  unparsableLines: number;
}

export declare const UNREADABLE_COST_RECORDS: CostRecords;

/**
 * Sum the cost-attribution `instance-turn` rows of the wanted Harness instances
 * inside the window `[sinceMs, untilMs)`. Gross input is
 * `usage.inputTokens + usage.cacheReadTokens`. A missing directory or an
 * unreadable file in range gives `readable: false` (unknown, not empty). A row
 * without a usable `ts` is invalid (unknown), never absent or zero.
 */
export declare function readCostAttribution(dir: string | null, sinceMs: number, untilMs: number, wantedInstanceIds: Set<string>): CostRecords;

/** Largest logged helper-thread count per root thread, from `helper-count` records. */
export declare function helperCountsFromLog(records: Array<Record<string, unknown>>): Map<string, number>;

/**
 * Plan-queue items measured from Harness's own records: `items` are
 * `plan_queue_items` rows (`id, state, round, created_at, updated_at`), `usage`
 * is readCostAttribution's result. No rollout is read. `untilMs` bounds the
 * outcomes: a row settled at or after it is listed as `settledAfterWindowItems`
 * and counts as neither decided, measured nor unknown (defaults to no cutoff).
 */
export declare function aggregatePlanQueue(
  logEntries: Array<Record<string, unknown>>,
  items: Array<Record<string, unknown>>,
  usage: CostRecords,
  graph: {
    childrenOf: Map<string, unknown>;
    rolloutPath: Map<string, unknown>;
    /** Helper threads per root thread logged by the Codex adapter. */
    loggedHelperThreads?: Map<string, number>;
  },
  untilMs?: number,
): {
  perArm: Record<string, PlanQueueArmAggregate>;
  mixedArmItems: string[];
  excludedItems: string[];
  unknownItems: string[];
  unknownItemReasons: Record<string, PlanQueueUnknownReason>;
  inFlightItems: string[];
  settledAfterWindowItems: string[];
  rows: Array<{
    id: string; arm: string; state: string; round: number;
    input: number | null; wallClockMs: number | null; unknownReason: PlanQueueUnknownReason | null;
    /** True when the outcome settled at or after `untilMs` and is outside the window. */
    settledAfterWindow?: boolean;
  }>;
};

export declare function aggregateKind(
  kind: string,
  logEntries: Array<Record<string, unknown>>,
  graph: { childrenOf: Map<string, unknown>; rolloutPath: Map<string, unknown>; loggedHelperThreads?: Map<string, number> },
  rollouts: Map<string, unknown>,
  attributed?: Map<string, unknown>,
): Record<string, unknown>;

export declare function buildComparisons(
  logEntries: Array<Record<string, unknown>>,
  graph: { childrenOf: Map<string, unknown>; rolloutPath: Map<string, unknown>; loggedHelperThreads?: Map<string, number> },
  rollouts: Map<string, unknown>,
  items: Array<Record<string, unknown>>,
  usage?: CostRecords,
  untilMs?: number,
): {
  unassigned: Set<string>;
  ineligible: Set<string>;
  chats: Record<string, Record<string, unknown>>;
  kindTable: Record<string, Record<string, Record<string, unknown>>>;
  planQueue: ReturnType<typeof aggregatePlanQueue>;
  offGraphBreaches: string[];
  attributed: Map<string, unknown>;
};

/**
 * Entries carry `atMs` (parsed time, string or numeric `at`) and `legacyFormat`
 * (true for the pre-rebuild build's numeric `at` or control/candidate arms; the
 * arm itself is returned unchanged and is never mapped onto the current arms).
 */
export declare function parsePolicyLog(dir: string, sinceMs: number, untilMs: number, recordType?: 'policy' | 'child-outcome' | 'review-outcome' | 'helper-count'): { entries: Array<Record<string, unknown> & { atMs: number; legacyFormat: boolean }>; unparsableLines: number };
export declare function queryRows(path: string, sql: string, params?: unknown[]): Array<Record<string, unknown>> | null;
/**
 * The spawn graph as of the reporting window. A helper created at or after
 * `untilMs` is outside the window and its spawn edge is dropped; a child that
 * cannot be placed in time fails closed as in-window exposure. `created_at` is
 * Unix seconds and `created_at_ms` milliseconds (the Codex `threads` schema).
 */
export declare function readThreadGraph(stateDb: string, untilMs?: number): {
  childrenOf: Map<string, string[]>;
  rolloutPath: Map<string, string>;
};
export declare function resolveRolloutPath(path: string, sessionsDir: string): string | null;
export interface ChildOutcomeCounts {
  succeeded: number;
  failed: number;
  decided: number;
  unknown: number;
}

export interface ChildTrialArmAggregate extends Record<string, unknown> {
  /** Only complete measured rollouts contribute to tokens, turns and threads. */
  threadIds: string[];
  /** Eligible child policy exposures excluded from those rollout measures. */
  unmeasuredThreadIds: string[];
  /** Exact Harness instance/thread outcomes, independent of rollout availability. */
  outcomes: ChildOutcomeCounts;
}

export interface ReviewTrialArmAggregate extends Record<string, unknown> {
  reviewVerdicts: { returned: number | null; notReturned: null; unknown: number; reason: string };
}

export interface AutomationRunCounts {
  succeeded: number | null;
  failed: number | null;
  /** Decided runs whose outcome settled before `untilMs` (`finished_at`). */
  decided: number | null;
  /** Unknown decided runs, or exposed threads whose run coverage is unavailable when the database cannot be read. */
  unknown: number;
  /** Decided runs that settled at or after `untilMs`: outside the window, neither decided nor unknown. */
  settledAfterWindow: number | null;
}

export interface AutomationTrialArmAggregate extends Record<string, unknown> {
  /** Only complete measured rollouts contribute to tokens, turns and threads. */
  threadIds: string[];
  /** Eligible automation policy exposures excluded from those rollout measures. */
  unmeasuredThreadIds: string[];
  /** Run outcomes use valid policy/instance identities, independent of rollout availability. */
  runs: AutomationRunCounts;
}

export declare function runReport(argv?: string[]): Promise<Record<string, unknown> & {
  kindTable: Record<string, Record<string, unknown>> & {
    child: Record<string, ChildTrialArmAggregate>;
    review: Record<string, ReviewTrialArmAggregate>;
    automation: Record<string, AutomationTrialArmAggregate>;
  };
}>;
