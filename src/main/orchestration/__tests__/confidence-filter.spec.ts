import { describe, it, expect, beforeEach } from 'vitest';
import { ConfidenceFilter } from '../confidence-filter';
import type { AgentResponse } from '../../../shared/types/verification.types';

describe('ConfidenceFilter', () => {
  let filter: ConfidenceFilter;

  beforeEach(() => {
    ConfidenceFilter._resetForTesting();
    filter = ConfidenceFilter.getInstance();
  });

  it('should filter responses below threshold', () => {
    const responses: AgentResponse[] = [
      { agentId: 'a1', agentIndex: 0, model: 'test', response: 'High confidence answer', confidence: 0.9, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'methodical-analyst' },
      { agentId: 'a2', agentIndex: 1, model: 'test', response: 'Low confidence guess', confidence: 0.3, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'creative-solver' },
      { agentId: 'a3', agentIndex: 2, model: 'test', response: 'Medium confidence', confidence: 0.7, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'pragmatic-engineer' },
    ];

    const result = filter.filterByThreshold(responses, 0.8);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].agentId).toBe('a1');
    expect(result.rejected).toHaveLength(2);
  });

  it('should use default threshold when none specified', () => {
    filter.configure({ defaultThreshold: 0.5 });
    const responses: AgentResponse[] = [
      { agentId: 'a1', agentIndex: 0, model: 'test', response: 'Above', confidence: 0.6, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'methodical-analyst' },
      { agentId: 'a2', agentIndex: 1, model: 'test', response: 'Below', confidence: 0.4, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'creative-solver' },
    ];

    const result = filter.filterByThreshold(responses);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });

  it('should return all responses when threshold is 0', () => {
    const responses: AgentResponse[] = [
      { agentId: 'a1', agentIndex: 0, model: 'test', response: 'Any', confidence: 0.1, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'methodical-analyst' },
    ];

    const result = filter.filterByThreshold(responses, 0);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('should compute aggregate confidence from multiple responses', () => {
    const responses: AgentResponse[] = [
      { agentId: 'a1', agentIndex: 0, model: 'test', response: 'Same answer', confidence: 0.9, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'methodical-analyst' },
      { agentId: 'a2', agentIndex: 1, model: 'test', response: 'Same answer', confidence: 0.85, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'pragmatic-engineer' },
      { agentId: 'a3', agentIndex: 2, model: 'test', response: 'Different answer', confidence: 0.4, keyPoints: [], duration: 100, tokens: 10, cost: 0.001, personality: 'creative-solver' },
    ];

    const aggregate = filter.computeAggregateConfidence(responses);
    expect(aggregate).toBeGreaterThan(0.5);
    expect(aggregate).toBeLessThanOrEqual(1.0);
  });

  it('should handle empty response array', () => {
    const result = filter.filterByThreshold([], 0.5);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });
});
