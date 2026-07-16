import { describe, it, expect } from 'vitest';
import {
  LoopCompletionConfigSchema,
  LoopConfigSchema,
  LoopCrossModelReviewConfigSchema,
  LoopHardCapsSchema,
  LoopInterveneePayloadSchema,
  LoopContextWindowCalibrationSchema,
  LoopPendingInputSchema,
  LoopIterationSchema,
  ProgressSignalEvidenceSchema,
  LoopTerminalIntentSchema,
  LoopReviewSeveritySchema,
  LoopStartPayloadSchema,
  LoopStateSchema,
  LoopPhase4ConfigSchema,
} from '../loop.schemas';

/**
 * Schema-vs-type drift regression guards for `LoopCompletionConfig` and
 * related fields. Each test guards a specific drift that has actually
 * happened in this repo — keep them named accordingly so future drift is
 * easy to attribute.
 */
describe('Loop schemas — type/schema drift guards', () => {
  const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

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

  describe('ProgressSignalEvidenceSchema', () => {
    it('accepts Workstream E signal I for idempotent read identity', () => {
      const parsed = ProgressSignalEvidenceSchema.parse({
        id: 'I',
        verdict: 'WARN',
        message: 'Read returned the same result repeatedly',
        detail: { repeatCount: 3 },
      });

      expect(parsed.id).toBe('I');
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

    it('round-trips WS2 openLeafIds and keeps them optional (back-compat)', () => {
      const parsed = LoopIterationSchema.parse({
        ...baseIteration,
        completionSignalsFired: [
          { id: 'ledger-complete', sufficient: false, detail: 'open', openCount: 2, openLeafIds: ['ws4.a', 'lf-0123456789ab'] },
          { id: 'ledger-complete', sufficient: true, detail: 'legacy row without ids', openCount: 0 },
        ],
      });
      expect(parsed.completionSignalsFired[0].openLeafIds).toEqual(['ws4.a', 'lf-0123456789ab']);
      expect(parsed.completionSignalsFired[1].openLeafIds).toBeUndefined();
    });
  });

  describe('LoopContextWindowCalibrationSchema model', () => {
    it('accepts model ids up to the dynamic catalog limit', () => {
      expect(maxCatalogModelId).toHaveLength(512);

      expect(LoopContextWindowCalibrationSchema.safeParse({
        provider: 'claude',
        model: maxCatalogModelId,
        windowTokens: 200_000,
        calibratedAt: 1,
        source: 'provider-error',
        reason: 'provider reported limit',
      }).success).toBe(true);
    });

    it('rejects model ids beyond the dynamic catalog limit', () => {
      expect(tooLongCatalogModelId).toHaveLength(513);

      expect(LoopContextWindowCalibrationSchema.safeParse({
        provider: 'claude',
        model: tooLongCatalogModelId,
        windowTokens: 200_000,
        calibratedAt: 1,
        source: 'provider-error',
        reason: 'provider reported limit',
      }).success).toBe(false);
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

    it('accepts an OLD checkpoint with only the legacy count fields (WS2 back-compat)', () => {
      // Pre-WS2 rows carry the two counters and no ledgerConvergence tracker.
      const parsed = LoopStateSchema.parse({
        ...baseState,
        ledgerOpenCountBest: 4,
        ledgerNoImprovementIterations: 8,
      });
      expect(parsed.ledgerConvergence).toBeUndefined();
    });

    it('round-trips the WS2 ledgerConvergence tracker', () => {
      const tracker = {
        version: 1 as const,
        knownTaskStates: { 'ws4.a': 'done' as const, 'ws4.b': 'todo' as const },
        plannedLeafIds: ['ws4.a', 'ws4.b'],
        discoveredLeafIds: ['ws5.c'],
        noMeaningfulTransitionIterations: 2,
        lastObjectiveEvidenceKey: 'verify-pass:abc',
      };
      const parsed = LoopStateSchema.parse({ ...baseState, ledgerConvergence: tracker });
      expect(parsed.ledgerConvergence).toEqual(tracker);
    });

    it('rejects a ledgerConvergence tracker with an unknown task state', () => {
      expect(LoopStateSchema.safeParse({
        ...baseState,
        ledgerConvergence: {
          version: 1,
          knownTaskStates: { 'ws4.a': 'finished' },
          plannedLeafIds: [],
          discoveredLeafIds: [],
          noMeaningfulTransitionIterations: 0,
        },
      }).success).toBe(false);
    });

    it('round-trips justCompacted (B5 canary flag)', () => {
      const parsed = LoopStateSchema.parse({
        ...baseState,
        justCompacted: { seq: 7, reason: 'utilization recycle' },
      });
      expect(parsed.justCompacted).toEqual({ seq: 7, reason: 'utilization recycle' });
    });

    it('round-trips contextWindowCalibration (B6 provider window learning)', () => {
      const parsed = LoopStateSchema.parse({
        ...baseState,
        contextWindowCalibration: {
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          windowTokens: 1_000_000,
          calibratedAt: 1234,
          source: 'provider-error',
          reason: 'provider reported maximum context length',
        },
      });

      expect(parsed.contextWindowCalibration).toEqual({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        windowTokens: 1_000_000,
        calibratedAt: 1234,
        source: 'provider-error',
        reason: 'provider reported maximum context length',
      });
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

  describe('LoopIterationSchema invoker-capture fields', () => {
    it('round-trips finishReason, unresolvedToolCalls, filesRead, and tool result hashes', () => {
      const parsed = LoopIterationSchema.parse({
        id: 'iter-capture',
        loopRunId: 'loop-1',
        seq: 0,
        stage: 'IMPLEMENT',
        startedAt: 1,
        endedAt: 2,
        childInstanceId: null,
        tokens: 0,
        costCents: 0,
        filesChanged: [],
        filesRead: ['src/input.ts'],
        toolCalls: [{
          toolName: 'Read',
          argsHash: 'args-hash',
          resultHash: 'result-hash',
          success: true,
          durationMs: 3,
        }],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        finishReason: 'tool_use',
        unresolvedToolCalls: true,
        workHash: 'hash',
        outputSimilarityToPrev: null,
        outputExcerpt: '',
        outputFull: '',
        progressVerdict: 'OK',
        progressSignals: [],
        completionSignalsFired: [],
        verifyStatus: 'not-run',
        verifyOutputExcerpt: '',
      });

      expect(parsed.finishReason).toBe('tool_use');
      expect(parsed.unresolvedToolCalls).toBe(true);
      expect(parsed.filesRead).toEqual(['src/input.ts']);
      expect(parsed.toolCalls[0]?.resultHash).toBe('result-hash');
    });

    it('defaults legacy invoker-capture fields for pre-migration iterations', () => {
      const parsed = LoopIterationSchema.parse({
        id: 'iter-legacy',
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
        verifyStatus: 'not-run',
        verifyOutputExcerpt: '',
      });

      expect(parsed.finishReason).toBeUndefined();
      expect(parsed.unresolvedToolCalls).toBe(false);
      expect(parsed.filesRead).toEqual([]);
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

    it('accepts conservative Phase 4 opt-in gates', () => {
      const parsed = LoopConfigSchema.parse({
        ...baseConfig,
        phase4: {
          commitRatchet: {
            enabled: true,
            worktreeOnly: true,
            keepPolicy: 'score-improvement',
            resetOnRegression: true,
          },
          freshSessionPerIteration: { enabled: true },
          subagentContracts: {
            enabled: true,
            maxDepth: 1,
            requireNonOverlappingWriteScopes: true,
          },
          toolRwLocks: { enabled: true },
        },
      });

      expect(parsed.phase4?.commitRatchet.enabled).toBe(true);
      expect(parsed.phase4?.freshSessionPerIteration.enabled).toBe(true);
      expect(parsed.phase4?.subagentContracts.requireNonOverlappingWriteScopes).toBe(true);
      expect(parsed.phase4?.toolRwLocks.enabled).toBe(true);
    });

    it('defaults each Phase 4 gate off unless explicitly enabled', () => {
      const parsed = LoopPhase4ConfigSchema.parse({});

      expect(parsed.commitRatchet.enabled).toBe(false);
      expect(parsed.freshSessionPerIteration.enabled).toBe(false);
      expect(parsed.subagentContracts.enabled).toBe(false);
      expect(parsed.toolRwLocks.enabled).toBe(false);
    });

    it('accepts partial nested Phase 4 gate objects and fills safe defaults', () => {
      const parsed = LoopPhase4ConfigSchema.parse({
        commitRatchet: { enabled: true },
        subagentContracts: { enabled: true },
      });

      expect(parsed.commitRatchet).toEqual({
        enabled: true,
        worktreeOnly: true,
        keepPolicy: 'score-improvement',
        resetOnRegression: true,
      });
      expect(parsed.subagentContracts).toEqual({
        enabled: true,
        maxDepth: 1,
        requireNonOverlappingWriteScopes: true,
      });
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
