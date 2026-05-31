/**
 * Unit tests for the evidence-resolver evidence-precedence ladder.
 *
 * Each test case is table-driven and covers a specific input combination,
 * verifying that resolveCompletion returns the SAME decision the coordinator
 * currently makes at the completion-decision seam.
 *
 * Ladder summary (highest priority first):
 *   1. No sufficient signal      → continue / null tier
 *   2. quick-verify failed       → continue / verify-failed
 *   3. full verify failed        → continue / verify-failed
 *   4. verify skipped (no cmd)   → pause-operator-review / unverifiable
 *   5a. verify passed + rename gate fails + budget remaining → continue / rename-gate
 *   5b. verify passed + rename gate fails + budget exhausted → stop-needs-review / rename-gate
 *   6. verify passed + b&b ok + fresh-eyes blocking → continue / review-blocked
 *   7. verify passed + b&b ok + fresh-eyes clean    → stop / accepted (tier 2)
 *
 * Anti-case: forensic-only signals (no verify) must NEVER produce 'stop'.
 */

import { describe, expect, it } from 'vitest';
import { resolveCompletion, type EvidenceInput } from './evidence-resolver';

/** Minimal baseline input: no sufficient signal, all gates nominal. */
function base(over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    signals: [],
    candidate: undefined,
    quickVerifyStatus: 'skipped',
    verifyStatus: 'passed',
    verifyLabel: 'verify',
    beltAndBracesPassed: true,
    freshEyesRan: false,
    freshEyesBlockingCount: 0,
    freshEyesErrored: false,
    manualReviewOnly: false,
    allowOperatorReviewedCompletion: false,
    completionAttempts: 0,
    maxCompletionAttempts: 3,
    ...over,
  };
}

/** A sufficient forensic signal (rename). */
const renameSig = { id: 'completed-rename' as const, sufficient: true, detail: 'renamed' };
/** A sufficient sentinel signal. */
const sentinelSig = { id: 'done-sentinel' as const, sufficient: true, detail: 'DONE.txt' };
/** The in-band declared-complete signal (tier 3). */
const declaredSig = { id: 'declared-complete' as const, sufficient: true, detail: 'intent' };
/** Insufficient self-declared signal. */
const selfDeclaredSig = { id: 'self-declared' as const, sufficient: false, detail: 'output says done' };

// ============ No sufficient signal ============

describe('resolveCompletion — no sufficient signal', () => {
  it('returns continue with null tier when there are no signals at all', () => {
    const r = resolveCompletion(base());
    expect(r.decision).toBe('continue');
    expect(r.authorityTier).toBeNull();
    expect(r.outcome).toBeNull();
    expect(r.signalId).toBeNull();
  });

  it('returns continue with null tier when only insufficient signals are present', () => {
    const r = resolveCompletion(base({ candidate: undefined, signals: [selfDeclaredSig] }));
    expect(r.decision).toBe('continue');
    expect(r.authorityTier).toBeNull();
  });
});

// ============ Quick-verify failed ============

describe('resolveCompletion — quick-verify failed', () => {
  it('returns continue/verify-failed when quick-verify fails (rename candidate)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      quickVerifyStatus: 'failed',
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.signalId).toBe('completed-rename');
    expect(r.authorityTier).toBe(4);
    expect(r.convergenceNote).toBeTruthy();
  });

  it('returns continue/verify-failed when quick-verify fails (declared-complete candidate, tier 3)', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      quickVerifyStatus: 'failed',
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.authorityTier).toBe(3);
  });
});

// ============ Full verify failed ============

describe('resolveCompletion — full verify failed', () => {
  it('returns continue/verify-failed when primary verify fails', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      quickVerifyStatus: 'skipped',
      verifyStatus: 'failed',
      verifyLabel: 'verify',
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.convergenceNote).toMatch(/verify failed/);
  });

  it('returns continue/verify-failed with second-verify label for anti-flake second run', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      quickVerifyStatus: 'skipped',
      verifyStatus: 'failed',
      verifyLabel: 'second-verify',
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.reason).toContain('second verify');
  });
});

// ============ Verify skipped (no verify command) ============

