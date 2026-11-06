/**
 * Thresholds and button targets for the nine causes.
 *
 * Every number here comes from the cause names Anthropic uses ("cache misses
 * over 100K", "context over 150K", ...). The measuring code and the card both
 * read these constants, so the wording and the maths cannot drift apart.
 */

import { USAGE_CAUSE_IDS, type UsageCauseId, type UsageCauseResult } from './usage-insight.types';

export const USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A cause is shown only when its actual share is at least this many percent. */
export const SHOW_THRESHOLD_PERCENT = 10;
/** The same line as a fraction. The decision uses the exact share, never the rounded label. */
export const SHOW_THRESHOLD_SHARE = SHOW_THRESHOLD_PERCENT / 100;

/** Tokens read fresh (not from Claude's held copy of the chat) in one request. */
export const CACHE_MISS_TOKENS = 100_000;
/** Prompt size in one request. */
export const LONG_CONTEXT_TOKENS = 150_000;
/** Sessions working in the same bucket for it to count as parallel. */
export const PARALLEL_SESSIONS = 4;
/** Width of the stretch of time used to decide which sessions were working together. */
export const PARALLEL_BUCKET_MS = 5 * 60 * 1000;
/** Working time for a session to count as open all day. */
export const LONG_RUNNING_HOURS = 8;
/** A gap longer than this counts as this much working time, not the whole gap. */
export const IDLE_GAP_CAP_MS = 30 * 60 * 1000;
/** Share of a session's usage that helpers must account for. */
export const HELPER_HEAVY_SHARE = 0.5;
/** Prompt size of a session's first request. */
export const ALWAYS_ON_TOKENS = 40_000;
/** One tool result, estimated in tokens. */
export const BIG_TOOL_RESULT_TOKENS = 10_000;
/** A prompt shrinking below this fraction of the one before it means the chat was cut down. */
export const CONTEXT_RESET_FRACTION = 0.5;

/** Effort values that make a request count towards a cause. */
export const MAX_EFFORT_VALUE = 'max';
export const WORKFLOW_EFFORT_VALUE = 'workflow';

/** What a cause's button does. The renderer decides how; only real targets appear here. */
export type UsageCauseAction =
  | { kind: 'compact-session'; label: string }
  | { kind: 'open-settings'; tab: 'memory' | 'orchestration'; label: string }
  | { kind: 'open-route'; path: '/automations'; label: string }
  | { kind: 'open-context-details'; label: string };

export interface UsageCauseDefinition {
  id: UsageCauseId;
  /** Absent when Harness has no control for it (the card shows the sentence only). */
  action?: UsageCauseAction;
  /**
   * True when the share rests on an approximation the records can't confirm: sessions
   * "together" are those active in the same five minutes, working time caps each gap at
   * 30 minutes, and a tool result's size is its length divided by four. The card marks
   * these shares as estimates.
   */
  estimated?: boolean;
}

/**
 * Parallel sessions, max effort and workflows have no button. The tool-result
 * cause has none either until a setting for the result limits exists.
 */
export const USAGE_CAUSES: readonly UsageCauseDefinition[] = [
  { id: 'cacheMiss', action: { kind: 'compact-session', label: 'Compact first' } },
  { id: 'longContext', action: { kind: 'open-settings', tab: 'memory', label: 'Chat size cap' } },
  { id: 'helperHeavy', action: { kind: 'open-settings', tab: 'orchestration', label: 'Helper settings' } },
  { id: 'parallelSessions', estimated: true },
  { id: 'longRunning', action: { kind: 'open-route', path: '/automations', label: 'Scheduled jobs' }, estimated: true },
  { id: 'maxEffort' },
  { id: 'workflows' },
  { id: 'alwaysOnContext', action: { kind: 'open-context-details', label: 'Context details' } },
  { id: 'bigToolResults', estimated: true },
];

export function usageCauseDefinition(id: UsageCauseId): UsageCauseDefinition {
  return USAGE_CAUSES.find((cause) => cause.id === id) ?? { id };
}

/** The whole-number label for a share. Display only: 9.5% reads as 10, but is still under the line. */
export function sharePercent(share: number): number {
  return Math.round(Math.min(1, Math.max(0, share)) * 100);
}

/** The 10% rule, applied to the exact share (null means the cause was not measured). */
export function isCauseShown(share: number | null): boolean {
  return share !== null && Number.isFinite(share) && share >= SHOW_THRESHOLD_SHARE;
}

/** The causes to draw, in the plan's order. Causes below the threshold or not measured are left out. */
export function shownCauses(causes: readonly UsageCauseResult[]): UsageCauseResult[] {
  const order = new Map(USAGE_CAUSE_IDS.map((id, index) => [id, index] as const));
  return causes
    .filter((cause) => cause.shown)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Causes that could not be measured at all, so the card can say so instead of hiding them. */
export function unmeasuredCauses(causes: readonly UsageCauseResult[]): UsageCauseResult[] {
  return causes.filter((cause) => cause.share === null);
}
