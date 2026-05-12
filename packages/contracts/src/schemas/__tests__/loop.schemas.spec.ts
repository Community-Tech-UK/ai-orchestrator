import { describe, it, expect } from 'vitest';
import {
  LoopCompletionConfigSchema,
  LoopCrossModelReviewConfigSchema,
  LoopTerminalIntentSchema,
  LoopReviewSeveritySchema,
  LoopStateSchema,
} from '../loop.schemas';

/**
 * Schema-vs-type drift regression guards for `LoopCompletionConfig` and
 * related fields. Each test guards a specific drift that has actually
 * happened in this repo — keep them named accordingly so future drift is
 * easy to attribute.
 */
describe('Loop schemas — type/schema drift guards', () => {
  describe('LoopReviewSeveritySchema', () => {
    it('accepts the four documented severities', () => {
      for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
        expect(() => LoopReviewSeveritySchema.parse(sev)).not.toThrow();
      }
    });
    it('rejects anything else', () => {
      expect(() => LoopReviewSeveritySchema.parse('blocker')).toThrow();
      expect(() => LoopReviewSeveritySchema.parse('CRITICAL')).toThrow(); // case-sensitive
    });
  });

  describe('LoopCrossModelReviewConfigSchema', () => {
    it('accepts a minimal valid config', () => {
      expect(() =>
        LoopCrossModelReviewConfigSchema.parse({
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 90,
          reviewDepth: 'structured',
        }),
      ).not.toThrow();
    });

    it('rejects blockingSeverities = []', () => {
      // Empty blocking list would make the gate a silent no-op; reject early.
      expect(() =>
        LoopCrossModelReviewConfigSchema.parse({
          enabled: true,
          blockingSeverities: [],
          timeoutSeconds: 90,
          reviewDepth: 'structured',
        }),
      ).toThrow();
    });

    it('allows an explicit reviewers array', () => {
      const parsed = LoopCrossModelReviewConfigSchema.parse({
        enabled: true,
        reviewers: ['gemini', 'codex'],
        blockingSeverities: ['critical'],
        timeoutSeconds: 60,
        reviewDepth: 'tiered',
      });
      expect(parsed.reviewers).toEqual(['gemini', 'codex']);
    });

    it('rejects negative or zero timeoutSeconds', () => {
      expect(() =>
        LoopCrossModelReviewConfigSchema.parse({
          enabled: true,
          blockingSeverities: ['critical'],
          timeoutSeconds: 0,
          reviewDepth: 'structured',
        }),
      ).toThrow();
    });
  });

  describe('LoopCompletionConfigSchema', () => {
    const base = {
      completedFilenamePattern: '*_completed.md',
      donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
      doneSentinelFile: 'DONE.txt',
      verifyCommand: '',
      verifyTimeoutMs: 600_000,
      runVerifyTwice: true,
      requireCompletedFileRename: false,
    };

    it('accepts the legacy shape without crossModelReview (backward compat)', () => {
      expect(() => LoopCompletionConfigSchema.parse(base)).not.toThrow();
    });

    it('accepts the shape with crossModelReview present', () => {
      const cfg = {
        ...base,
        crossModelReview: {
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 90,
          reviewDepth: 'structured',
        },
      };
      const parsed = LoopCompletionConfigSchema.parse(cfg);
      expect(parsed.crossModelReview?.enabled).toBe(true);
    });

    it('preserves crossModelReview through parse→stringify→parse roundtrip', () => {
      // This is the specific drift the reviewer caught: a missing schema
      // field would silently strip on deserialization.
      const original = {
        ...base,
        crossModelReview: {
          enabled: true,
          reviewers: ['gemini'],
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 90,
          reviewDepth: 'structured',
        },
      };
      const parsed1 = LoopCompletionConfigSchema.parse(original);
      const json = JSON.stringify(parsed1);
      const parsed2 = LoopCompletionConfigSchema.parse(JSON.parse(json));
      expect(parsed2.crossModelReview).toEqual(original.crossModelReview);
    });
  });

  describe('LoopStateSchema.uncompletedPlanFilesAtStart', () => {
    it('defaults to [] when omitted', () => {
      // Defends against legacy persisted state that predates the new field
      // — they should round-trip through parse with an empty list.
      const minimalState = {
        id: 'loop-1',
        chatId: 'chat-1',
        config: {
          initialPrompt: 'do thing',
          workspaceCwd: '/tmp',
          provider: 'claude' as const,
          reviewStyle: 'single' as const,
          contextStrategy: 'fresh-child' as const,
          caps: {
            maxIterations: 50,
            maxWallTimeMs: 60_000,
            maxTokens: 100_000,
            maxCostCents: 100,
            maxToolCallsPerIteration: 100,
          },
          progressThresholds: {
            identicalHashWarnConsecutive: 2,
            identicalHashCriticalConsecutive: 3,
            identicalHashCriticalWindow: 3,
            similarityWarnMean: 0.85,
            similarityCriticalMean: 0.92,
            stageWarnIterations: { PLAN: 3, REVIEW: 2, IMPLEMENT: 8 },
            stageCriticalIterations: { PLAN: 5, REVIEW: 3, IMPLEMENT: 12 },
            errorRepeatWarnInWindow: 3,
            errorRepeatCriticalInWindow: 4,
            tokensWithoutProgressWarn: 25_000,
            tokensWithoutProgressCritical: 60_000,
            pauseOnTokenBurn: false,
            toolRepeatWarnPerIteration: 5,
            toolRepeatCriticalPerIteration: 8,
            testStagnationWarnIterations: 3,
            testStagnationCriticalIterations: 5,
            churnRatioWarn: 0.30,
            churnRatioCritical: 0.50,
            warnEscalationWindow: 5,
            warnEscalationCount: 3,
          },
          completion: {
            completedFilenamePattern: '*_completed.md',
            donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
            doneSentinelFile: 'DONE.txt',
            verifyCommand: '',
            verifyTimeoutMs: 600_000,
            runVerifyTwice: true,
            requireCompletedFileRename: false,
          },
          allowDestructiveOps: false,
          initialStage: 'IMPLEMENT' as const,
        },
        status: 'running' as const,
        startedAt: 0,
        endedAt: null,
        totalIterations: 0,
        totalTokens: 0,
        totalCostCents: 0,
        currentStage: 'IMPLEMENT' as const,
        pendingInterventions: [],
        completedFileRenameObserved: false,
        doneSentinelPresentAtStart: false,
        planChecklistFullyCheckedAtStart: false,
        // uncompletedPlanFilesAtStart deliberately omitted
        tokensSinceLastTestImprovement: 0,
        highestTestPassCount: 0,
        iterationsOnCurrentStage: 0,
        recentWarnIterationSeqs: [],
      };
      const parsed = LoopStateSchema.parse(minimalState);
      expect(parsed.uncompletedPlanFilesAtStart).toEqual([]);
      expect(parsed.terminalIntentHistory).toEqual([]);
    });
  });

  describe('LoopTerminalIntentSchema', () => {
    it('accepts explicit complete/block/fail intent records', () => {
      for (const kind of ['complete', 'block', 'fail'] as const) {
        const parsed = LoopTerminalIntentSchema.parse({
          id: `intent-${kind}`,
          loopRunId: 'loop-1',
          iterationSeq: 1,
          kind,
          summary: 'done',
          evidence: [{ kind: 'test', label: 'npm test', value: 'passed' }],
          source: 'loop-control-cli',
          createdAt: 10,
          receivedAt: 20,
          status: 'pending',
        });
        expect(parsed.kind).toBe(kind);
      }
    });
  });
});
