/**
 * Turns Claude request facts into the nine "Where your usage went" shares.
 *
 * Each share is: usage under one condition / all usage in the scope. "Usage" is
 * each request's API-price equivalent from the shared price table, so a request
 * that read a lot from the chat weighs what it would cost, not how many tokens
 * it had. Only the ratios are ever shown, never dollars.
 *
 * Nothing is invented. A condition that needs a fact we do not have (the effort
 * setting for a session Harness did not start) makes the share a lower bound or
 * "not measured", never a guess.
 */

import { computeTokenCost, hasModelRate } from '../data/model-pricing';
import { CLAUDE_MODELS, CLAUDE_PINNED_MODELS } from '../types/provider.types';
import {
  ALWAYS_ON_TOKENS,
  CACHE_MISS_TOKENS,
  HELPER_HEAVY_SHARE,
  IDLE_GAP_CAP_MS,
  LONG_CONTEXT_TOKENS,
  LONG_RUNNING_HOURS,
  MAX_EFFORT_VALUE,
  PARALLEL_BUCKET_MS,
  PARALLEL_SESSIONS,
  USAGE_WINDOW_MS,
  WORKFLOW_EFFORT_VALUE,
  isCauseShown,
  sharePercent,
} from './usage-cause-rules';
import {
  USAGE_CAUSE_IDS,
  type UsageCauseId,
  type UsageCauseResult,
  type UsageInsightNote,
  type UsageInsightReport,
  type UsageInsightScope,
  type UsageRequestFact,
  type UsageSessionFact,
} from './usage-insight.types';

/** An effort record only speaks for requests this close to it. */
export const EFFORT_MATCH_MAX_GAP_MS = 6 * 60 * 60 * 1000;
/** Below this, the effort-based causes are reported as "at least". */
const EFFORT_FULL_COVERAGE = 0.95;
/** Requests made after "now" by this much are treated as clock noise and kept. */
const FUTURE_SLACK_MS = 60 * 1000;

export interface UsageCalculatorInput {
  requests: readonly UsageRequestFact[];
  sessions: ReadonlyMap<string, UsageSessionFact>;
  now: number;
  scope: UsageInsightScope;
  /** Required for a session scope: the transcript sessions that belong to the instance. */
  scopeSessionIds?: ReadonlySet<string>;
  windowMs?: number;
  /** Replace the price-based weight (tests). Must return a finite number >= 0. */
  weigh?: (request: UsageRequestFact) => number;
  /** Evidence gaps found while reading, passed through to the report. */
  notes?: readonly UsageInsightNote[];
}

/** "claude-opus-5-20261015[1m]" becomes "claude-opus-5". */
function baseModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/** The id the price table knows this model by, or undefined when it has no entry. */
function exactPriceId(model: string): string | undefined {
  if (hasModelRate(model)) return model;
  const base = baseModelId(model);
  return base !== model && hasModelRate(base) ? base : undefined;
}

/** True when the shared price table has an entry for this model (ignoring a date or size tag). */
export function hasExactPrice(model: string): boolean {
  return exactPriceId(model) !== undefined;
}

/**
 * The table entry to price a model with. A model the table has never seen is priced as
 * the current model of its family, so a helper on a small model is not counted like the
 * lead on a large one. Only the table's own entries are used; no price is written here.
 */
function pricingModelFor(model: string): string {
  const exact = exactPriceId(model);
  if (exact) return exact;
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return CLAUDE_MODELS.OPUS;
  if (lower.includes('sonnet')) return CLAUDE_MODELS.SONNET;
  if (lower.includes('haiku')) return CLAUDE_MODELS.HAIKU;
  if (lower.includes('fable')) return CLAUDE_PINNED_MODELS.FABLE_51;
  return model;
}

export function priceWeight(request: UsageRequestFact): number {
  return computeTokenCost(pricingModelFor(request.model), {
    inputTokens: request.input,
    outputTokens: request.output,
    cacheReadTokens: request.cacheRead,
    cacheWriteTokens: request.cacheWrite,
  });
}

interface SessionStats {
  total: number;
  helper: number;
  times: number[];
  activeMs: number;
}

interface GroupStats {
  total: number;
  helper: number;
}

