/**
 * T2 — capability-gated loop goal skip.
 *
 * Skip the goal / prior-observations blocks only when the live thread is
 * proven same-thread (resume + continuation), the model matches, and the
 * window was not just recycled. Anything uncertain re-anchors (keeps the goal).
 */

export interface LoopThreadCaps {
  supportsResume: boolean;
  sameThreadContinuation: boolean;
  /** Model that actually ran. Null means unknown — fail closed. */
  model: string | null;
}

export function shouldReanchorLoopGoal(input: {
  iterationSeq: number;
  lastThreadCaps?: LoopThreadCaps | null;
  pendingContextReset: boolean;
  justCompacted: boolean;
  thisAttemptModel: string | null;
}): boolean {
  if (input.iterationSeq <= 0) return true;
  if (input.pendingContextReset) return true;
  if (input.justCompacted) return true;
  const caps = input.lastThreadCaps;
  if (!caps) return true;
  if (!caps.supportsResume || !caps.sameThreadContinuation) return true;
  if (caps.model == null || input.thisAttemptModel == null) return true;
  if (caps.model !== input.thisAttemptModel) return true;
  return false;
}

export function recordLoopThreadCaps(
  state: { lastThreadCaps?: LoopThreadCaps },
  childResult: { contextCompacted?: unknown; threadCaps?: LoopThreadCaps },
): void {
  state.lastThreadCaps = childResult.contextCompacted ? undefined : childResult.threadCaps;
}

export function snapshotLoopThreadCaps(
  adapter: unknown,
  resolvedModel: string | undefined,
): LoopThreadCaps | undefined {
  if (!adapter || typeof adapter !== 'object') return undefined;
  const candidate = adapter as {
    getRuntimeCapabilities?: () => { supportsResume?: boolean };
    getContextCapabilities?: () => { sameThreadContinuation?: boolean };
  };
  if (typeof candidate.getRuntimeCapabilities !== 'function') return undefined;
  if (typeof candidate.getContextCapabilities !== 'function') return undefined;
  return {
    supportsResume: candidate.getRuntimeCapabilities().supportsResume === true,
    sameThreadContinuation: candidate.getContextCapabilities().sameThreadContinuation === true,
    model: resolvedModel ?? null,
  };
}
