/**
 * After a native-resume spawn, wait until the adapter or the session's context usage shows whether the provider
 * resumed the archived session, or the window ends. Used by `HistoryRestoreCoordinator`.
 */
import type { ResumeAttemptResult } from '../cli/adapters/base-cli-adapter.types';
import type { InstanceManager } from '../instance/instance-manager';

/**
 * Duck-typed accessor for adapter resume proof.
 * Returns true/false if the adapter has a definitive answer, null if still pending.
 */
function getAdapterResumeProof(instanceManager: Pick<InstanceManager, 'getInstance'>, instanceId: string): boolean | null {
  // getAdapter is on InstanceManager but not on slimmer dep types — use optional call.
  const adapter = (instanceManager as unknown as { getAdapter?(id: string): unknown }).getAdapter?.(instanceId);
  if (!adapter) return null;
  const a = adapter as { getResumeAttemptResult?: () => ResumeAttemptResult | null | undefined };
  if (typeof a.getResumeAttemptResult !== 'function') return null;
  const result = a.getResumeAttemptResult();
  if (!result || result.source === 'none') return null;
  // fresh-fallback means no native resume was attempted — definitively not confirmed.
  if (result.source === 'fresh-fallback') return false;
  // A `--fork-session` resume returns a NEW id by definition, so a mismatch is
  // the success shape, not a failure (LT-008 — see ResumeAttemptResult.forked).
  if (!result.forked && result.actualSessionId && result.requestedSessionId
      && result.actualSessionId !== result.requestedSessionId) return false;
  if (result.confirmed) return true;
  if (result.reason) return false;
  return null;
}

/**
 * Outcome of the post-spawn resume probe. `disproven` separates "the adapter
 * told us the native resume did NOT happen" from "we never got proof either
 * way".
 *
 * It deliberately does NOT demote the restore to the replay rung: an
 * alive-but-unresumed instance stays on `resume-unconfirmed` by design (the
 * B1/B2 locks in `history-restore-coordinator.spec.ts`). Killing a healthy
 * process only to spawn an identical one buys nothing — the archived
 * transcript is already shown (older messages in output storage) and the
 * continuity preamble is queued.
 *
 * It does drive two things a silent `resume-unconfirmed` used to skip
 * (LT-014, James's call 2026-07-27): the user-facing "could not be restored
 * natively" notice, and recording `nativeResumeFailedAt` so the next restore
 * skips the doomed native rung. A merely-unproven resume (`disproven: false`)
 * stays silent — absence of proof is not proof of absence.
 */
export interface ResumeWaitState {
  alive: boolean;
  confirmed: boolean;
  disproven: boolean;
}

export function waitForResumeState(
  instanceManager: Pick<InstanceManager, 'getInstance'>,
  instanceId: string,
  postSpawnTimeoutMs: number,
  pollIntervalMs: number,
): Promise<ResumeWaitState> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
    };
    const complete = (value: ResumeWaitState): void => {
      if (!settled) {
        cleanup();
        resolve(value);
      }
    };
    const inspect = (): ResumeWaitState => {
      const inst = instanceManager.getInstance(instanceId);
      const alive = inst != null
        && inst.status !== 'error'
        && inst.status !== 'terminated'
        && inst.status !== 'respawning';
      if (!alive) return { alive: false, confirmed: false, disproven: false };

      // Prefer adapter proof (set from init events) over context-usage heuristic.
      // A `false` here is a DEFINITIVE negative (LT-014): the adapter already
      // knows the native resume did not happen — e.g. Claude found no
      // transcript for the id under this cwd and spawned fresh. The rung is
      // unchanged (still `resume-unconfirmed`), but there is nothing left to
      // wait for, so the probe stops now rather than at the timeout.
      const proof = getAdapterResumeProof(instanceManager, instanceId);
      if (proof !== null) return { alive: true, confirmed: proof, disproven: !proof };

      // Fall back to context-usage heuristic (used > 0 means the provider resumed).
      // Absence of usage is not proof of failure — it stays merely unconfirmed.
      const confirmed = Boolean(inst.contextUsage && inst.contextUsage.used > 0);
      return { alive, confirmed, disproven: false };
    };

    const timeout = setTimeout(() => {
      complete(inspect());
    }, postSpawnTimeoutMs);

    const poll = setInterval(() => {
      const state = inspect();
      if (!state.alive || state.confirmed || state.disproven) {
        complete(state);
      }
    }, pollIntervalMs);
  });
}