interface Measured {
  request: UsageRequestFact;
  weight: number;
}

export function calculateUsageCauses(input: UsageCalculatorInput): UsageInsightReport {
  const windowMs = input.windowMs ?? USAGE_WINDOW_MS;
  const windowStart = input.now - windowMs;
  const weigh = input.weigh ?? priceWeight;
  const session = (id: string): UsageSessionFact => input.sessions.get(id) ?? defaultSession(id);

  const measured: Measured[] = [];
  for (const request of input.requests) {
    if (request.at < windowStart || request.at > input.now + FUTURE_SLACK_MS) continue;
    const weight = weigh(request);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    measured.push({ request, weight });
  }

  // Facts that need every session, whatever the scope: who was working together,
  // how long each session worked, and which groups were mostly helpers.
  const sessionStats = new Map<string, SessionStats>();
  const groupStats = new Map<string, GroupStats>();
  const buckets = new Map<number, Set<string>>();
  for (const { request, weight } of measured) {
    const info = session(request.sessionId);
    const helper = request.helper || info.isHelperSession;
    const stats = sessionStats.get(request.sessionId) ?? { total: 0, helper: 0, times: [], activeMs: 0 };
    stats.total += weight;
    if (helper) stats.helper += weight;
    stats.times.push(request.at);
    sessionStats.set(request.sessionId, stats);

    const group = groupStats.get(info.groupKey) ?? { total: 0, helper: 0 };
    group.total += weight;
    if (helper) group.helper += weight;
    groupStats.set(info.groupKey, group);

    const bucket = Math.floor(request.at / PARALLEL_BUCKET_MS);
    const members = buckets.get(bucket) ?? new Set<string>();
    members.add(request.sessionId);
    buckets.set(bucket, members);
  }
  for (const stats of sessionStats.values()) stats.activeMs = activeDuration(stats.times);

  const longRunning = new Set<string>();
  for (const [id, stats] of sessionStats) {
    if (stats.activeMs >= LONG_RUNNING_HOURS * 3_600_000) longRunning.add(id);
  }

  const inScope = input.scope.kind === 'session'
    ? measured.filter(({ request }) => input.scopeSessionIds?.has(request.sessionId) === true)
    : measured;

  const cause = new Map<UsageCauseId, Tally>(USAGE_CAUSE_IDS.map((id) => [id, newTally()] as const));
  let totalWeight = 0;
  let effortKnownWeight = 0;
  let linkedWeight = 0;
  let approximatePrices = 0;
  const exactPrice = new Map<string, boolean>();
  const sessionsInScope = new Set<string>();
  const linkedSessions = new Set<string>();

  for (const { request, weight } of inScope) {
    const info = session(request.sessionId);
    totalWeight += weight;
    if (!input.weigh) {
      let exact = exactPrice.get(request.model);
      if (exact === undefined) {
        exact = hasExactPrice(request.model);
        exactPrice.set(request.model, exact);
      }
      if (!exact) approximatePrices += 1;
    }
    sessionsInScope.add(request.sessionId);
    if (info.instanceId) {
      linkedWeight += weight;
      linkedSessions.add(request.sessionId);
    }
    const effort = effortAt(info.efforts, request.at);
    if (effort !== undefined) effortKnownWeight += weight;

    const group = groupStats.get(info.groupKey);
    const flags: Record<UsageCauseId, boolean> = {
      cacheMiss: request.input + request.cacheWrite > CACHE_MISS_TOKENS,
      longContext: request.input + request.cacheWrite + request.cacheRead > LONG_CONTEXT_TOKENS,
      helperHeavy: group !== undefined && group.total > 0 && group.helper / group.total >= HELPER_HEAVY_SHARE,
      parallelSessions: (buckets.get(Math.floor(request.at / PARALLEL_BUCKET_MS))?.size ?? 0) >= PARALLEL_SESSIONS,
      longRunning: longRunning.has(request.sessionId),
      maxEffort: effort === MAX_EFFORT_VALUE,
      workflows: effort === WORKFLOW_EFFORT_VALUE,
      alwaysOnContext: (info.startPromptTokens ?? 0) > ALWAYS_ON_TOKENS,
      bigToolResults: request.bigResult,
    };
    for (const id of USAGE_CAUSE_IDS) {
      if (!flags[id]) continue;
      const tally = cause.get(id)!;
      tally.weight += weight;
      tally.requests += 1;
      tally.sessions.add(request.sessionId);
    }
  }

  const effortCoverage = totalWeight > 0 ? effortKnownWeight / totalWeight : 0;
  const effortPartial = totalWeight > 0 && effortCoverage < EFFORT_FULL_COVERAGE;

  const causes = USAGE_CAUSE_IDS.map((id): UsageCauseResult => {
    const tally = cause.get(id)!;
    const needsEffort = id === 'maxEffort' || id === 'workflows';
    if (needsEffort && totalWeight > 0 && effortKnownWeight === 0) {
      return {
        id, share: null, percent: null, shown: false, requests: 0, sessions: 0,
        unavailable: 'effort-not-recorded',
      };
    }
    const share = totalWeight > 0 ? tally.weight / totalWeight : 0;
    const percent = sharePercent(share);
    const result: UsageCauseResult = {
      id, share, percent, shown: isCauseShown(share),
      requests: tally.requests, sessions: tally.sessions.size,
    };
    if (needsEffort && effortPartial) result.atLeast = true;
    if (id === 'alwaysOnContext' && tally.sessions.size > 0) {
      result.typicalTokens = Math.round(median([...tally.sessions].map((s) => session(s).startPromptTokens ?? 0)));
    }
    if (id === 'longRunning' && tally.sessions.size > 0) {
      result.typicalHours = Math.round(
        median([...tally.sessions].map((s) => (sessionStats.get(s)?.activeMs ?? 0) / 3_600_000)) * 10,
      ) / 10;
    }
    return result;
  });

  const notes: UsageInsightNote[] = [...(input.notes ?? [])];
  if (approximatePrices > 0) notes.push({ code: 'prices-approximate', count: approximatePrices });
  if (inScope.length === 0) notes.push({ code: 'no-claude-usage' });
  else if (effortKnownWeight > 0 && effortPartial) {
    notes.push({ code: 'effort-partly-recorded', knownPercent: Math.round(effortCoverage * 100) });
  }

  return {
    generatedAt: input.now,
    windowStart,
    windowEnd: input.now,
    scope: input.scope,
    totals: {
      requests: inScope.length,
      sessions: sessionsInScope.size,
      harnessSessions: linkedSessions.size,
    },
    causes,
    coverage: {
      effortKnown: effortCoverage,
      harnessLinked: totalWeight > 0 ? linkedWeight / totalWeight : 0,
    },
    notes,
  };
}