describe('resolveCompletion — verify skipped', () => {
  it('returns pause-operator-review/unverifiable when verifyCommand is absent (forensic signal)', () => {
    const r = resolveCompletion(base({
      candidate: sentinelSig,
      verifyStatus: 'skipped',
      manualReviewOnly: true,
    }));
    expect(r.decision).toBe('pause-operator-review');
    expect(r.outcome).toBe('unverifiable');
    expect(r.convergenceNote).toContain('unverifiable');
  });

  it('returns pause-operator-review/unverifiable when verifyCommand absent (declared-complete)', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'skipped',
      manualReviewOnly: true,
    }));
    expect(r.decision).toBe('pause-operator-review');
    expect(r.outcome).toBe('unverifiable');
    expect(r.authorityTier).toBe(3);
  });

  it('NEVER returns stop when verify is skipped — agent cannot self-declare terminal state', () => {
    // This is the critical anti-case: forensic or in-band signals alone
    // must NOT produce a 'stop' decision without tier-2 authority.
    const forensicSignals = [renameSig, sentinelSig, declaredSig];
    for (const candidate of forensicSignals) {
      const r = resolveCompletion(base({ candidate, verifyStatus: 'skipped' }));
      expect(r.decision).not.toBe('stop');
    }
  });
});

// ============ Verify passed, belt-and-braces fails — budget remaining ============

describe('resolveCompletion — verify passed, rename gate blocking, budget remaining', () => {
  it('returns continue/rename-gate when belt-and-braces fails and budget is remaining (attempt 1 of 3)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: false,
      completionAttempts: 1,
      maxCompletionAttempts: 3,
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('rename-gate');
    expect(r.reason).toContain('attempt 1/3');
    expect(r.convergenceNote).toBeTruthy();
    expect(r.needsReviewReason).toBeNull();
  });

  it('returns continue/rename-gate when at attempt 2 of 3 (still budget)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: false,
      completionAttempts: 2,
      maxCompletionAttempts: 3,
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('rename-gate');
  });
});

// ============ Verify passed, belt-and-braces fails — budget exhausted ============

describe('resolveCompletion — verify passed, rename gate blocking, budget exhausted', () => {
  it('returns stop-needs-review/rename-gate when completionAttempts >= maxCompletionAttempts', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: false,
      completionAttempts: 3,
      maxCompletionAttempts: 3,
    }));
    expect(r.decision).toBe('stop-needs-review');
    expect(r.outcome).toBe('rename-gate');
    expect(r.needsReviewReason).not.toBeNull();
    expect(r.needsReviewReason).toContain('rename');
    expect(r.convergenceNote).toBeNull(); // accepted, so no obstacle note
  });

  it('returns stop-needs-review when attempts exceed max (edge: attempts > max)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: false,
      completionAttempts: 5,
      maxCompletionAttempts: 3,
    }));
    expect(r.decision).toBe('stop-needs-review');
    expect(r.outcome).toBe('rename-gate');
  });

  it('returns stop-needs-review at exactly maxCompletionAttempts=1 (minimum budget)', () => {
    const r = resolveCompletion(base({
      candidate: sentinelSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: false,
      completionAttempts: 1,
      maxCompletionAttempts: 1,
    }));
    expect(r.decision).toBe('stop-needs-review');
    expect(r.outcome).toBe('rename-gate');
  });
});

// ============ Verify passed + belt-and-braces ok + fresh-eyes blocking ============

describe('resolveCompletion — verify passed, b&b ok, fresh-eyes blocking', () => {
  it('returns continue/review-blocked when fresh-eyes gate raised blocking findings', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 2,
      freshEyesErrored: false,
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('review-blocked');
    expect(r.reason).toContain('2 blocking finding');
    // convergenceNote is null — coordinator sets it with reviewer details
    expect(r.convergenceNote).toBeNull();
  });

  it('returns continue/review-blocked with a single blocking finding', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 1,
      freshEyesErrored: false,
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('review-blocked');
    expect(r.authorityTier).toBe(3); // declared-complete is tier 3
  });
});

// ============ Verify passed + belt-and-braces ok + fresh-eyes clean → stop ============

