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
 *   4. verify skipped + no clean review verdict → pause-operator-review / unverifiable
 *   4b. verify skipped + fresh-eyes review ran clean → stop / accepted (review is authority)
 *   5a. authority + rename gate fails + budget remaining → continue / rename-gate
 *   5b. authority + rename gate fails + budget exhausted → stop-needs-review / rename-gate
 *   6. authority + b&b ok + fresh-eyes blocking → continue / review-blocked
 *   7. authority + b&b ok + fresh-eyes clean    → stop / accepted (tier 2)
 *
 * Anti-case: forensic-only signals with NO independent authority (no verify,
 * no clean review verdict) must NEVER produce 'stop'.
 */

import { describe, expect, it } from 'vitest';
import { isVerifyEvidenceStale, resolveCompletion, type EvidenceInput } from './evidence-resolver';

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
    finalAuditMode: 'observe',
    finalAuditStatus: 'passed',
    finalAuditFindings: [],
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

  it('NEVER returns stop when verify is skipped AND no review verdict — agent cannot self-declare terminal state', () => {
    // This is the critical anti-case: forensic or in-band signals alone
    // (with no verify AND no fresh-eyes review verdict) must NOT produce a
    // 'stop' decision — there is no independent completion authority.
    const forensicSignals = [renameSig, sentinelSig, declaredSig];
    for (const candidate of forensicSignals) {
      const r = resolveCompletion(base({ candidate, verifyStatus: 'skipped', freshEyesRan: false }));
      expect(r.decision).not.toBe('stop');
    }
  });
});

// ============ Verify skipped, fresh-eyes review IS the authority (Option B) ============

describe('resolveCompletion — verify skipped, fresh-eyes review as completion authority', () => {
  it('stops/accepted when verify is skipped but a fresh-eyes review ran clean', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'skipped',
      manualReviewOnly: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
    expect(r.authorityTier).toBe(2);
    expect(r.reason).toContain('fresh-eyes review');
  });

  it('continues/review-blocked when verify is skipped and the review raised a blocking finding', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'skipped',
      manualReviewOnly: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 1,
      freshEyesErrored: false,
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('review-blocked');
  });

  it('pauses for operator when verify is skipped and the reviewer errored (no rubber-stamp)', () => {
    // A reviewer infra failure must NOT be mistaken for a clean pass when there
    // is no verify authority — otherwise the loop would stop with zero evidence.
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'skipped',
      manualReviewOnly: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: true,
    }));
    expect(r.decision).toBe('pause-operator-review');
    expect(r.outcome).toBe('unverifiable');
  });

  it('still honours the rename gate when review is the authority (belt-and-braces required but unmet)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'skipped',
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
      beltAndBracesPassed: false,
      completionAttempts: 1,
      maxCompletionAttempts: 3,
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('rename-gate');
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

  it('pauses for operator review when reviewer errored despite a passing verify', () => {
    // A configured fresh-eyes gate that fails infrastructurally is not a clean
    // review verdict. Passing verify is evidence, but not enough to silently
    // bypass an explicitly enabled review gate.
    const r = resolveCompletion(base({
      candidate: renameSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: true,
    }));
    expect(r.decision).toBe('pause-operator-review');
    expect(r.outcome).toBe('unverifiable');
    expect(r.reason).toContain('fresh-eyes review');
  });

  it('returns stop/accepted when reviewer ran with no blocking findings', () => {
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

// ============ Final audit gate ============

describe('resolveCompletion — final audit gate', () => {
  it('continues/review-blocked when gate mode final audit fails', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      finalAuditMode: 'gate',
      finalAuditStatus: 'failed',
      finalAuditFindings: [{
        severity: 'blocking',
        code: 'ledger-open',
        message: 'LOOP_TASKS.md still has open items.',
      }],
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('review-blocked');
    expect(r.reason).toContain('final audit');
  });

  it('stops needs-review when gate mode final audit needs review', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      finalAuditMode: 'gate',
      finalAuditStatus: 'needs-review',
      finalAuditFindings: [{
        severity: 'review',
        code: 'plan-criteria-unproven',
        message: 'One criterion lacks evidence.',
      }],
    }));
    expect(r.decision).toBe('stop-needs-review');
    expect(r.outcome).toBe('unverifiable');
    expect(r.needsReviewReason).toContain('Final audit');
  });

  it('does not block in observe mode even when final audit fails', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      finalAuditMode: 'observe',
      finalAuditStatus: 'failed',
      finalAuditFindings: [{
        severity: 'blocking',
        code: 'ledger-open',
        message: 'LOOP_TASKS.md still has open items.',
      }],
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('does not block when final audit mode is off and the audit was skipped', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
      finalAuditMode: 'off',
      finalAuditStatus: 'skipped',
      finalAuditFindings: [],
    }));

    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
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
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('review-blocked');
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

