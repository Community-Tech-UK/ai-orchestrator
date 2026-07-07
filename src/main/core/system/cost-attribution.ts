/**
 * Per-call-site cost attribution sink (claude-fanout-audit, Phase 1).
 *
 * Flag-gated, fail-soft JSONL writer that tags every LLM invocation with the
 * orchestration feature that triggered it, so token/dollar spend can be
 * aggregated per task-type instead of only per instance/session.
 *
 * Two seams feed it:
 *   - `invokeCliTextResponse` (default-invokers) — one-shot orchestration
 *     calls (loop iterations, verify/review/debate gates, workflows,
 *     branch-select). `taskType` is the breaker key.
 *   - `recordCompletionCost` (instance-communication) — interactive chat
 *     turns and spawned child instances. `taskType` derives from the
 *     instance's parent/agent shape.
 *
 * Enabled only when AIO_COST_ATTRIBUTION=1 (or "true"). Output directory:
 * AIO_COST_ATTRIBUTION_DIR if set, otherwise `<userData>/cost-attribution`.
 * Outside Electron with no explicit dir the sink stays disabled. Writes must
 * never break the invocation path: every failure is swallowed after a single
 * warning.
 */

import { appendFileSync, mkdirSync } from 'fs';
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
  source: 'one-shot' | 'instance-turn';
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
}

let cachedDir: string | null | undefined;
let warnedOnce = false;

function isEnabled(): boolean {
  const raw = process.env['AIO_COST_ATTRIBUTION'];
  return raw === '1' || raw === 'true';
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
 * Append one attribution record. No-op unless AIO_COST_ATTRIBUTION is set and
 * a sink directory is resolvable. Never throws.
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

/** Test-only: clear cached directory resolution and warning latch. */
export function _resetCostAttributionForTesting(): void {
  cachedDir = undefined;
  warnedOnce = false;
}
