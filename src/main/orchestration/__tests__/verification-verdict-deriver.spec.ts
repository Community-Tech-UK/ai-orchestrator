import { describe, expect, it } from 'vitest';
import {
  deriveVerdict,
  headlineForStatus,
} from '../verification-verdict-deriver';
import type {
  AgentResponse,
  VerificationAnalysis,
  VerificationResult,
} from '../../../shared/types/verification.types';

const NOW = 1_900_000_000_000;

function response(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    agentId: 'agent-1',
    agentIndex: 0,
    model: 'claude-3-opus',
    response: 'response text',
    keyPoints: [],
    confidence: 0.8,
    duration: 1000,
    tokens: 100,
    cost: 0.01,
    ...overrides,
  };
}

function analysis(overrides: Partial<VerificationAnalysis> = {}): VerificationAnalysis {
  return {
    agreements: [],
    disagreements: [],
    uniqueInsights: [],
    responseRankings: [],
    overallConfidence: 0.8,
    outlierAgents: [],
    consensusStrength: 0.8,
    ...overrides,
  };
}

function result(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    id: 'result-1',
    request: {
      id: 'req-1',
      instanceId: 'inst-1',
      prompt: 'test',
      config: { agentCount: 3, timeout: 30_000, synthesisStrategy: 'merge' },
    },
    responses: [response()],
    analysis: analysis(),
    synthesizedResponse: 'synth',
    synthesisMethod: 'merge',
    synthesisConfidence: 0.9,
    totalDuration: 1000,
    totalTokens: 100,
    totalCost: 0.01,
    completedAt: NOW,
    ...overrides,
  };
}

describe('deriveVerdict', () => {
  it('returns pass for high confidence with no actions or risks', () => {
    const { verdict, diagnostic } = deriveVerdict(result({ synthesisConfidence: 0.92 }), { now: NOW });
    expect(verdict.status).toBe('pass');
    expect(verdict.confidence).toBe(0.92);
    expect(verdict.requiredActions).toEqual([]);
    expect(verdict.riskAreas).toEqual([]);
    expect(diagnostic.reason).toBe('normal');
  });

  it('returns pass-with-notes for high confidence risk areas', () => {
    const { verdict } = deriveVerdict(result({
      synthesisConfidence: 0.9,
      analysis: analysis({
        uniqueInsights: [{
          point: 'Security-specific edge case should be watched.',
          category: 'warning',
          agentId: 'agent-2',
          confidence: 0.85,
          value: 'high',
          reasoning: 'One reviewer found a risk.',
        }],
      }),
    }), { now: NOW });

    expect(verdict.status).toBe('pass-with-notes');
    expect(verdict.riskAreas[0]).toMatchObject({
      category: 'security',
      severity: 'medium',
    });
  });

  it('returns needs-changes when disagreements require actions', () => {
    const { verdict } = deriveVerdict(result({
      synthesisConfidence: 0.74,
      analysis: analysis({
        disagreements: [{
          topic: 'Correctness differs across agents',
          positions: [
            { agentId: 'agent-1', position: 'safe', confidence: 0.8 },
            { agentId: 'agent-2', position: 'buggy', confidence: 0.7 },
          ],
          requiresHumanReview: false,
        }],
      }),
    }), { now: NOW });

    expect(verdict.status).toBe('needs-changes');
    expect(verdict.requiredActions[0]).toContain('Resolve disagreement');
    expect(verdict.riskAreas[0].category).toBe('correctness');
  });

  it('returns blocked for human-review disagreements', () => {
    const { verdict } = deriveVerdict(result({
      synthesisConfidence: 0.8,
      analysis: analysis({
        disagreements: [{
          topic: 'Potential destructive overwrite',
          positions: [{ agentId: 'agent-1', position: 'unsafe', confidence: 0.8 }],
          requiresHumanReview: true,
        }],
      }),
    }), { now: NOW });

    expect(verdict.status).toBe('blocked');
    expect(verdict.riskAreas[0].severity).toBe('high');
  });

  it('returns inconclusive below the confidence threshold', () => {
    const { verdict, diagnostic } = deriveVerdict(result({ synthesisConfidence: 0.25 }), { now: NOW });
    expect(verdict.status).toBe('inconclusive');
    expect(diagnostic.reason).toBe('low-confidence');
  });

  it('returns inconclusive when analysis is missing', () => {
    const { verdict, diagnostic } = deriveVerdict(result({
      analysis: null as unknown as VerificationAnalysis,
    }), { now: NOW });
    expect(verdict.status).toBe('inconclusive');
    expect(diagnostic.reason).toBe('missing-analysis');
  });

  it('preserves raw responses by reference', () => {
    const responses = [response({ agentId: 'agent-1' }), response({ agentId: 'agent-2' })];
    const { verdict } = deriveVerdict(result({ responses }), { now: NOW });
    expect(verdict.rawResponses).toBe(responses);
    expect(verdict.rawResponses).toEqual(responses);
  });

  it('clamps invalid confidence values', () => {
    expect(deriveVerdict(result({ synthesisConfidence: Number.NaN }), { now: NOW }).verdict.confidence).toBe(0);
    expect(deriveVerdict(result({ synthesisConfidence: -1 }), { now: NOW }).verdict.confidence).toBe(0);
    expect(deriveVerdict(result({ synthesisConfidence: 2 }), { now: NOW }).verdict.confidence).toBe(1);
  });

  it('provides stable headlines for every status', () => {
    expect(headlineForStatus('pass')).toBe('Verification passed');
    expect(headlineForStatus('pass-with-notes')).toBe('Verification passed with notes');
    expect(headlineForStatus('needs-changes')).toBe('Changes are recommended');
    expect(headlineForStatus('blocked')).toBe('Human review is required');
    expect(headlineForStatus('inconclusive')).toBe('Verification was inconclusive');
  });
});
