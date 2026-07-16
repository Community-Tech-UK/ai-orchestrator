import { describe, expect, it } from 'vitest';
import {
  AccuracyGateResultSchema,
  ContextEvidenceRendererMetricsSchema,
  ContextEvidenceCompareRequestSchema,
  ContextEvidenceGetCardRequestSchema,
  ContextEvidenceGetMetricsRequestSchema,
  ContextEvidenceListRequestSchema,
  ContextEvidenceReadRequestSchema,
  ContextEvidenceSearchRequestSchema,
  ContextEvidenceStateChangedSchema,
  ContextEvidenceVerifyRequestSchema,
  ContextPressureSampleSchema,
  EnforcementActionSchema,
  EvidenceCaptureRequestSchema,
  EvidenceCaptureResultSchema,
  EvidenceCardSchema,
  EvidenceCitationSchema,
  EvidenceRecordSchema,
  EvidenceRetrievalRequestSchema,
  EvidenceRetrievalResponseSchema,
  ProviderContextCapabilitiesSchema,
  WorkingSetAllocationSchema,
} from '../context-evidence.schemas';

const digest = 'a'.repeat(64);
const citation = {
  evidenceId: 'evidence-1',
  startByte: 0,
  endByte: 12,
  contentDigest: digest,
};

const record = {
  id: 'evidence-1',
  conversationId: 'conversation-1',
  provider: 'codex',
  providerThreadRef: 'thread-1',
  turnRef: 'turn-1',
  toolCallRef: 'call-1',
  toolName: 'exec_command',
  sourceKind: 'command',
  sourceLocatorRedacted: 'workspace-relative/path.ts',
  status: 'complete',
  keyedContentId: digest,
  byteCount: 12,
  tokenEstimate: 3,
  mimeType: 'text/plain',
  sensitivity: 'normal',
  provenanceTrust: 'runtime-authenticated',
  createdAt: 1_900_000_000_000,
  completedAt: 1_900_000_000_001,
  keyVersion: 1,
  captureMode: 'post-retention',
  captureCompleteness: 'complete',
};

