/**
 * PolicyAdapter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PolicyAdapter, getPolicyAdapter } from './policy-adapter';
import type { Reflection } from './observation.types';

const mockReflections: Reflection[] = [
  {
    id: 'r1',
    title: 'Test Pattern',
    insight: 'Use caching for better performance',
    confidence: 0.85,
    applicability: ['general', 'performance'],
    patterns: [
      {
        type: 'success_pattern',
        description: 'Caching improves speed',
        evidence: ['Fast response'],
        strength: 0.9,
      },
    ],
    observationIds: ['obs-1', 'obs-2'],
    createdAt: Date.now(),
    ttl: 100000,
    usageCount: 5,
    effectivenessScore: 0.8,
    promotedToProcedural: false,
  },
];

const mockStore = {
  queryRelevantReflections: vi.fn().mockResolvedValue(mockReflections),
  recordInjection: vi.fn(),
};

vi.mock('./observation-store', () => ({
  getObservationStore: () => mockStore,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('PolicyAdapter', () => {
  let adapter: PolicyAdapter;

  beforeEach(() => {
    PolicyAdapter._resetForTesting();
    vi.clearAllMocks();
    adapter = getPolicyAdapter();
  });

  afterEach(() => {
    PolicyAdapter._resetForTesting();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = getPolicyAdapter();
      const instance2 = getPolicyAdapter();
      expect(instance1).toBe(instance2);
    });
  });

  describe('buildObservationContext', () => {
    it('should build observation context with reflections', async () => {
      const context = await adapter.buildObservationContext('test context', 'inst-1');

      expect(context).toBeDefined();
      expect(context).toContain('Learned Observations');
      expect(context).toContain('Test Pattern');
      expect(context).toContain('85%'); // Confidence percentage
      expect(context).toContain('Use caching for better performance');
    });

    it('should return empty string when no reflections', async () => {
      mockStore.queryRelevantReflections.mockResolvedValueOnce([]);

      const context = await adapter.buildObservationContext('test context');

      expect(context).toBe('');
    });

    it('should record injection for each reflection', async () => {
      await adapter.buildObservationContext('test context', 'inst-1');

      expect(mockStore.recordInjection).toHaveBeenCalledWith('r1', true);
    });

    it('should handle recordInjection errors gracefully', async () => {
      mockStore.recordInjection.mockRejectedValueOnce(new Error('Recording failed'));

      const context = await adapter.buildObservationContext('test context');

      expect(context).toBeDefined();
      expect(context).toContain('Test Pattern');
    });

    it('should return empty string on error', async () => {
      mockStore.queryRelevantReflections.mockRejectedValueOnce(new Error('Query failed'));

      const context = await adapter.buildObservationContext('test context');

      expect(context).toBe('');
    });
  });

  describe('token budget', () => {
    it('should respect token budget', async () => {
      // Create many large reflections
      const largeReflections: Reflection[] = Array.from({ length: 20 }, (_, i) => ({
        id: `r${i}`,
        title: 'Very Long Pattern Title That Takes Up Many Tokens',
        insight: 'This is a very long insight description that will consume a significant number of tokens when included in the context. '.repeat(10),
        confidence: 0.8,
        applicability: ['general'],
        patterns: [],
        observationIds: [],
        createdAt: Date.now(),
        ttl: 100000,
        usageCount: 1,
        effectivenessScore: 0.7,
        promotedToProcedural: false,
      }));

      mockStore.queryRelevantReflections.mockResolvedValueOnce(largeReflections);

      adapter.configure({ policyTokenBudget: 500 }); // Small budget

      const context = await adapter.buildObservationContext('test context');

      // Context should not include all reflections due to budget
      const reflectionCount = (context.match(/\*\*/g) || []).length / 2; // Count bold markers
      expect(reflectionCount).toBeLessThan(largeReflections.length);
    });

    it('should include as many reflections as budget allows', async () => {
      const reflections: Reflection[] = Array.from({ length: 5 }, (_, i) => ({
        id: `r${i}`,
        title: `Pattern ${i}`,
        insight: 'Short insight',
        confidence: 0.8,
        applicability: ['general'],
        patterns: [],
        observationIds: [],
        createdAt: Date.now(),
        ttl: 100000,
        usageCount: 1,
        effectivenessScore: 0.7,
        promotedToProcedural: false,
      }));

      mockStore.queryRelevantReflections.mockResolvedValueOnce(reflections);

      adapter.configure({ policyTokenBudget: 10000 }); // Large budget

      const context = await adapter.buildObservationContext('test context');

      // Should include all reflections
      expect(context).toContain('Pattern 0');
      expect(context).toContain('Pattern 4');
    });
  });

  describe('task type filtering', () => {
    it('should filter by task type applicability', async () => {
      const reflections: Reflection[] = [
        {
          id: 'r1',
          title: 'Performance Pattern',
          insight: 'Performance insight',
          confidence: 0.85,
          applicability: ['performance'],
          patterns: [],
          observationIds: [],
          createdAt: Date.now(),
          ttl: 100000,
          usageCount: 1,
          effectivenessScore: 0.8,
          promotedToProcedural: false,
        },
        {
          id: 'r2',
          title: 'Security Pattern',
          insight: 'Security insight',
          confidence: 0.9,
          applicability: ['security'],
          patterns: [],
          observationIds: [],
          createdAt: Date.now(),
          ttl: 100000,
          usageCount: 1,
          effectivenessScore: 0.85,
          promotedToProcedural: false,
        },
      ];

      mockStore.queryRelevantReflections.mockResolvedValueOnce(reflections);

      const context = await adapter.buildObservationContext(
        'test context',
        'inst-1',
        'performance'
      );

      expect(context).toContain('Performance Pattern');
      expect(context).not.toContain('Security Pattern');
    });

    it('should return empty string when no reflections match task type', async () => {
      const reflections: Reflection[] = [
        {
          id: 'r1',
          title: 'Security Pattern',
          insight: 'Security insight',
          confidence: 0.9,
          applicability: ['security'],
          patterns: [],
          observationIds: [],
          createdAt: Date.now(),
          ttl: 100000,
          usageCount: 1,
          effectivenessScore: 0.85,
          promotedToProcedural: false,
        },
      ];

      mockStore.queryRelevantReflections.mockResolvedValueOnce(reflections);

      const context = await adapter.buildObservationContext(
        'test context',
        'inst-1',
        'performance'
      );

      expect(context).toBe('');
    });
  });

  describe('configuration', () => {
    it('should update configuration', () => {
      adapter.configure({
        policyTokenBudget: 2000,
        maxReflectionsPerPrompt: 10,
      });

      // Configuration is internal, verify it's accepted without error
      expect(adapter).toBeDefined();
    });
  });

  describe('markdown formatting', () => {
    it('should format reflections as markdown', async () => {
      const context = await adapter.buildObservationContext('test context');

      expect(context).toContain('## Learned Observations');
      expect(context).toContain('**Test Pattern**');
      expect(context).toMatch(/confidence: \d+%/);
    });

    it('should include header and description', async () => {
      const context = await adapter.buildObservationContext('test context');

      expect(context).toContain('The following insights were learned from previous sessions');
    });

    it('should have proper line spacing', async () => {
      const context = await adapter.buildObservationContext('test context');

      const lines = context.split('\n');
      expect(lines[0]).toBe('## Learned Observations');
      expect(lines[1]).toBe('');
      expect(lines[lines.length - 1]).toBe('');
    });
  });
});
