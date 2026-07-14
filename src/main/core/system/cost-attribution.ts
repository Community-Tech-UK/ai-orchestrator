/**
 * Per-call-site cost attribution sink (claude-fanout-audit, Phase 1).
 *
 * Flag-gated, fail-soft JSONL writer that tags every LLM invocation with the
 * orchestration feature that triggered it, so token/dollar spend can be
 * aggregated per task-type instead of only per instance/session.
 *
 * Three seams feed it:
 *   - `invokeCliTextResponse` (default-invokers) — one-shot orchestration
 *     calls (loop iterations, verify/review/debate gates, workflows,
 *     branch-select). `taskType` is the breaker key.
 *   - `recordCompletionCost` (instance-communication) — interactive chat
 *     turns and spawned child instances. `taskType` derives from the
 *     instance's parent/agent shape.
 *   - `AuxiliaryLlmService.generate` — the 11 helper slots (compaction, memory
 *     distillation, scoring, titles, ...). `taskType` is `aux:<slot>`. These
 *     were previously uninstrumented, which made the local-vs-frontier split
 *     unmeasurable — and three slots (`compression`, `memoryDistillation`,
 *     `branchScoring`) silently escalate to a frontier model when no local
 *     endpoint is healthy, so their spend was completely invisible.
 *
 * Enabled by default (opt-out with AIO_COST_ATTRIBUTION=0 or "false") so
 * day-to-day burn is always attributable. Output directory:
 * AIO_COST_ATTRIBUTION_DIR if set, otherwise `<userData>/cost-attribution`.
 * Outside Electron with no explicit dir the sink stays disabled, so worker
 * and test contexts stay silent unless they opt in with an explicit dir.
 * Writes must never break the invocation path: every failure is swallowed
 * after a single warning.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../../logging/logger';

const logger = getLogger('CostAttribution');

export interface CostAttributionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** Provider-reported cost in USD (e.g. claude --print `total_cost_usd`). */
  cost?: number;
}

export interface CostAttributionRecord {
  /** Which seam produced the record. */
  source: 'one-shot' | 'instance-turn' | 'auxiliary';
  /**
   * Feature/task-type tag. One-shot calls use the breaker key
   * (`loop-orchestration:claude`, `verify-orchestration`, ...); instance
   * turns use `chat:<agentId>` or `child:<agentId>`.
   */
  taskType: string;
  correlationId?: string;
  instanceId?: string;
  parentId?: string | null;
  agentId?: string;
  /** Resolved CLI/provider type (claude, gemini, codex, ollama, ...). */
  provider?: string;
  model?: string;
  usage?: CostAttributionUsage;
  /** False when the provider reported no cost and 0 was assumed. */
  costKnown?: boolean;
  /** `auxiliary` only: where the slot actually ran. */
  auxRoutedTo?: 'local' | 'cheap-cloud' | 'fallback';
  /**
   * `auxiliary` only: true when no local endpoint was usable AND the slot
   * permits frontier fallback, so the caller is about to re-run this prompt on
   * a paid model. Aggregate these to size the silent cloud escalation.
   */
  auxEscalatedToFrontier?: boolean;
  /** `auxiliary` only: which configured endpoint served the call. */
  auxEndpointId?: string;
  /** `auxiliary` only: why the slot resolved the way it did. */
  auxReason?: string;
  /** Pre-dispatch reservation used to enforce the configured daily aux cap. */
  auxiliarySpendReservationUsd?: number;
}

let cachedDir: string | null | undefined;
let warnedOnce = false;

function isEnabled(): boolean {
  // Default-on: only an explicit opt-out disables the sink. '1'/'true' remain
  // valid (legacy opt-in invocations keep working unchanged).
  const raw = process.env['AIO_COST_ATTRIBUTION'];
  return raw !== '0' && raw !== 'false';
}

