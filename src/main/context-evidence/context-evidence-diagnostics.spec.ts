import { describe, expect, it } from 'vitest';
import { ContextEvidenceDiagnostics } from './context-evidence-diagnostics';

describe('ContextEvidenceDiagnostics', () => {
  it('keeps occupancy, cumulative input, evidence storage, and tool metrics distinct', () => {
    const diagnostics = new ContextEvidenceDiagnostics();
    diagnostics.record({
      conversationId: 'conversation-1', provider: 'codex', evidenceId: 'evidence-1',
      classification: 'pressure', occupancyUsed: 600, occupancyTotal: 1_000,
      cumulativeTokens: 4_000, storedEvidenceBytes: 900_532,
      modelRequestCount: 44, toolCallCount: 44, toolResultBytes: 900_532,
      thresholdCode: 'known-occupancy-60', actionCode: 'rebuild-working-set',
      proofStage: 'observed', durationMs: 12, failureCode: null, createdAt: 1,
    });

    expect(diagnostics.snapshot()).toEqual([
      expect.objectContaining({
        occupancyUsed: 600, occupancyTotal: 1_000, cumulativeTokens: 4_000,
        storedEvidenceBytes: 900_532, modelRequestCount: 44, toolCallCount: 44,
        toolResultBytes: 900_532,
      }),
    ]);
  });

  it('privacy-safe export removes provider and all conversation/evidence identifiers', () => {
    const diagnostics = new ContextEvidenceDiagnostics();
    diagnostics.record({
      conversationId: 'conversation-private', provider: 'provider-private',
      evidenceId: 'evidence-private', classification: 'integrity',
      failureCode: 'BLOB_AUTH_FAILED', createdAt: 1,
    });

    const exported = JSON.stringify(diagnostics.export({ privacySafe: true }));

    expect(exported).not.toContain('conversation-private');
    expect(exported).not.toContain('provider-private');
    expect(exported).not.toContain('evidence-private');
    expect(exported).toContain('BLOB_AUTH_FAILED');
  });

  it('rejects diagnostic fields that could carry evidence bodies or locators', () => {
    const diagnostics = new ContextEvidenceDiagnostics();
    expect(() => diagnostics.record({
      conversationId: 'conversation-1', classification: 'capture', createdAt: 1,
      content: 'not allowed',
    } as never)).toThrow('CONTEXT_EVIDENCE_DIAGNOSTIC_FIELD_NOT_ALLOWED');
  });

  it('rejects invalid counts, occupancy, timestamps, and free-form diagnostic codes', () => {
    const diagnostics = new ContextEvidenceDiagnostics();
    const base = { conversationId: 'conversation-1', classification: 'pressure' as const, createdAt: 1 };

    expect(() => diagnostics.record({ ...base, toolCallCount: -1 }))
      .toThrow('CONTEXT_EVIDENCE_DIAGNOSTIC_VALUE_INVALID');
    expect(() => diagnostics.record({ ...base, durationMs: 1.5 }))
      .toThrow('CONTEXT_EVIDENCE_DIAGNOSTIC_VALUE_INVALID');
    expect(() => diagnostics.record({ ...base, occupancyUsed: 101, occupancyTotal: 100 }))
      .toThrow('CONTEXT_EVIDENCE_DIAGNOSTIC_VALUE_INVALID');
    expect(() => diagnostics.record({ ...base, createdAt: -1 }))
      .toThrow('CONTEXT_EVIDENCE_DIAGNOSTIC_VALUE_INVALID');
    expect(() => diagnostics.record({ ...base, failureCode: 'raw failure: free form detail' }))
      .toThrow('CONTEXT_EVIDENCE_DIAGNOSTIC_VALUE_INVALID');
  });

  it('retains only a bounded recent diagnostic window', () => {
    const diagnostics = new ContextEvidenceDiagnostics(2);
    diagnostics.record({ conversationId: 'c', classification: 'capture', createdAt: 1 });
    diagnostics.record({ conversationId: 'c', classification: 'capture', createdAt: 2 });
    diagnostics.record({ conversationId: 'c', classification: 'capture', createdAt: 3 });
    expect(diagnostics.snapshot().map((event) => event.createdAt)).toEqual([2, 3]);
  });
});