interface Tally {
  weight: number;
  requests: number;
  sessions: Set<string>;
}

function newTally(): Tally {
  return { weight: 0, requests: 0, sessions: new Set<string>() };
}

function defaultSession(sessionId: string): UsageSessionFact {
  return { sessionId, groupKey: sessionId, isHelperSession: false, efforts: [] };
}

/** Working time: gaps up to the idle cap count in full, longer gaps count as the cap. */
function activeDuration(times: readonly number[]): number {
  if (times.length < 2) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  let total = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    total += Math.min(sorted[index] - sorted[index - 1], IDLE_GAP_CAP_MS);
  }
  return total;
}

/**
 * The effort in force for a request, from the records written as turns finish
 * (oldest first).
 *
 * - Records on both sides with the same effort: that effort held in between, however long the gap.
 * - Otherwise the record just after the request describes the turn it belonged to; failing that,
 *   the one just before. Either must be within {@link EFFORT_MATCH_MAX_GAP_MS}, so a request
 *   far from any record is reported as unknown rather than guessed.
 */
export function effortAt(efforts: readonly { at: number; effort: string }[], at: number): string | undefined {
  if (efforts.length === 0) return undefined;
  let low = 0;
  let high = efforts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (efforts[middle].at < at) low = middle + 1;
    else high = middle;
  }
  const next = efforts[low];
  const previous = efforts[low - 1];
  if (next && previous && next.effort === previous.effort) return next.effort;
  if (next && next.at - at <= EFFORT_MATCH_MAX_GAP_MS) return next.effort;
  if (previous && at - previous.at <= EFFORT_MATCH_MAX_GAP_MS) return previous.effort;
  return undefined;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