describe('context evidence schemas', () => {
  it('parses the exact EvidenceRecord literals, including provenance trust', () => {
    expect(EvidenceRecordSchema.parse(record)).toEqual(record);

    expect(EvidenceRecordSchema.parse({
      ...record,
      provenanceTrust: 'legacy-unverified',
      captureMode: 'observed-only',
      captureCompleteness: 'metadata-only',
      truncationReason: 'Provider exposed metadata only.',
    })).toMatchObject({
      provenanceTrust: 'legacy-unverified',
      captureMode: 'observed-only',
      captureCompleteness: 'metadata-only',
    });
  });

  it.each(['bounded', 'metadata-only'] as const)(
    'requires a disclosure when capture completeness is %s',
    (captureCompleteness) => {
      expect(EvidenceRecordSchema.safeParse({
        ...record,
        captureCompleteness,
      }).success).toBe(false);

      expect(EvidenceRecordSchema.safeParse({
        ...record,
        captureCompleteness,
        truncationReason: 'The provider exposed only part of the result.',
      }).success).toBe(true);
    },
  );

  it('requires finalization identity and monotonic timestamps for complete evidence', () => {
    for (const field of ['keyedContentId', 'completedAt', 'keyVersion'] as const) {
      const incompleteRecord = { ...record };
      delete incompleteRecord[field];
      expect(EvidenceRecordSchema.safeParse(incompleteRecord).success).toBe(false);
    }

    expect(EvidenceRecordSchema.safeParse({
      ...record,
      completedAt: record.createdAt - 1,
    }).success).toBe(false);
  });

  it('accepts only 64-character lowercase hexadecimal keyed digests', () => {
    expect(EvidenceRecordSchema.safeParse({ ...record, keyedContentId: digest }).success).toBe(true);
    expect(EvidenceRecordSchema.safeParse({ ...record, keyedContentId: 'A'.repeat(64) }).success).toBe(false);
    expect(EvidenceRecordSchema.safeParse({ ...record, keyedContentId: 'a'.repeat(63) }).success).toBe(false);
    expect(EvidenceCitationSchema.safeParse({ ...citation, contentDigest: 'g'.repeat(64) }).success).toBe(false);
  });

  it('enforces non-negative, increasing UTF-8 byte ranges', () => {
    expect(EvidenceCitationSchema.safeParse(citation).success).toBe(true);
    expect(EvidenceCitationSchema.safeParse({ ...citation, startByte: -1 }).success).toBe(false);
    expect(EvidenceCitationSchema.safeParse({ ...citation, endByte: 0 }).success).toBe(false);
    expect(EvidenceCitationSchema.safeParse({ ...citation, startByte: 2, endByte: 2 }).success).toBe(false);
  });

  it('parses a card whose findings and contradiction citations are included by the card', () => {
    const card = {
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: 'The command succeeded after changing one file.',
      findings: [{
        id: 'finding-1',
        kind: 'verification',
        statement: 'The command succeeded.',
        importance: 'info',
        citations: [citation],
      }],
      citations: [citation],
      freshness: { observedAt: 1_900_000_000_000 },
      contradictions: [{
        id: 'contradiction-1',
        statement: 'Two observations disagree.',
        leftCitations: [citation],
        rightCitations: [citation],
        status: 'resolved',
        resolution: {
          statement: 'The later observation supersedes the earlier one.',
          citations: [citation],
        },
      }],
      derivedBy: { kind: 'deterministic', version: 'command-v1' },
      createdAt: 1_900_000_000_002,
    };

    expect(EvidenceCardSchema.parse(card)).toEqual(card);
  });

  it('rejects card findings, contradiction sides, or resolutions with citations omitted by the card', () => {
    const omittedCitation = { ...citation, startByte: 12, endByte: 16 };
    const baseCard = {
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: 'Summary',
      findings: [],
      citations: [citation],
      contradictions: [],
      derivedBy: { kind: 'deterministic', version: 'v1' },
      createdAt: 1,
    };

    expect(EvidenceCardSchema.safeParse({
      ...baseCard,
      findings: [{
        id: 'finding-1',
        kind: 'fact',
        statement: 'Unsupported fact',
        importance: 'critical',
        citations: [omittedCitation],
      }],
    }).success).toBe(false);

    expect(EvidenceCardSchema.safeParse({
      ...baseCard,
      contradictions: [{
        id: 'contradiction-1',
        statement: 'Unsupported side',
        leftCitations: [citation],
        rightCitations: [omittedCitation],
        status: 'unresolved',
      }],
    }).success).toBe(false);

    expect(EvidenceCardSchema.safeParse({
      ...baseCard,
      contradictions: [{
        id: 'contradiction-1',
        statement: 'Unsupported resolution',
        leftCitations: [citation],
        rightCitations: [citation],
        status: 'resolved',
        resolution: { statement: 'Resolved', citations: [omittedCitation] },
      }],
    }).success).toBe(false);
  });

  it('requires resolved contradictions to have a cited resolution and forbids one while unresolved', () => {
    const baseContradiction = {
      id: 'contradiction-1',
      statement: 'Two observations disagree.',
      leftCitations: [citation],
      rightCitations: [citation],
    };
    const baseCard = {
      id: 'card-1',
      evidenceId: 'evidence-1',
      version: 1,
      status: 'validated',
      summary: 'Summary',
      findings: [],
      citations: [citation],
      derivedBy: { kind: 'deterministic', version: 'v1' },
      createdAt: 1,
    };

    expect(EvidenceCardSchema.safeParse({
      ...baseCard,
      contradictions: [{ ...baseContradiction, status: 'resolved' }],
    }).success).toBe(false);
    expect(EvidenceCardSchema.safeParse({
      ...baseCard,
      contradictions: [{
        ...baseContradiction,
        status: 'unresolved',
        resolution: { statement: 'Premature resolution', citations: [citation] },
      }],
    }).success).toBe(false);
  });

  it('parses known and unknown context-pressure samples without conflating occupancy and cumulative use', () => {
    const counters = {
      outputBytesSinceCompaction: 9_000,
      providerRequestCount: 4,
      newEvidenceCount: 2,
      newValidatedFindingCount: 1,
      recoveryEpoch: 0,
    };

    expect(ContextPressureSampleSchema.parse({
      occupancy: { status: 'known', used: 80, total: 100 },
      cumulativeTokens: 400,
      ...counters,
    }).occupancy).toEqual({ status: 'known', used: 80, total: 100 });

    expect(ContextPressureSampleSchema.parse({
      occupancy: { status: 'unknown', reason: 'Provider reports aggregate usage only.' },
      cumulativeTokens: 400,
      ...counters,
    }).occupancy.status).toBe('unknown');

    expect(ContextPressureSampleSchema.safeParse({
      occupancy: { status: 'known', used: 101, total: 100 },
      ...counters,
    }).success).toBe(false);
  });

  it('parses only the exact granular provider-capability literals', () => {
    const capabilities = {
      toolResultControl: 'post-retention',
      toolResultVisibility: 'full',
      transcriptControl: 'native-compaction',
      occupancyReporting: 'current',
      cumulativeReporting: 'available',
      interruptProof: 'observed',
      compactionProof: 'acknowledged-only',
      sameThreadContinuation: true,
    };

    expect(ProviderContextCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(ProviderContextCapabilitiesSchema.safeParse({
      ...capabilities,
      occupancyReporting: 'estimated',
    }).success).toBe(false);
  });

  it('parses capture requests and discriminated capture results without storing content in records', () => {
    const request = {
      captureKey: 'conversation-1:turn-1:call-1',
      conversationId: 'conversation-1',
      provider: 'codex',
      turnRef: 'turn-1',
      toolCallRef: 'call-1',
      toolName: 'exec_command',
      sourceKind: 'command',
      mimeType: 'text/plain',
      sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention',
      captureCompleteness: 'complete',
      content: new Uint8Array([111, 107]),
    };

    expect(EvidenceCaptureRequestSchema.parse(request)).toEqual(request);
    expect(EvidenceCaptureRequestSchema.safeParse({
      ...request,
      captureCompleteness: 'bounded',
    }).success).toBe(false);
    expect(EvidenceCaptureRequestSchema.safeParse({
      ...request,
      captureCompleteness: 'bounded',
      truncationReason: 'Only a bounded result was visible to AIO.',
    }).success).toBe(true);
    expect(EvidenceCaptureResultSchema.parse({ status: 'captured', record })).toEqual({
      status: 'captured',
      record,
    });
    expect(EvidenceCaptureResultSchema.parse({ status: 'duplicate', record })).toMatchObject({
      status: 'duplicate',
    });
    expect(EvidenceCaptureResultSchema.parse({
      status: 'failed',
      errorCode: 'durable-storage-unavailable',
      disclosure: 'Durable capture failed; the provider result remains in memory.',
    })).toMatchObject({ status: 'failed' });
    expect(EvidenceCaptureResultSchema.parse({
      status: 'conflict',
      errorCode: 'capture-key-content-mismatch',
      disclosure: 'The logical capture key was reused with different content.',
    })).toMatchObject({ status: 'conflict' });
  });

  it('enforces bounded retrieval byte ranges and positive token limits up to 4,096', () => {
    const request = {
      conversationId: 'conversation-1',
      evidenceId: 'evidence-1',
      startByte: 0,
      endByte: 12,
      tokenLimit: 512,
    };

    expect(EvidenceRetrievalRequestSchema.parse(request)).toEqual(request);
    expect(EvidenceRetrievalRequestSchema.safeParse({ ...request, tokenLimit: 0 }).success).toBe(false);
    expect(EvidenceRetrievalRequestSchema.safeParse({ ...request, tokenLimit: 4_097 }).success).toBe(false);
    expect(EvidenceRetrievalRequestSchema.safeParse({ ...request, endByte: 0 }).success).toBe(false);

    expect(EvidenceRetrievalResponseSchema.parse({
      evidenceId: 'evidence-1',
      startByte: 0,
      endByte: 12,
      content: 'hello world!',
      tokenCount: 3,
      tokenLimit: 512,
      truncated: false,
      citation,
      captureCompleteness: 'complete',
    })).toMatchObject({ truncated: false });

    expect(EvidenceRetrievalResponseSchema.safeParse({
      evidenceId: 'evidence-1',
      startByte: 0,
      endByte: 12,
      content: 'partial',
      tokenCount: 2,
      tokenLimit: 512,
      truncated: true,
      citation,
      captureCompleteness: 'bounded',
    }).success).toBe(false);
  });

  it('requires a strict main-process-owned conversation scope on every IPC request', () => {
    const chatScope = {
      conversationId: 'conversation-1',
      owner: { kind: 'chat' as const, chatId: 'chat-1' },
    };
    const instanceScope = {
      conversationId: 'conversation-1',
      owner: { kind: 'instance' as const, instanceId: 'instance-1' },
    };

    expect(ContextEvidenceListRequestSchema.parse({ ...chatScope, limit: 25 })).toEqual({
      ...chatScope,
      limit: 25,
    });
    expect(ContextEvidenceGetCardRequestSchema.parse({
      ...chatScope, cardId: 'card-1', tokenLimit: 512,
    }).cardId).toBe('card-1');
    expect(ContextEvidenceSearchRequestSchema.parse({
      ...instanceScope, query: 'needle', tokenLimit: 512,
    }).query).toBe('needle');
    expect(ContextEvidenceReadRequestSchema.parse({
      ...instanceScope, evidenceId: 'evidence-1', startByte: 0, endByte: 12,
      tokenLimit: 512,
    }).endByte).toBe(12);
    expect(ContextEvidenceCompareRequestSchema.parse({
      ...chatScope,
      left: { evidenceId: 'left', startByte: 0, endByte: 4 },
      right: { evidenceId: 'right', startByte: 4, endByte: 8 },
    }).left.evidenceId).toBe('left');
    expect(ContextEvidenceVerifyRequestSchema.parse({
      ...chatScope, evidenceId: 'evidence-1', startByte: 0, endByte: 12,
      contentDigest: digest,
    }).contentDigest).toBe(digest);
    expect(ContextEvidenceGetMetricsRequestSchema.parse(chatScope)).toEqual(chatScope);

    expect(ContextEvidenceListRequestSchema.safeParse({ limit: 25 }).success).toBe(false);
    expect(ContextEvidenceListRequestSchema.safeParse({
      ...chatScope,
      provider: 'renderer-controlled',
    }).success).toBe(false);
    expect(ContextEvidenceListRequestSchema.safeParse({
      conversationId: 'conversation-1',
      owner: { kind: 'provider', providerThreadId: 'not-authority' },
    }).success).toBe(false);
    expect(ContextEvidenceGetCardRequestSchema.safeParse({
      ...chatScope, cardId: 'card-1', tokenLimit: 4_097,
    }).success).toBe(false);
    expect(ContextEvidenceReadRequestSchema.safeParse({
      ...chatScope, evidenceId: 'evidence-1', startByte: 12, endByte: 12,
      tokenLimit: 512,
    }).success).toBe(false);
  });

  it('keeps pushed renderer metrics scoped and structurally separated', () => {
    const allocation = {
      capacityTokens: 100_000,
      instructionsTokens: 15_000,
      recentDialogueTokens: 15_000,
      evidenceCardTokens: 15_000,
      exactExcerptTokens: 15_000,
      reasoningAndAnswerTokens: 25_000,
      emergencyReserveTokens: 15_000,
      normalWorkingSetTokens: 60_000,
      totalAllocatedTokens: 100_000,
      estimateKind: 'provider-tokenizer' as const,
    };
    const event = {
      conversationId: 'conversation-1',
      metrics: {
        occupancy: { status: 'known' as const, used: 60_000, total: 100_000 },
        cumulativeTokens: 400_000,
        workingSet: allocation,
        evidenceRecordCount: 8,
        evidenceCardCount: 6,
        exactExcerptCount: 2,
        externallyStoredBytes: 9_000,
        modelRequestCount: 4,
        toolCallCount: 3,
        toolResultBytes: 8_000,
        enforcementMode: 'shadow' as const,
        lastAction: 'same-thread-continuation' as const,
        recoveryCount: 1,
        updatedAt: 1_900_000_000_000,
      },
    };

    expect(ContextEvidenceStateChangedSchema.parse(event)).toEqual(event);
    expect(ContextEvidenceStateChangedSchema.safeParse({
      ...event,
      providerId: 'not-part-of-the-event-contract',
    }).success).toBe(false);
  });

  it('parses accuracy-gate results, working-set allocations, enforcement actions, and renderer metrics', () => {
    expect(AccuracyGateResultSchema.parse({
      mode: 'completion-claim',
      verdict: 'block',
      checkedCitationCount: 1,
      issues: [{ code: 'missing-execution-receipt', evidenceId: 'evidence-1' }],
      disclosures: ['A current execution receipt is required.'],
    }).verdict).toBe('block');

    const allocation = {
      capacityTokens: 100_000,
      instructionsTokens: 15_000,
      recentDialogueTokens: 15_000,
      evidenceCardTokens: 15_000,
      exactExcerptTokens: 15_000,
      reasoningAndAnswerTokens: 25_000,
      emergencyReserveTokens: 15_000,
      normalWorkingSetTokens: 60_000,
      totalAllocatedTokens: 100_000,
      estimateKind: 'provider-tokenizer',
    };
    expect(WorkingSetAllocationSchema.parse(allocation)).toEqual(allocation);
    expect(WorkingSetAllocationSchema.safeParse({
      ...allocation,
      totalAllocatedTokens: 100_001,
    }).success).toBe(false);
    expect(WorkingSetAllocationSchema.safeParse({
      ...allocation,
      instructionsTokens: 16_000,
      reasoningAndAnswerTokens: 24_000,
      normalWorkingSetTokens: 61_000,
    }).success).toBe(false);

    expect(EnforcementActionSchema.parse({
      kind: 'native-compaction',
      trigger: 'known-occupancy-75',
      recoveryEpoch: 2,
      proofRequired: 'observed',
      createdAt: 1_900_000_000_000,
    }).kind).toBe('native-compaction');

    expect(ContextEvidenceRendererMetricsSchema.parse({
      occupancy: { status: 'unknown', reason: 'No current occupancy telemetry.' },
      cumulativeTokens: 400,
      workingSet: allocation,
      evidenceRecordCount: 8,
      evidenceCardCount: 6,
      exactExcerptCount: 2,
      externallyStoredBytes: 9_000,
      modelRequestCount: 4,
      toolCallCount: 3,
      toolResultBytes: 8_000,
      enforcementMode: 'shadow',
      lastAction: 'same-thread-continuation',
      recoveryCount: 1,
      updatedAt: 1_900_000_000_000,
    }).enforcementMode).toBe('shadow');
  });
});
