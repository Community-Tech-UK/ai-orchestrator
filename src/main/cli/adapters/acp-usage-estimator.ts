/**
 * ACP turn usage/estimation — extracted from `AcpCliAdapter` so the LT-100
 * heuristic-estimate fallback and the LT-018 context-usage-event shaping are
 * independently testable, matching the pattern used for
 * `claude-cli-argv-builder.ts` and `context-usage-restore.ts`.
 *
 * No behaviour change from the pre-extraction inline version: every branch
 * and log-relevant value is preserved verbatim, just re-expressed as pure
 * functions instead of adapter `this` state. The adapter still owns the
 * stateful bits (the running `cumulativeTokens` counter, the "logged once"
 * flag, and the actual `emit`/`logger` calls) — these functions only compute
 * what to do with them.
 */

import { estimateTokens } from '../../../shared/utils/token-estimate';
import type { AcpPromptUsage } from '../../../shared/types/cli.types';
import type { CliUsage } from './base-cli-adapter';

/** True when the ACP server sent at least one real token field on this turn. */
export function hasMeasuredAcpUsage(usage: AcpPromptUsage | undefined): boolean {
  return (
    usage !== undefined &&
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined)
  );
}

/**
 * Heuristic fallback for {@link toAcpCliUsage} when the ACP server reports no
 * usage at all. Uses the shared, dependency-free `estimateTokens` primitive
 * (same one context/memory budgeting uses) against the material actually
 * available for this turn: the prompt text sent, the assembled response
 * text, and any tool-call arguments/results observed during the turn. Never
 * fabricates a number when there is nothing to estimate from.
 */
export function estimateAcpCliUsage(
  promptText: string,
  responseText: string,
  toolActivityText: string,
  duration: number,
): CliUsage | undefined {
  const inputTokens = estimateTokens(promptText);
  const outputTokens = estimateTokens(responseText) + estimateTokens(toolActivityText);
  if (inputTokens === 0 && outputTokens === 0) {
    return duration > 0 ? { duration } : undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    duration,
    isEstimated: true,
  };
}

/**
 * Build the `CliResponse.usage` a turn reports for cost accounting.
 *
 * When the ACP server itself sends a `usage` object with real token
 * fields, it is trusted as-is (measured). When it sends nothing —
 * `usageKeys: null` in the adapter's log line, `usage.inputTokens` /
 * `outputTokens` / `totalTokens` all absent — this used to return
 * `{ duration }` only, which `normalizeUsage()` cannot turn into a cost
 * entry, so Cursor/Grok/Copilot turns recorded **zero** cost (LT-100).
 *
 * James's decision: estimate, but never silently. {@link estimateAcpCliUsage}
 * derives a heuristic count from the prompt/response/tool-call material the
 * adapter actually has and tags it `isEstimated: true` so every downstream
 * cost surface can keep it visibly distinct from a measured entry — the same
 * discipline `ContextUsage.isEstimated` already establishes for the context
 * bar (LT-018).
 */
export function toAcpCliUsage(
  usage: AcpPromptUsage | undefined,
  duration: number,
  promptText: string,
  responseText: string,
  toolActivityText: string,
): CliUsage | undefined {
  if (hasMeasuredAcpUsage(usage)) {
    return {
      inputTokens: usage!.inputTokens,
      outputTokens: usage!.outputTokens,
      totalTokens: usage!.totalTokens,
      cost: usage!.costUsd,
      duration,
    };
  }

  return estimateAcpCliUsage(promptText, responseText, toolActivityText, duration);
}

/** Shape emitted on the adapter's `context` event. */
export interface AcpContextUsageEvent {
  used: number;
  total: number;
  percentage: number;
  cumulativeTokens: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Compute the `context` event (LT-018) for a turn's raw ACP usage.
 *
 * Deliberately conservative: `used` is the aggregate, not a true
 * context-window occupancy, because ACP does not report one and fabricating
 * it would be worse. No usage ⇒ no event (a missing bar beats a confident
 * zero) — `event` is `null` and `usageKeys` carries what the caller should
 * log (once per session, not once per turn — that dedup stays with the
 * adapter's own `loggedMissingUsage` flag).
 *
 * Deliberately NOT fed the LT-100 estimate {@link estimateAcpCliUsage}
 * computes for cost — occupancy stays honest even when cost falls back to
 * an estimate.
 */
export function buildAcpContextUsageEvent(
  usage: AcpPromptUsage | undefined,
  cumulativeTokensBefore: number,
  contextWindow: number,
): { event: AcpContextUsageEvent | null; cumulativeTokensAfter: number; usageKeys: string[] | null } {
  const partTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const turnTokens = usage?.totalTokens || partTokens;
  if (!turnTokens || turnTokens <= 0) {
    return {
      event: null,
      cumulativeTokensAfter: cumulativeTokensBefore,
      usageKeys: usage ? Object.keys(usage) : null,
    };
  }

  const cumulativeTokensAfter = cumulativeTokensBefore + turnTokens;
  const total = contextWindow;
  const used = cumulativeTokensAfter;
  return {
    event: {
      used,
      total,
      percentage: total > 0 ? Math.min((used / total) * 100, 100) : 0,
      cumulativeTokens: cumulativeTokensAfter,
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    },
    cumulativeTokensAfter,
    usageKeys: null,
  };
}