// ============ D6 (#7): stale verify evidence (edit-invalidates-proof) ============

describe('resolveCompletion — D6 stale verify evidence (anti-self-grading)', () => {
  it('flag OFF: differing work hashes do not affect the decision (back-compat)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      currentWorkHash: 'hash-b',
      lastVerifiedWorkHash: 'hash-a',
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('flag ON + matching hashes: verify evidence is fresh → stop/accepted', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      antiSelfGrading: true,
      currentWorkHash: 'hash-a',
      lastVerifiedWorkHash: 'hash-a',
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('flag ON + differing hashes: stale proof → continue/verify-failed', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      antiSelfGrading: true,
      currentWorkHash: 'hash-b',
      lastVerifiedWorkHash: 'hash-a',
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.authorityTier).toBe(3);
    expect(r.reason).toContain('stale');
    expect(r.convergenceNote).toContain('stale');
  });

  it('flag ON + no recorded hash: fails open → stop/accepted (unwired callers unaffected)', () => {
    const r = resolveCompletion(base({
      candidate: renameSig,
      antiSelfGrading: true,
      currentWorkHash: 'hash-b',
      lastVerifiedWorkHash: undefined,
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('flag ON: the rung only applies to a PASSED verify, not review-authority stops', () => {
    // verify skipped + clean fresh-eyes review = review is the authority;
    // staleness of a verify that never ran must not block it.
    const r = resolveCompletion(base({
      candidate: renameSig,
      antiSelfGrading: true,
      verifyStatus: 'skipped',
      freshEyesRan: true,
      freshEyesErrored: false,
      currentWorkHash: 'hash-b',
      lastVerifiedWorkHash: 'hash-a',
    }));
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });
});

describe('isVerifyEvidenceStale', () => {
  it.each([
    ['differing hashes are stale', 'a', 'b', true],
    ['matching hashes are fresh', 'a', 'a', false],
    ['missing current hash fails open', undefined, 'a', false],
    ['missing recorded hash fails open', 'a', undefined, false],
    ['null hashes fail open', null, null, false],
    ['empty-string hashes fail open', '', '', false],
  ] as const)('%s', (_name, currentWorkHash, lastVerifiedWorkHash, expected) => {
    expect(isVerifyEvidenceStale({ currentWorkHash, lastVerifiedWorkHash })).toBe(expected);
  });
});

// ============ WS4: durable verification execution ledger ============

describe('resolveCompletion — verification execution ledger', () => {
  function ledgerInput(over: Record<string, unknown> = {}): EvidenceInput {
    return {
      ...base({ candidate: declaredSig, currentWorkHash: 'work-hash' }),
      evidenceLedgerEnabled: true,
      verifyCommand: 'npm run test:quiet',
      verifyWindowStartedAt: 1_000,
      verificationRuns: [],
      ...over,
    } as EvidenceInput;
  }

  it('demotes a passing claim when an available ledger has no execution row', () => {
    const r = resolveCompletion(ledgerInput());

    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.reason).toContain('no matching recorded verification execution');
  });

  it('rejects a narrowed recorded run as completion authority', () => {
    const r = resolveCompletion(ledgerInput({
      verificationRuns: [{
        canonicalCommand: 'npm run test:quiet -- src/auth.spec.ts',
        exitCode: 0,
        workHash: 'work-hash',
        startedAt: 1_100,
      }],
    }));

    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.reason).toContain('no matching recorded verification execution');
  });

  it('accepts a full, current-hash execution recorded in this iteration window', () => {
    const r = resolveCompletion(ledgerInput({
      verificationRuns: [{
        canonicalCommand: 'npm run test:quiet',
        exitCode: 0,
        workHash: 'work-hash',
        startedAt: 1_100,
      }],
    }));

    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });

  it('rejects an otherwise passing execution against a drifted work hash', () => {
    const r = resolveCompletion(ledgerInput({
      verificationRuns: [{
        canonicalCommand: 'npm run test:quiet',
        exitCode: 0,
        workHash: 'previous-work-hash',
        startedAt: 1_100,
      }],
    }));

    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
    expect(r.reason).toContain('no matching recorded verification execution');
  });

  it('rejects a matching run recorded before the current iteration window', () => {
    const r = resolveCompletion(ledgerInput({
      verificationRuns: [{
        canonicalCommand: 'npm run test:quiet',
        exitCode: 0,
        workHash: 'work-hash',
        startedAt: 999,
      }],
    }));

    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
  });

  it('preserves existing behavior when the ledger is unavailable', () => {
    const r = resolveCompletion(base({
      candidate: declaredSig,
      evidenceLedgerEnabled: true,
      verifyCommand: 'npm run test:quiet',
    } as EvidenceInput));

    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
  });
});
