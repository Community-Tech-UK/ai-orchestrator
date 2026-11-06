import type { CostBiggestTurn, CostCodexCreditsSummary } from '../../../shared/types/cost-purpose.types';
import type { SessionKind } from '../../../shared/types/session-kind.types';
import { purposeOf, type CostAttributionRecord } from './cost-attribution';
import type { SessionThreadCreditsRecord, SessionTurnShareRecord } from './session-policy-log';

/** Oct-2 Phase D Step 1: "Biggest turns this week" on the Costs page. */
export const BIGGEST_TURNS_LIMIT = 10;
export const BIGGEST_TURNS_WINDOW_MS = 7 * 86_400_000;

type Dated<T> = T & { at: number };
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const KINDS: ReadonlySet<string> = new Set<SessionKind>(['chat', 'child', 'loop', 'plan-queue', 'automation', 'review']);

function turnKey(identity: CostAttributionRecord['codexTurn']): string | undefined {
  return typeof identity?.threadId === 'string' && identity.threadId.length > 0
    && typeof identity.turnId === 'string' && identity.turnId.length > 0
    ? JSON.stringify([identity.threadId, identity.turnId]) : undefined;
}

/** Input (cached input and cache writes included) plus output, as the provider processed them. */
export function processedTokensOf(usage: CostAttributionRecord['usage']): number {
  return count(usage?.inputTokens) + count(usage?.cacheReadTokens) + count(usage?.cacheWriteTokens)
    + count(usage?.outputTokens) + count(usage?.reasoningTokens);
}

/** Rows written before `sessionKind` existed still carry a purpose that names the kind. */
export function kindOfCostRow(record: Pick<CostAttributionRecord, 'sessionKind' | 'purpose' | 'taskType'>): SessionKind | 'unknown' {
  if (record.sessionKind && KINDS.has(record.sessionKind)) return record.sessionKind;
  const purpose = purposeOf(record);
  if (KINDS.has(purpose)) return purpose as SessionKind;
  return purpose.includes('review') ? 'review' : 'unknown';
}

export interface BiggestTurnsInput {
  /** Per-turn cost rows with their write time, already limited to the window. */
  costRows: Iterable<CostAttributionRecord & { ts: number }>;
  /** The latest turn-share row per Codex round, already limited to the window. */
  shareRows: readonly Dated<SessionTurnShareRecord>[];
  limit?: number;
}

/**
 * The biggest turns by processed tokens. A Codex round comes from its turn-share
 * row, which knows the helper threads' part and whether Harness stopped it; the
 * round's own cost row is left out so one round is never listed twice.
 */
export function collectBiggestTurns({ costRows, shareRows, limit = BIGGEST_TURNS_LIMIT }: BiggestTurnsInput): CostBiggestTurn[] {
  const measuredShares = shareRows.filter((row) => count(row.totalTokens) > 0);
  const candidates: CostBiggestTurn[] = measuredShares
    .map((row) => ({
      at: row.at,
      ...(row.instanceId ? { instanceId: row.instanceId } : {}),
      kind: KINDS.has(row.sessionKind) ? row.sessionKind : 'unknown',
      provider: 'codex',
      processedTokens: count(row.totalTokens),
      helperTokens: count(row.helperTokens),
      helperShare: Math.min(1, count(row.helperShare)),
      stopRequested: row.stopRequested === true,
      source: 'codex-round' as const,
    }));
  const represented = new Set(measuredShares.map(turnKey).filter((key): key is string => key !== undefined));
  for (const row of costRows) {
    if (row.source !== 'instance-turn') continue;
    // Persisted legacy and command-mode rows cannot prove a native turn match.
    // Keep them, even if this may show an old duplicate: deleting distinct
    // same-session history or guessing identity from time/totals loses evidence.
    const key = turnKey(row.codexTurn);
    if (row.provider === 'codex' && key !== undefined && represented.has(key)) continue;
    const processedTokens = processedTokensOf(row.usage);
    if (processedTokens <= 0) continue;
    candidates.push({
      at: row.ts,
      ...(row.instanceId ? { instanceId: row.instanceId } : {}),
      kind: kindOfCostRow(row),
      provider: row.provider ?? 'unknown',
      ...(row.model ? { model: row.model } : {}),
      processedTokens,
      source: 'turn-cost',
    });
  }
  return candidates.sort((a, b) => b.processedTokens - a.processedTokens || b.at - a.at).slice(0, Math.max(0, limit));
}

const MICROS = 1_000_000;

/** One reading per thread (the latest, since each is cumulative), totalled and split by session kind. */
export function summariseCodexCredits(rows: readonly Dated<SessionThreadCreditsRecord>[]): CostCodexCreditsSummary {
  const byKind = new Map<SessionKind, { threads: number; credits: number }>();
  let credits = 0;
  let usdMicros = 0;
  let hasUsd = false;
  for (const row of rows) {
    const micros = count(row.estimatedUsageCreditsMicros);
    credits += micros;
    if (row.estimatedUsageUsdMicros !== null && row.estimatedUsageUsdMicros !== undefined) {
      usdMicros += count(row.estimatedUsageUsdMicros);
      hasUsd = true;
    }
    const entry = byKind.get(row.sessionKind) ?? { threads: 0, credits: 0 };
    entry.threads += 1;
    entry.credits += micros / MICROS;
    byKind.set(row.sessionKind, entry);
  }
  return {
    threads: rows.length,
    credits: credits / MICROS,
    estimatedUsd: hasUsd ? usdMicros / MICROS : null,
    byKind: [...byKind].map(([kind, entry]) => ({ kind, ...entry })).sort((a, b) => b.credits - a.credits),
  };
}
