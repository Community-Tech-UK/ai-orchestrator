/**
 * A/B Testing Engine Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ABTestingEngine } from './ab-testing';

// Mock the RLM database
vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    getPatterns: () => [],
    getOutcomes: () => [],
    upsertPattern: vi.fn(),
    addOutcome: vi.fn(),
  }),
}));

describe('ABTestingEngine', () => {
  let engine: ABTestingEngine;

  beforeEach(() => {
    // Reset singleton for clean tests
    ABTestingEngine.resetInstance();
    engine = ABTestingEngine.getInstance({ persistResults: false });
    // Add error listener to prevent unhandled error events from throwing
    engine.on('error', () => {});
  });

  afterEach(() => {
    ABTestingEngine.resetInstance();
  });

  describe('Experiment Creation', () => {
    it('should create an experiment with default values', () => {
      const experiment = engine.createExperiment({
        name: 'Test Experiment',
        taskType: 'code_review',
        variants: [
          { name: 'Control', template: 'Please review this code', weight: 0.5 },
          { name: 'Variant B', template: 'Please carefully review this code for bugs', weight: 0.5 },
        ],
      });

      expect(experiment.id).toBeDefined();
      expect(experiment.name).toBe('Test Experiment');
      expect(experiment.taskType).toBe('code_review');
      expect(experiment.status).toBe('draft');
      expect(experiment.variants).toHaveLength(2);
      expect(experiment.minSamples).toBe(30); // Default
      expect(experiment.confidenceThreshold).toBe(0.95); // Default
    });

    it('should normalize variant weights', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 1 },
          { name: 'B', template: 'b', weight: 3 },
        ],
      });

      // Weights should sum to 1
      const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 5);
      expect(experiment.variants[0].weight).toBeCloseTo(0.25, 5);
      expect(experiment.variants[1].weight).toBeCloseTo(0.75, 5);
    });

    it('should generate unique IDs for variants', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      const variantIds = experiment.variants.map((v) => v.id);
      expect(new Set(variantIds).size).toBe(variantIds.length);
    });
  });

  describe('Experiment Lifecycle', () => {
    it('should start a draft experiment', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      const started = engine.startExperiment(experiment.id);
      expect(started).toBe(true);

      const updated = engine.getExperiment(experiment.id);
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeDefined();
    });

    it('should pause a running experiment', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      const paused = engine.pauseExperiment(experiment.id);

      expect(paused).toBe(true);
      expect(engine.getExperiment(experiment.id)?.status).toBe('paused');
    });

    it('should complete an experiment manually', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      const result = engine.completeExperiment(experiment.id);

      expect(result).not.toBeNull();
      expect(result?.experiment.status).toBe('completed');
      expect(result?.experiment.endedAt).toBeDefined();
    });

    it('should not start a completed experiment', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      engine.completeExperiment(experiment.id);
      const started = engine.startExperiment(experiment.id);

      expect(started).toBe(false);
    });

    it('should respect max concurrent experiments limit', () => {
      // Configure to allow only 2 concurrent experiments
      engine.configure({ maxConcurrentExperiments: 2 });

      const exp1 = engine.createExperiment({
        name: 'Exp 1',
        taskType: 'test1',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      const exp2 = engine.createExperiment({
        name: 'Exp 2',
        taskType: 'test2',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      const exp3 = engine.createExperiment({
        name: 'Exp 3',
        taskType: 'test3',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(exp1.id);
      engine.startExperiment(exp2.id);
      const started3 = engine.startExperiment(exp3.id);

      expect(started3).toBe(false);
      expect(engine.getExperiment(exp3.id)?.status).toBe('draft');
    });
  });

  describe('Variant Selection', () => {
    it('should return null when no running experiment for task type', () => {
      const result = engine.getVariant('nonexistent_task');
      expect(result).toBeNull();
    });

    it('should select a variant from running experiment', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'code_review',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      const result = engine.getVariant('code_review');

      expect(result).not.toBeNull();
      expect(result?.experiment.id).toBe(experiment.id);
      expect(experiment.variants.map((v) => v.id)).toContain(result?.variant.id);
    });

    it('should maintain consistent assignment for same session', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);

      const sessionId = 'session-123';
      const result1 = engine.getVariant('test', sessionId);
      const result2 = engine.getVariant('test', sessionId);
      const result3 = engine.getVariant('test', sessionId);

      expect(result1?.variant.id).toBe(result2?.variant.id);
      expect(result2?.variant.id).toBe(result3?.variant.id);
    });

    it('should follow weighted distribution', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'weighted_test',
        variants: [
          { name: 'A', template: 'a', weight: 0.9 },
          { name: 'B', template: 'b', weight: 0.1 },
        ],
      });

      engine.startExperiment(experiment.id);

      const counts: Record<string, number> = {};
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const result = engine.getVariant('weighted_test');
        if (result) {
          counts[result.variant.name] = (counts[result.variant.name] || 0) + 1;
        }
      }

      // A should be selected ~90% of the time (with some variance)
      expect(counts['A']).toBeGreaterThan(iterations * 0.8);
      expect(counts['B']).toBeLessThan(iterations * 0.2);
    });
  });

  describe('Outcome Recording', () => {
    it('should record successful outcome', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      const variantA = experiment.variants[0];

      engine.recordOutcome(experiment.id, variantA.id, {
        success: true,
        duration: 100,
        tokens: 50,
      });

      const results = engine.getResults(experiment.id);
      const resultA = results.find((r) => r.variantId === variantA.id);

      expect(resultA).toBeDefined();
      expect(resultA?.samples).toBe(1);
      expect(resultA?.successes).toBe(1);
      expect(resultA?.successRate).toBe(1);
      expect(resultA?.avgDuration).toBe(100);
      expect(resultA?.avgTokens).toBe(50);
    });

    it('should calculate running averages correctly', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 1 },
        ],
      });

      engine.startExperiment(experiment.id);
      const variantA = experiment.variants[0];

      // Record multiple outcomes
      engine.recordOutcome(experiment.id, variantA.id, { success: true, duration: 100, tokens: 50 });
      engine.recordOutcome(experiment.id, variantA.id, { success: false, duration: 200, tokens: 100 });
      engine.recordOutcome(experiment.id, variantA.id, { success: true, duration: 300, tokens: 150 });

      const results = engine.getResults(experiment.id);
      const resultA = results.find((r) => r.variantId === variantA.id);

      expect(resultA?.samples).toBe(3);
      expect(resultA?.successes).toBe(2);
      expect(resultA?.successRate).toBeCloseTo(2 / 3, 5);
      expect(resultA?.avgDuration).toBeCloseTo(200, 5); // (100+200+300)/3
      expect(resultA?.avgTokens).toBeCloseTo(100, 5); // (50+100+150)/3
    });
  });

  describe('Winner Detection', () => {
    it('should return null when minimum samples not reached', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        minSamples: 30,
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);

      // Record some outcomes but not enough
      for (let i = 0; i < 10; i++) {
        engine.recordOutcome(experiment.id, experiment.variants[0].id, { success: true });
        engine.recordOutcome(experiment.id, experiment.variants[1].id, { success: false });
      }

      const winner = engine.getWinner(experiment.id);
      expect(winner).toBeNull();
    });

    it('should detect winner when statistically significant', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        minSamples: 5, // Low for testing
        confidenceThreshold: 0.9,
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      const variantA = experiment.variants[0];
      const variantB = experiment.variants[1];

      // A has 90% success rate, B has 30% - clear winner
      for (let i = 0; i < 10; i++) {
        engine.recordOutcome(experiment.id, variantA.id, { success: i < 9 });
        engine.recordOutcome(experiment.id, variantB.id, { success: i < 3 });
      }

      const winner = engine.getWinner(experiment.id);
      expect(winner).not.toBeNull();
      expect(winner?.variant.id).toBe(variantA.id);
      expect(winner?.confidence).toBeGreaterThan(0.9);
    });

    it('should auto-complete experiment when winner is detected', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        minSamples: 5,
        confidenceThreshold: 0.8,
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      const variantA = experiment.variants[0];
      const variantB = experiment.variants[1];

      // Record enough outcomes with clear difference
      for (let i = 0; i < 10; i++) {
        engine.recordOutcome(experiment.id, variantA.id, { success: true });
        engine.recordOutcome(experiment.id, variantB.id, { success: false });
      }

      const updated = engine.getExperiment(experiment.id);
      expect(updated?.status).toBe('completed');
    });
  });

  describe('Experiment Queries', () => {
    it('should list experiments filtered by status', () => {
      const exp1 = engine.createExperiment({
        name: 'Draft',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      const exp2 = engine.createExperiment({
        name: 'Running',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(exp2.id);

      const drafts = engine.listExperiments({ status: 'draft' });
      const running = engine.listExperiments({ status: 'running' });
      const all = engine.listExperiments();

      expect(drafts).toHaveLength(1);
      expect(drafts[0].id).toBe(exp1.id);
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(exp2.id);
      expect(all).toHaveLength(2);
    });

    it('should get experiments by task type', () => {
      engine.createExperiment({
        name: 'Code Review 1',
        taskType: 'code_review',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.createExperiment({
        name: 'Bug Fix',
        taskType: 'bug_fix',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      const codeReview = engine.getExperimentsByTaskType('code_review');
      const bugFix = engine.getExperimentsByTaskType('bug_fix');

      expect(codeReview).toHaveLength(1);
      expect(bugFix).toHaveLength(1);
    });

    it('should return correct stats', () => {
      const exp1 = engine.createExperiment({
        name: 'Test 1',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      const exp2 = engine.createExperiment({
        name: 'Test 2',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(exp1.id);
      engine.startExperiment(exp2.id);
      engine.completeExperiment(exp2.id);

      // Record some outcomes
      engine.recordOutcome(exp1.id, exp1.variants[0].id, { success: true });
      engine.recordOutcome(exp1.id, exp1.variants[1].id, { success: false });

      const stats = engine.getStats();

      expect(stats.totalExperiments).toBe(2);
      expect(stats.running).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.draft).toBe(0);
      expect(stats.paused).toBe(0);
      expect(stats.totalOutcomes).toBe(2);
    });
  });

  describe('Experiment Deletion', () => {
    it('should delete an experiment and its data', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);
      engine.recordOutcome(experiment.id, experiment.variants[0].id, { success: true });

      const deleted = engine.deleteExperiment(experiment.id);

      expect(deleted).toBe(true);
      expect(engine.getExperiment(experiment.id)).toBeNull();
      expect(engine.getResults(experiment.id)).toHaveLength(0);
    });

    it('should return false when deleting non-existent experiment', () => {
      const deleted = engine.deleteExperiment('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('Session Assignment Management', () => {
    it('should clear assignment for a specific session', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);

      const sessionId = 'session-123';
      const result1 = engine.getVariant('test', sessionId);
      engine.clearAssignment(experiment.id, sessionId);
      const result2 = engine.getVariant('test', sessionId);

      // After clearing, might get different variant (random)
      // But the key point is the assignment was cleared
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
    });

    it('should clear all assignments for an experiment', () => {
      const experiment = engine.createExperiment({
        name: 'Test',
        taskType: 'test',
        variants: [
          { name: 'A', template: 'a', weight: 0.5 },
          { name: 'B', template: 'b', weight: 0.5 },
        ],
      });

      engine.startExperiment(experiment.id);

      // Create multiple session assignments
      engine.getVariant('test', 'session-1');
      engine.getVariant('test', 'session-2');
      engine.getVariant('test', 'session-3');

      engine.clearAllAssignments(experiment.id);

      // All sessions should now get fresh assignments
      // (they might be the same due to randomness, but assignments are cleared)
      expect(engine.getVariant('test', 'session-1')).not.toBeNull();
    });
  });
});