function resolveElectronUserData(): string | undefined {
  try {
    // Lazy, guarded require — this module must also load in worker/test
    // contexts where electron is unavailable (same pattern as rlm-database).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath?: (n: string) => string } };
    return electron.app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

function resolveDir(): string | null {
  if (cachedDir !== undefined) return cachedDir;
  const explicit = process.env['AIO_COST_ATTRIBUTION_DIR'];
  const base = explicit && explicit.trim()
    ? explicit.trim()
    : (() => {
        const userData = resolveElectronUserData();
        return userData ? join(userData, 'cost-attribution') : null;
      })();
  if (base) {
    try {
      mkdirSync(base, { recursive: true });
    } catch (err) {
      if (!warnedOnce) {
        warnedOnce = true;
        logger.warn('Cost attribution directory could not be created; sink disabled', {
          dir: base,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      cachedDir = null;
      return cachedDir;
    }
  }
  cachedDir = base;
  return cachedDir;
}

/** Current target file, or null when the sink is disabled/unavailable. */
export function getCostAttributionFilePath(): string | null {
  if (!isEnabled()) return null;
  const dir = resolveDir();
  if (!dir) return null;
  const day = new Date().toISOString().slice(0, 10);
  return join(dir, `cost-attribution-${day}.jsonl`);
}

/**
 * Append one attribution record. No-op when AIO_COST_ATTRIBUTION opts out
 * ('0'/'false') or no sink directory is resolvable. Never throws.
 */
export function recordCostAttribution(record: CostAttributionRecord): void {
  if (!isEnabled()) return;
  try {
    const file = getCostAttributionFilePath();
    if (!file) return;
    const line = JSON.stringify({ ts: Date.now(), ...record });
    appendFileSync(file, line + '\n', 'utf8');
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      logger.warn('Cost attribution write failed; further failures are silent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Convenience wrapper for the instance-turn seam: derives the task-type from
 * the instance shape so the call site stays a single line. `usage` accepts the
 * already-normalized token counts from `recordCompletionCost`.
 */
export function recordInstanceTurnAttribution(args: {
  instanceId: string;
  parentId?: string | null;
  agentId?: string;
  provider?: string;
  model?: string;
  usage: CostAttributionUsage;
  costKnown: boolean;
}): void {
  if (!isEnabled()) return;
  const role = args.parentId ? 'child' : 'chat';
  recordCostAttribution({
    source: 'instance-turn',
    taskType: `${role}:${args.agentId ?? 'unknown'}`,
    instanceId: args.instanceId,
    parentId: args.parentId ?? null,
    agentId: args.agentId,
    provider: args.provider,
    model: args.model,
    usage: args.usage,
    costKnown: args.costKnown,
  });
}

/**
 * Auxiliary-slot seam. Records every helper-slot generation so the local-vs-
 * frontier split is measurable.
 *
 * `escalatedToFrontier` is the number that matters: when a slot with
 * `allowFrontierFallback: true` finds no healthy local endpoint, the *caller*
 * silently re-runs the prompt against the frontier model. The aux service
 * cannot see that call's cost, but it can flag that it is about to happen —
 * which is the difference between "the 5090 is doing this" and "we are paying
 * Opus to summarise a conversation".
 *
 * Local models report no dollar cost, so `costKnown` is false for them; the
 * token counts are the useful signal.
 */
export function recordAuxiliaryAttribution(args: {
  slot: string;
  provider?: string;
  endpointId?: string;
  model?: string;
  /** Where the call actually ran. `fallback` means no endpoint was usable. */
  routedTo: 'local' | 'cheap-cloud' | 'fallback';
  /** True when this fallback will be retried against a frontier model by the caller. */
  escalatedToFrontier: boolean;
  usage?: CostAttributionUsage;
  reason?: string;
}): void {
  if (!isEnabled()) return;
  recordCostAttribution({
    source: 'auxiliary',
    taskType: `aux:${args.slot}`,
    provider: args.provider,
    model: args.model,
    usage: args.usage,
    // Local/cheap endpoints don't report dollars; the frontier retry is billed
    // on the caller's own seam, not here.
    costKnown: false,
    auxRoutedTo: args.routedTo,
    auxEscalatedToFrontier: args.escalatedToFrontier,
    ...(args.endpointId ? { auxEndpointId: args.endpointId } : {}),
    ...(args.reason ? { auxReason: args.reason } : {}),
  });
}

export interface AuxiliarySpendReservation {
  capUsd: number;
  amountUsd: number;
  slot: string;
  provider?: string;
  endpointId?: string;
  model?: string;
}

/**
 * Durably reserve an auxiliary cloud call's worst-case cost before dispatch.
 * The append is synchronous, so consecutive service calls cannot both observe
 * the same remaining balance in one Electron main process. Failed calls keep
 * their reservation deliberately: releasing an uncertain remote charge would
 * make a configured cap advisory rather than hard.
 */
export function reserveAuxiliarySpend(
  reservation: AuxiliarySpendReservation,
): { allowed: boolean; spentUsd: number } {
  if (
    !isEnabled()
    || !Number.isFinite(reservation.capUsd)
    || reservation.capUsd < 0
    || !Number.isFinite(reservation.amountUsd)
    || reservation.amountUsd < 0
  ) {
    return { allowed: false, spentUsd: 0 };
  }

  try {
    const file = getCostAttributionFilePath();
    if (!file) return { allowed: false, spentUsd: 0 };

    const spentUsd = readReservedAuxiliarySpend(file);
    if (spentUsd + reservation.amountUsd > reservation.capUsd) {
      return { allowed: false, spentUsd };
    }

    const line = JSON.stringify({
      ts: Date.now(),
      source: 'auxiliary',
      taskType: `aux:${reservation.slot}`,
      ...(reservation.provider ? { provider: reservation.provider } : {}),
      ...(reservation.model ? { model: reservation.model } : {}),
      ...(reservation.endpointId ? { auxEndpointId: reservation.endpointId } : {}),
      auxiliarySpendReservationUsd: reservation.amountUsd,
    });
    appendFileSync(file, line + '\n', 'utf8');
    return { allowed: true, spentUsd: spentUsd + reservation.amountUsd };
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      logger.warn('Auxiliary spend reservation failed; capped cloud dispatch denied', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { allowed: false, spentUsd: 0 };
  }
}

function readReservedAuxiliarySpend(file: string): number {
  if (!existsSync(file)) return 0;
  let total = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { source?: unknown; auxiliarySpendReservationUsd?: unknown };
      const amount = record.auxiliarySpendReservationUsd;
      if (record.source === 'auxiliary' && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
        total += amount;
      }
    } catch {
      // A partial trailing line must never turn a spend cap into an outage.
    }
  }
  return total;
}

/** Test-only: clear cached directory resolution and warning latch. */
export function _resetCostAttributionForTesting(): void {
  cachedDir = undefined;
  warnedOnce = false;
}
