/**
 * T2 — capability-gated loop goal skip.
 *
 * Skip the goal / prior-observations blocks only when the live thread is
 * proven same-thread (resume + continuation), the model matches, and the
 * window was not just recycled. Anything uncertain re-anchors (keeps the goal).
 */

export const LOOP_FULL_REANCHOR_EVERY = 10;

export interface LoopThreadCaps {
  providerCompacted?: boolean;
  supportsResume: boolean;
  sameThreadContinuation: boolean;
  /** Model that actually ran. Null means unknown — fail closed. */
  model: string | null;
}

export function shouldReanchorLoopGoal(input: {
  iterationSeq: number;
  lastFullAnchorSeq?: number;
  lastThreadCaps?: LoopThreadCaps | null;
  pendingContextReset: boolean;
  justCompacted: boolean;
  thisAttemptModel: string | null;
}): boolean {
  if (input.iterationSeq <= 0) return true;
  const anchor = input.lastFullAnchorSeq;
  if (anchor === undefined || !Number.isInteger(anchor) || anchor < 0 || anchor > input.iterationSeq
    || input.iterationSeq - anchor >= LOOP_FULL_REANCHOR_EVERY) return true;
  if (input.pendingContextReset) return true;
  if (input.justCompacted) return true;
  const caps = input.lastThreadCaps;
  if (!caps || caps.providerCompacted) return true;
  if (!caps.supportsResume || !caps.sameThreadContinuation) return true;
  if (caps.model == null || input.thisAttemptModel == null) return true;
  if (caps.model !== input.thisAttemptModel) return true;
  return false;
}

export function recordLoopThreadCaps(
  state: { lastThreadCaps?: LoopThreadCaps },
  childResult: { contextCompacted?: unknown; threadCaps?: LoopThreadCaps },
): void {
  state.lastThreadCaps = childResult.contextCompacted || childResult.threadCaps?.providerCompacted
    ? undefined : childResult.threadCaps;
}

export function snapshotLoopThreadCaps(
  adapter: unknown,
  resolvedModel: string | undefined,
): LoopThreadCaps | undefined {
  if (!adapter || typeof adapter !== 'object') return undefined;
  const candidate = adapter as {
    getRuntimeCapabilities?: () => { supportsResume?: boolean };
    getContextCapabilities?: () => { sameThreadContinuation?: boolean };
    getResumeAttemptResult?: () => { source: string; confirmed: boolean; forked?: boolean; requestedSessionId?: string; actualSessionId?: string } | null;
    willResumeSession?: () => boolean;
    getTurnCompaction?: () => { count: number };
  };
  if (typeof candidate.getRuntimeCapabilities !== 'function') return undefined;
  if (typeof candidate.getContextCapabilities !== 'function') return undefined;
  const resume = candidate.getResumeAttemptResult?.();
  const willResume = candidate.willResumeSession?.() === true;
  const confirmedNative = willResume && resume?.source === 'native' && resume.confirmed && !resume.forked
    && Boolean(resume.requestedSessionId) && resume.actualSessionId === resume.requestedSessionId;
  const firstRoundWillResume = resume?.source === 'fresh-fallback' && willResume;
  return {
    ...(candidate.getTurnCompaction?.().count ? { providerCompacted: true } : {}),
    supportsResume: candidate.getRuntimeCapabilities().supportsResume === true,
    sameThreadContinuation: candidate.getContextCapabilities().sameThreadContinuation === true || confirmedNative || firstRoundWillResume,
    model: resolvedModel ?? null,
  };
}
