/**
 * Rebuild an instance's `contextUsage` from persisted session-continuity state
 * (LT-018).
 *
 * Extracted from the wake path so the one non-obvious rule here — when it is
 * safe to claim `occupancyReported` — is stated in one place and testable
 * directly, rather than buried in a 2000-line lifecycle method.
 */

import type { ContextUsage } from '../../../shared/types/instance.types';

/** The subset of persisted state this restore reads. */
export interface PersistedContextUsage {
  used: number;
  total: number;
  costEstimate?: number;
  occupancyReported?: boolean;
}

/**
 * Whether the persisted numbers represent a real measurement.
 *
 * The explicit flag is authoritative when present. A non-zero `used` is treated
 * as equivalent evidence, which is what makes records written *before* the flag
 * existed restore correctly instead of degrading to "no data".
 *
 * That inference is sound because every path that writes a placeholder or a
 * reset sets `used: 0`:
 *   - the create-time seed (`instance-create-builder.ts`),
 *   - the post-compaction reset (`compaction-runtime.ts` `buildPostCompactionUsage`),
 *   - `restoreContext === false` (`session-continuity.ts`),
 *   - the fresh-restart reset (`restart-policy-helpers.ts` `resetBackendSessionState`).
 * The provider/model-swap writers (`instance-lifecycle.ts`,
 * `runtime-reconciler.ts`) only ever spread an existing value, changing `total`
 * and `percentage`, so they cannot manufacture a non-zero `used` either.
 * A persisted non-zero `used` can therefore only have come from a provider report.
 *
 * It also keeps the UI self-consistent. The context-warning banner fires off
 * `percentage` alone at >= 75 %, a threshold the placeholder (percentage 0) can
 * never reach — so without this inference a woken legacy session would show
 * "no data" on every context surface while the banner simultaneously offered to
 * compact it.
 */
export function persistedOccupancyIsReal(persisted: PersistedContextUsage): boolean {
  return persisted.occupancyReported === true || persisted.used > 0;
}

export function restoreContextUsage(persisted: PersistedContextUsage): ContextUsage {
  return {
    used: persisted.used,
    total: persisted.total,
    percentage: persisted.total > 0
      ? Math.min((persisted.used / persisted.total) * 100, 100)
      : 0,
    costEstimate: persisted.costEstimate,
    ...(persistedOccupancyIsReal(persisted) ? { occupancyReported: true } : {}),
  };
}

/**
 * Rebuild `contextUsage` across a runtime change (provider/model swap).
 *
 * When the session genuinely resumes, occupancy carries over and only the
 * window changes. When the session identity is minted fresh — always the case
 * for a cross-provider swap, since `planContinuity` forces replay — the old
 * provider's `used` belongs to a session that no longer exists and its
 * `occupancyReported` is a claim about a runtime being torn down. Carrying
 * either across produced a *confident* percentage computed from the previous
 * provider's token count against the new provider's window, broadcast in a
 * visible `idle` state before the new runtime had run a single turn; a swap to
 * a smaller window could fake a >= 95 % reading, which disables the composer.
 *
 * Accrued cost is preserved either way — spend already incurred does not become
 * untrue because the runtime changed.
 *
 * Mirrors `resetBackendSessionState` (`restart-policy-helpers.ts`), which the
 * other mint-new-session-and-replay flows already use.
 */
export function resolveSwapContextUsage(
  previous: ContextUsage,
  contextTotal: number,
  shouldResume: boolean,
): ContextUsage {
  if (shouldResume) {
    return {
      ...previous,
      total: contextTotal,
      percentage: contextTotal > 0
        ? Math.min((previous.used / contextTotal) * 100, 100)
        : 0,
    };
  }
  return {
    ...(previous.costEstimate !== undefined ? { costEstimate: previous.costEstimate } : {}),
    used: 0,
    total: contextTotal,
    percentage: 0,
  };
}