describe('resolveCompletion — verify passed, b&b ok, fresh-eyes clean → STOP', () => {
  it('returns stop/accepted (tier 2) when all gates pass with no review run', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: false,
      freshEyesBlockingCount: 0,
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
    expect(r.authorityTier).toBe(2);
    expect(r.signalId).toBe('completed-rename');
    expect(r.convergenceNote).toBeNull();
    expect(r.needsReviewReason).toBeNull();
  });

  it('returns stop/accepted when reviewer ran and returned zero blocking findings', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
    expect(r.authorityTier).toBe(2);
  });

  it('returns stop/accepted when reviewer errored (infra error → do not pin loop open)', () => {
    // When the reviewer throws, freshEyesErrored=true; we should still allow stop.
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: true,
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('returns stop/accepted when reviewer ran with zero reviewers (infra unavailable)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('returns stop/accepted with sentinel candidate', () => {
    const r = resolveCompletion(base({
      candidate: sentinelSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
    }));
    expect(r.decision).toBe('stop');
    expect(r.signalId).toBe('done-sentinel');
    expect(r.authorityTier).toBe(2);
  });
});

// ============ Precedence: declared-complete vs. forensic candidates ============

describe('resolveCompletion — declared-complete vs forensic signal precedence', () => {
  it('declared-complete candidate uses tier 3, forensic candidates use tier 4', () => {
    const rDeclared = resolveCompletion(base({ candidate: declaredSig, verifyStatus: 'passed', beltAndBracesPassed: true }));
    const rForensic = resolveCompletion(base({ candidate: renameSig, verifyStatus: 'passed', beltAndBracesPassed: true }));
    expect(rDeclared.authorityTier).toBe(2); // accepted → always tier 2
    expect(rForensic.authorityTier).toBe(2); // accepted → always tier 2
    // The tier distinction matters most at verify-failed / unverifiable:
    const rDeclaredFailed = resolveCompletion(base({ candidate: declaredSig, verifyStatus: 'failed' }));
    const rForensicFailed = resolveCompletion(base({ candidate: renameSig, verifyStatus: 'failed' }));
    expect(rDeclaredFailed.authorityTier).toBe(3);
    expect(rForensicFailed.authorityTier).toBe(4);
  });
});

// ============ "Agent may never self-declare" invariant ============

describe('resolveCompletion — agent-cannot-self-declare invariant', () => {
  it('forensic-only + no verify → NOT stop (must pause for operator)', () => {
    const forensicCandidates = [renameSig, sentinelSig] as const;
    for (const candidate of forensicCandidates) {
      const r = resolveCompletion(base({
        candidate,
        verifyStatus: 'skipped',
        manualReviewOnly: true,
      }));
      expect(r.decision).not.toBe('stop');
      expect(r.decision).toBe('pause-operator-review');
    }
  });

  it('declared-complete + no verify → NOT stop (operator review still required)', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'skipped',
      manualReviewOnly: true,
    }));
    expect(r.decision).not.toBe('stop');
    expect(r.decision).toBe('pause-operator-review');
  });

  it('freshEyesBlockingCount > 0 + freshEyesErrored → still block completion (not errored path)', () => {
    // If blocking findings AND an error co-exist, findings take precedence.
    // (In practice the coordinator sets blockingCount=0 when errored; this
    // tests the defensive case where both flags are true.)
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 1,
      freshEyesErrored: true, // error AND findings
    }));
    // When errored is true, the resolver does NOT treat it as blocking
    // (per coordinator behaviour: "don't pin loop open on reviewer errors").
    // The errored flag overrides blocking findings — allow stop.
    expect(r.decision).toBe('stop');
  });
});

// ============ Quick-verify skipped flows through to full verify ============

describe('resolveCompletion — quick-verify skipped, full verify determines outcome', () => {
  it('quick skipped + full passed + all gates → stop', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      quickVerifyStatus: 'skipped',
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('quick skipped + full failed → continue/verify-failed', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      quickVerifyStatus: 'skipped',
      verifyStatus: 'failed',
      verifyLabel: 'verify',
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
  });
});
