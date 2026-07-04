import { describe, expect, it } from 'vitest';
import {
  VerificationVerdictReadyPayloadSchema,
  VerificationVerdictSchema,
} from '../verification.schemas';

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('verification verdict schemas', () => {
  const verdict = {
    status: 'needs-changes',
    confidence: 0.72,
    headline: 'Changes are recommended',
    requiredActions: ['Resolve disagreement: security concern.'],
    riskAreas: [{
      category: 'security',
      description: 'Potential token exposure',
      severity: 'high',
      agentIds: ['agent-1'],
    }],
    evidence: [{
      kind: 'disagreement',
      snippet: 'security concern',
    }],
    rawResponses: [{
      agentId: 'agent-1',
      agentIndex: 0,
      model: 'claude',
      response: 'raw response',
      keyPoints: [],
      confidence: 0.8,
      duration: 1000,
      tokens: 50,
      cost: 0.01,
    }],
    sourceResultId: 'result-1',
    derivedAt: 1_900_000_000_000,
    schemaVersion: 1,
  };

  it('parses a verification verdict', () => {
    expect(VerificationVerdictSchema.parse(verdict)).toEqual(verdict);
  });

  it('accepts raw response model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const parsed = VerificationVerdictSchema.parse({
      ...verdict,
      rawResponses: [{ ...verdict.rawResponses[0], model: maxCatalogModelId }],
    });

    expect(parsed.rawResponses[0].model).toBe(maxCatalogModelId);
  });

  it('rejects raw response model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(VerificationVerdictSchema.safeParse({
      ...verdict,
      rawResponses: [{ ...verdict.rawResponses[0], model: tooLongCatalogModelId }],
    }).success).toBe(false);
  });

  it('parses a verdict-ready payload', () => {
    const payload = {
      resultId: 'result-1',
      instanceId: 'inst-1',
      verdict,
      diagnostic: { reason: 'normal' },
    };
    expect(VerificationVerdictReadyPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects unsupported verdict statuses', () => {
    expect(() => VerificationVerdictSchema.parse({
      ...verdict,
      status: 'maybe',
    })).toThrow();
  });
});
