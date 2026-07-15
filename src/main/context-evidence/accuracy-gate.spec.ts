import { describe, expect, it, vi } from 'vitest';
import type { EvidenceCitation } from '@contracts/types/context-evidence';
import {
  AccuracyGate,
  type AccuracyEvidenceVerification,
  type AccuracyEvidenceVerifier,
} from './accuracy-gate';
import {
  ConservativeEvidenceAccessPolicy,
  type EvidenceAccessPolicy,
} from './evidence-access-policy';

const citation: EvidenceCitation = {
  evidenceId: 'evidence-1', startByte: 0, endByte: 7, contentDigest: 'a'.repeat(64),
};
const marker = `[evidence:${citation.evidenceId}@${citation.startByte}-${citation.endByte}#${citation.contentDigest}]`;

describe('AccuracyGate', () => {
  it('keeps casual conversation responsive without citations', async () => {
    const gate = harness().gate;
    await expect(gate.evaluate(input({
      assistantText: 'Hello.',
      researchRequested: false,
    }))).resolves.toEqual({
      mode: 'casual', verdict: 'pass', checkedCitationCount: 0, issues: [], disclosures: [],
    });
  });

  it.each([
    ['wrong-conversation', 'wrong-conversation'],
    ['invalid-citation', 'invalid-citation'],
    ['stale-evidence', 'stale-evidence'],
    ['corrupt-evidence', 'corrupt-evidence'],
    ['missing-evidence', 'missing-evidence'],
  ] as const)('maps verifier failure %s to issue %s', async (status, issue) => {
    const { gate, verifier } = harness();
    vi.mocked(verifier.verify).mockResolvedValue({ status });

    const result = await gate.evaluate(input({ assistantText: `Research claim ${marker}` }));

    expect(result.issues).toContainEqual({ code: issue, evidenceId: 'evidence-1' });
    expect(result.verdict).toBe('block');
  });

  it('blocks malformed citation markers without calling storage', async () => {
    const { gate, verifier } = harness();
    const result = await gate.evaluate(input({
      assistantText: 'Research claim [evidence:evidence-1@7-0#bad]',
    }));
    expect(result.issues).toContainEqual({ code: 'invalid-citation' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('requires current execution receipts for completion claims', async () => {
    const { gate } = harness();
    const result = await gate.evaluate(input({
      assistantText: `The build passed. ${marker}`,
      completionClaim: true,
      executionReceiptCurrent: false,
    }));
    expect(result.mode).toBe('completion-claim');
    expect(result.verdict).toBe('block');
    expect(result.issues).toContainEqual({ code: 'missing-execution-receipt' });
  });

  it('blocks unresolved contradictions unless the response presents them', async () => {
    const { gate } = harness();
    const result = await gate.evaluate(input({
      assistantText: `Verified claim. ${marker}`,
      unresolvedContradictionCount: 1,
      contradictionsPresented: false,
    }));
    expect(result.issues).toContainEqual({ code: 'unresolved-contradiction' });
  });

  it('requires an explicit limitation disclosure for bounded evidence', async () => {
    const { gate, verifier } = harness();
    vi.mocked(verifier.verify).mockResolvedValue(valid({ captureCompleteness: 'bounded' }));
    const missing = await gate.evaluate(input({ assistantText: `Claim ${marker}` }));
    const disclosed = await gate.evaluate(input({
      assistantText: `Claim ${marker}`,
      disclosedIncompleteEvidenceIds: ['evidence-1'],
    }));
    expect(missing.issues).toContainEqual({
      code: 'incomplete-capture-undisclosed', evidenceId: 'evidence-1',
    });
    expect(disclosed.issues).not.toContainEqual(expect.objectContaining({
      code: 'incomplete-capture-undisclosed',
    }));
  });

  it('rejects model-assisted-only and legacy-unverified sole support for important claims', async () => {
    const { gate, verifier } = harness();
    vi.mocked(verifier.verify).mockResolvedValue(valid({
      provenanceTrust: 'legacy-unverified', rawSpanAvailable: false, modelAssistedOnly: true,
    }));
    const result = await gate.evaluate(input({ assistantText: `Audit claim ${marker}` }));
    expect(result.issues).toEqual(expect.arrayContaining([
      { code: 'model-assisted-only', evidenceId: 'evidence-1' },
      { code: 'legacy-unverified-only', evidenceId: 'evidence-1' },
    ]));
    expect(result.disclosures).toContain('Evidence evidence-1 has legacy-unverified provenance.');
  });

  it('passes a high-stakes claim only with valid authenticated raw evidence', async () => {
    const { gate } = harness();
    const result = await gate.evaluate(input({
      assistantText: `Security finding ${marker}`,
      highStakes: true,
    }));
    expect(result).toMatchObject({ mode: 'high-stakes', verdict: 'pass', checkedCitationCount: 1 });
  });

  it('authorizes every verified citation through the injected shared evidence policy', async () => {
    const { gate, policy } = harness();

    await gate.evaluate(input({ assistantText: `Research claim ${marker}` }));

    expect(policy.authorize).toHaveBeenCalledWith(expect.objectContaining({
      requester: expect.objectContaining({ path: 'accuracy-gate' }),
      sensitivity: 'normal',
      sourceKind: 'command',
      observedAt: 100,
      now: 200,
    }));
  });
});

function harness(): {
  gate: AccuracyGate;
  verifier: AccuracyEvidenceVerifier;
  policy: EvidenceAccessPolicy;
} {
  const verifier: AccuracyEvidenceVerifier = { verify: vi.fn(async () => valid()) };
  const implementation = new ConservativeEvidenceAccessPolicy();
  const policy: EvidenceAccessPolicy = {
    authorize: vi.fn((policyInput) => implementation.authorize(policyInput)),
  };
  return { gate: new AccuracyGate(verifier, policy, () => 200), verifier, policy };
}

function input(overrides: Partial<Parameters<AccuracyGate['evaluate']>[0]> = {}) {
  return {
    conversationId: 'conversation-1',
    assistantText: `Research claim ${marker}`,
    researchRequested: true,
    externalFactsUsed: false,
    completionClaim: false,
    highStakes: false,
    executionReceiptCurrent: false,
    unresolvedContradictionCount: 0,
    contradictionsPresented: false,
    disclosedIncompleteEvidenceIds: [],
    ...overrides,
  };
}

function valid(overrides: Partial<Extract<AccuracyEvidenceVerification, { status: 'valid' }>> = {}) {
  return {
    status: 'valid' as const,
    provenanceTrust: 'runtime-authenticated' as const,
    captureCompleteness: 'complete' as const,
    rawSpanAvailable: true,
    modelAssistedOnly: false,
    sensitivity: 'normal' as const,
    sourceKind: 'command' as const,
    observedAt: 100,
    ...overrides,
  };
}
