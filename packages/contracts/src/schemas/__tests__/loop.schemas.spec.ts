import { describe, it, expect } from 'vitest';
import {
  LoopCompletionConfigSchema,
  LoopConfigSchema,
  LoopCrossModelReviewConfigSchema,
  LoopHardCapsSchema,
  LoopInterveneePayloadSchema,
  LoopPendingInputSchema,
  LoopIterationSchema,
  LoopTerminalIntentSchema,
  LoopReviewSeveritySchema,
  LoopStartPayloadSchema,
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
      const parsed = LoopCompletionConfigSchema.parse(base);

      expect(parsed.allowOperatorReviewedCompletion).toBe(false);
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

    it('preserves an explicit operator-reviewed completion opt-in', () => {
      const parsed = LoopCompletionConfigSchema.parse({
        ...base,
        allowOperatorReviewedCompletion: true,
      });

      expect(parsed.allowOperatorReviewedCompletion).toBe(true);
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

    it('round-trips the review-driven stall bounds (maxStalledReviewIterations / maxLedgerStallIterations)', () => {
      // Type/schema drift: these fields exist on LoopCompletionConfig but were
      // absent from the schema, so a renderer-submitted value was silently
      // stripped at LOOP_START (LoopConfigInputSchema → LoopCompletionConfigSchema).
      const parsed = LoopCompletionConfigSchema.parse({
        ...base,
        maxStalledReviewIterations: 5,
        maxLedgerStallIterations: 12,
      });
      expect(parsed.maxStalledReviewIterations).toBe(5);
      expect(parsed.maxLedgerStallIterations).toBe(12);
    });
  });

  describe('CompletionSignalEvidenceSchema.openCount', () => {
    const baseIteration = {
      id: 'iter-1',
      loopRunId: 'loop-1',
      seq: 0,
      stage: 'IMPLEMENT' as const,
      startedAt: 1,
      endedAt: 2,
      childInstanceId: null,
      tokens: 0,
      costCents: 0,
      filesChanged: [],
      toolCalls: [],
      errors: [],
      testPassCount: null,
      testFailCount: null,
      workHash: 'hash',
      outputSimilarityToPrev: null,
      outputExcerpt: '',
      outputFull: '',
      progressVerdict: 'OK' as const,
      progressSignals: [],
      completionSignalsFired: [],
      verifyStatus: 'not-run' as const,
      verifyOutputExcerpt: '',
    };

    it('round-trips the structured ledger open-item count', () => {
      const parsed = LoopIterationSchema.parse({
        ...baseIteration,
        completionSignalsFired: [
          { id: 'ledger-complete', sufficient: true, detail: 'all resolved', openCount: 0 },
          { id: 'declared-complete', sufficient: false, detail: 'agent said done' },
        ],
      });
      expect(parsed.completionSignalsFired[0].openCount).toBe(0);
      expect(parsed.completionSignalsFired[1].openCount).toBeUndefined();
    });
  });

  describe('LoopStateSchema ledger-stall fields', () => {
    const baseState = {
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
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 0,
      recentWarnIterationSeqs: [],
    };

    it('round-trips ledgerOpenCountBest / ledgerNoImprovementIterations', () => {
      const parsed = LoopStateSchema.parse({
        ...baseState,
        ledgerOpenCountBest: 3,
        ledgerNoImprovementIterations: 4,
      });
      expect(parsed.ledgerOpenCountBest).toBe(3);
      expect(parsed.ledgerNoImprovementIterations).toBe(4);
    });

    it('round-trips justCompacted (B5 canary flag)', () => {
      const parsed = LoopStateSchema.parse({
        ...baseState,
        justCompacted: { seq: 7, reason: 'utilization recycle' },
      });
      expect(parsed.justCompacted).toEqual({ seq: 7, reason: 'utilization recycle' });
    });
  });

  describe('LoopHardCapsSchema', () => {
    it('accepts null maxIterations as an unbounded iteration cap', () => {
      const parsed = LoopHardCapsSchema.parse({
        maxIterations: null,
        maxWallTimeMs: 60_000,
        maxTokens: null,
        maxCostCents: 100_000,
        maxToolCallsPerIteration: 100,
      });

      expect(parsed.maxIterations).toBeNull();
    });

    it('accepts null maxTokens as an unbounded token cap', () => {
      const parsed = LoopHardCapsSchema.parse({
        maxIterations: 50,
        maxWallTimeMs: 60_000,
        maxTokens: null,
        maxCostCents: 100_000,
        maxToolCallsPerIteration: 100,
      });

      expect(parsed.maxTokens).toBeNull();
    });

    it('accepts null maxCostCents as an unbounded spend cap', () => {
      const parsed = LoopHardCapsSchema.parse({
        maxIterations: 50,
        maxWallTimeMs: 60_000,
        maxTokens: 100_000,
        maxCostCents: null,
        maxToolCallsPerIteration: 100,
      });

      expect(parsed.maxCostCents).toBeNull();
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
      expect(parsed.inFlightIteration).toBeUndefined();
      expect(parsed.config.audit).toEqual({
        finalAuditMode: 'observe',
        preflightMode: 'off',
        planPacketMode: 'off',
        cleanlinessScan: true,
      });
    });

    it('round-trips an in-flight iteration marker for crash recovery checkpoints', () => {
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
        uncompletedPlanFilesAtStart: [],
        inFlightIteration: {
          seq: 0,
          stage: 'IMPLEMENT' as const,
          startedAt: 123,
          idempotencyKey: 'loop-1:iteration:0',
        },
        tokensSinceLastTestImprovement: 0,
        highestTestPassCount: 0,
        iterationsOnCurrentStage: 0,
        recentWarnIterationSeqs: [],
      };

      const parsed = LoopStateSchema.parse(minimalState);

      expect(parsed.inFlightIteration).toEqual({
        seq: 0,
        stage: 'IMPLEMENT',
        startedAt: 123,
        idempotencyKey: 'loop-1:iteration:0',
      });
    });
  });

  describe('LoopIterationSchema.verifyFailureKind', () => {
    it('round-trips the verify failure kind for failed verify infrastructure diagnostics', () => {
      const parsed = LoopIterationSchema.parse({
        id: 'iter-1',
        loopRunId: 'loop-1',
        seq: 0,
        stage: 'IMPLEMENT',
        startedAt: 1,
        endedAt: 2,
        childInstanceId: null,
        tokens: 0,
        costCents: 0,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        workHash: 'hash',
        outputSimilarityToPrev: null,
        outputExcerpt: '',
        outputFull: '',
        progressVerdict: 'OK',
        progressSignals: [],
        completionSignalsFired: [],
        verifyStatus: 'failed',
        verifyOutputExcerpt: 'verify timed out',
        verifyFailureKind: 'timeout',
      });

      expect(parsed.verifyFailureKind).toBe('timeout');
    });
  });

  describe('LoopStateSchema.pendingInterventions', () => {
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
          identicalToolCallConsecutiveCritical: 3,
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
      completedFileRenameObserved: false,
      doneSentinelPresentAtStart: false,
      planChecklistFullyCheckedAtStart: false,
      uncompletedPlanFilesAtStart: [],
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 0,
      recentWarnIterationSeqs: [],
    };

    it('coerces legacy string interventions to typed queue records', () => {
      const parsed = LoopStateSchema.parse({
        ...minimalState,
        pendingInterventions: ['use fixtures, not production'],
      });

      expect(parsed.pendingInterventions).toEqual([
        expect.objectContaining({
          kind: 'queue',
          message: 'use fixtures, not production',
          source: 'human',
        }),
      ]);
    });

    it('accepts typed steer and queue pending inputs', () => {
      const parsed = LoopStateSchema.parse({
        ...minimalState,
        pendingInterventions: [{
          id: 'input-1',
          kind: 'steer',
          message: 'pivot at the next safe boundary',
          enqueuedAt: 123,
          source: 'human',
        }],
      });

      expect(parsed.pendingInterventions[0]).toEqual({
        id: 'input-1',
        kind: 'steer',
        message: 'pivot at the next safe boundary',
        enqueuedAt: 123,
        source: 'human',
      });
    });

    it('accepts context-survival pending inputs emitted by the loop engine', () => {
      const parsed = LoopStateSchema.parse({
        ...minimalState,
        pendingInterventions: [{
          id: 'input-context-1',
          kind: 'queue',
          message: 'Keep working while context budget remains healthy.',
          enqueuedAt: 456,
          source: 'context-survival',
        }],
      });

      expect(parsed.pendingInterventions[0]?.source).toBe('context-survival');
    });

    it('defaults announce-then-halt nudge count and accepts its pending-input source', () => {
      const parsed = LoopStateSchema.parse({
        ...minimalState,
        pendingInterventions: [{
          id: 'input-announce-1',
          kind: 'queue',
          message: 'Continue now. Execute the announced command.',
          enqueuedAt: 789,
          source: 'announce-then-halt',
        }],
      });

      expect(parsed.announceThenHaltNudgeCount).toBe(0);
      expect(parsed.pendingInterventions[0]?.source).toBe('announce-then-halt');
    });

    it('accepts an intervention kind in the IPC payload and leaves omitted kind undefined', () => {
      expect(LoopInterveneePayloadSchema.parse({
        loopRunId: 'loop-1',
        message: 'later',
      }).kind).toBeUndefined();
      expect(LoopInterveneePayloadSchema.parse({
        loopRunId: 'loop-1',
        message: 'now',
        kind: 'steer',
      }).kind).toBe('steer');
    });
  });

  describe('LoopConfigSchema long-run caps', () => {
    const baseConfig = {
      initialPrompt: 'run for a long time',
      workspaceCwd: '/repo',
      provider: 'claude',
      reviewStyle: 'single',
      contextStrategy: 'fresh-child',
      caps: {
        maxIterations: null,
        maxWallTimeMs: 50 * 60 * 60 * 1000,
        maxTokens: null,
        maxCostCents: null,
        maxToolCallsPerIteration: 200,
      },
      progressThresholds: {
        identicalHashWarnConsecutive: 2,
        identicalHashCriticalConsecutive: 3,
        identicalHashCriticalWindow: 3,
        similarityWarnMean: 0.85,
        similarityCriticalMean: 0.92,
        stageWarnIterations: { PLAN: 3, REVIEW: 3, IMPLEMENT: 8 },
        stageCriticalIterations: { PLAN: 5, REVIEW: 5, IMPLEMENT: 12 },
        errorRepeatWarnInWindow: 3,
        errorRepeatCriticalInWindow: 4,
        tokensWithoutProgressWarn: 25_000,
        tokensWithoutProgressCritical: 60_000,
        pauseOnTokenBurn: false,
        toolRepeatWarnPerIteration: 5,
        toolRepeatCriticalPerIteration: 8,
        testStagnationWarnIterations: 3,
        testStagnationCriticalIterations: 5,
        churnRatioWarn: 0.3,
        churnRatioCritical: 0.5,
        warnEscalationWindow: 5,
        warnEscalationCount: 3,
      },
      completion: {
        completedFilenamePattern: '*_[Cc]ompleted.md',
        donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
        doneSentinelFile: 'DONE.txt',
        verifyCommand: 'true',
        allowOperatorReviewedCompletion: false,
        verifyTimeoutMs: 600_000,
        runVerifyTwice: true,
        requireCompletedFileRename: false,
      },
      initialStage: 'IMPLEMENT',
      allowDestructiveOps: false,
    };

    it('accepts a 50-hour maxWallTimeMs loop cap', () => {
      expect(LoopConfigSchema.safeParse(baseConfig).success).toBe(true);
    });

    it('accepts serializable next-objective planning config', () => {
      const parsed = LoopConfigSchema.parse({
        ...baseConfig,
        nextObjectivePlanning: { enabled: true, cadence: 2 },
      });

      expect(parsed.nextObjectivePlanning).toEqual({ enabled: true, cadence: 2 });
    });

    it('accepts audit config modes and rejects invalid mode strings', () => {
      const parsed = LoopConfigSchema.parse({
        ...baseConfig,
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'record',
          planPacketMode: 'prompted',
          cleanlinessScan: true,
        },
      });

      expect(parsed.audit).toEqual({
        finalAuditMode: 'gate',
        preflightMode: 'record',
        planPacketMode: 'prompted',
        cleanlinessScan: true,
      });
      expect(LoopConfigSchema.safeParse({
        ...baseConfig,
        audit: {
          finalAuditMode: 'strict',
          preflightMode: 'record',
          planPacketMode: 'prompted',
          cleanlinessScan: true,
        },
      }).success).toBe(false);
    });

    it('accepts full state payloads with repo baseline, preflight, and final audit', () => {
      const parsed = LoopStateSchema.parse({
        id: 'loop-audit',
        chatId: 'chat-1',
        config: baseConfig,
        status: 'running',
        startedAt: 0,
        endedAt: null,
        totalIterations: 0,
        totalTokens: 0,
        totalCostCents: 0,
        currentStage: 'IMPLEMENT',
        pendingInterventions: [],
        completedFileRenameObserved: false,
        doneSentinelPresentAtStart: false,
        planChecklistFullyCheckedAtStart: false,
        uncompletedPlanFilesAtStart: [],
        tokensSinceLastTestImprovement: 0,
        highestTestPassCount: 0,
        iterationsOnCurrentStage: 0,
        recentWarnIterationSeqs: [],
        repoBaseline: {
          source: 'git',
          capturedAt: 1,
          workspaceCwd: '/repo',
          headRef: 'abc',
          dirtyAtStart: false,
          trackedDirtyAtStart: [],
          untrackedAtStart: [],
        },
        preflight: {
          status: 'passed',
          ranAt: 2,
          commands: [{
            label: 'quick-verify',
            command: 'npm run lint',
            status: 'passed',
            durationMs: 10,
            outputExcerpt: 'ok',
          }],
        },
        latestFinalAudit: {
          status: 'passed',
          ranAt: 3,
          coverage: {
            criteriaTotal: 1,
            criteriaVerified: 1,
            criteriaUnverified: 0,
            verifyCommandRan: true,
            repoComparisonRan: true,
            cleanlinessScanRan: true,
          },
          findings: [],
          changedFiles: ['src/a.ts'],
          reportPath: '/repo/.aio-loop-state/loop-audit/AUDIT.md',
        },
      });

      expect(parsed.latestFinalAudit?.status).toBe('passed');
      expect(parsed.preflight?.commands[0]?.label).toBe('quick-verify');
    });
  });

  describe('LoopStartPayloadSchema', () => {
    it('does not materialize full-config audit defaults when start input omits audit', () => {
      const parsed = LoopStartPayloadSchema.parse({
        chatId: 'chat-1',
        config: {
          initialPrompt: 'implement the feature',
          workspaceCwd: '/repo',
        },
      });

      expect(parsed.config.audit).toBeUndefined();
    });

    it('preserves partial audit overrides without filling omitted audit fields', () => {
      const parsed = LoopStartPayloadSchema.parse({
        chatId: 'chat-1',
        config: {
          initialPrompt: 'implement the feature',
          workspaceCwd: '/repo',
          audit: {
            preflightMode: 'block',
          },
        },
      });

      expect(parsed.config.audit).toEqual({ preflightMode: 'block' });
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

  describe('LoopTerminalIntentSchema.wakeup', () => {
    it('accepts wakeup intents with a resumeAt timestamp', () => {
      const parsed = LoopTerminalIntentSchema.parse({
        id: 'intent-wakeup',
        loopRunId: 'loop-1',
        iterationSeq: 2,
        kind: 'wakeup',
        summary: 'wait for external CI',
        evidence: [],
        source: 'loop-control-cli',
        createdAt: 1_700_000_000_000,
        receivedAt: 1_700_000_000_100,
        status: 'accepted',
        resumeAt: 1_700_000_060_000,
      });

      expect(parsed.resumeAt).toBe(1_700_000_060_000);
    });
  });

  describe('Task 18 queue kind + drainMode', () => {
    it('LoopInterveneePayloadSchema accepts a follow-up + one-at-a-time drainMode', () => {
      const parsed = LoopInterveneePayloadSchema.parse({
        loopRunId: 'loop-1',
        message: 'run this before you finish',
        kind: 'follow-up',
        drainMode: 'one-at-a-time',
      });
      expect(parsed.kind).toBe('follow-up');
      expect(parsed.drainMode).toBe('one-at-a-time');
    });

    it('LoopInterveneePayloadSchema rejects an unknown drainMode', () => {
      expect(
        LoopInterveneePayloadSchema.safeParse({ loopRunId: 'l', message: 'm', drainMode: 'bogus' }).success,
      ).toBe(false);
    });

    it('LoopPendingInputSchema round-trips drainMode', () => {
      const parsed = LoopPendingInputSchema.parse({
        id: 'p1',
        kind: 'follow-up',
        message: 'later',
        enqueuedAt: 0,
        source: 'human',
        drainMode: 'one-at-a-time',
      });
      expect(parsed.drainMode).toBe('one-at-a-time');
      // Absent drainMode stays absent (treated as `all` by the drain).
      const noDrain = LoopPendingInputSchema.parse({ id: 'p2', kind: 'queue', message: 'x', enqueuedAt: 0, source: 'human' });
      expect(noDrain.drainMode).toBeUndefined();
    });
  });
});
