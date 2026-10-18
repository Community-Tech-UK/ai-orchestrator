import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopStage } from '../../shared/types/loop.types';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { cleanupLoopCoordinatorSpec } from './loop-coordinator-test-cleanup';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';

// Keep app settings and provider/model discovery outside the fixture. Stage
// reads, prompt selection, thread proof and the child-invocation event are real.
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      defaultCli: 'claude', loopModelByProvider: {},
      auxiliaryLlmRoutingClassificationEnabled: false, loopSurfaceLessons: false,
    }),
    get: () => undefined,
  }),
}));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('./invocation-model-resolver', () => ({ resolveLoopChildModel: async () => 'test-model' }));

const GOAL = 'Implement the requested scheduling changes';
const PARENT_REPLAY = 'Parent conversation background fixture';
const THREAD_CAPS = { supportsResume: true, sameThreadContinuation: true, model: 'test-model' };

interface CapturedTurn {
  prompt: string;
  stage: LoopStage;
  reset: boolean;
  anchorSeq: number | undefined;
}

describe('LoopCoordinator stage-transition goal re-anchor', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    coordinator = new LoopCoordinator();
    coordinator.setContextSurvivalManager(null);
    coordinator.setLoopMemoryStore({ recordLearning: () => undefined, surfaceLearnings: () => [] });
    workspace = mkdtempSync(join(tmpdir(), 'loop-stage-anchor-'));
  });

  afterEach(async () => {
    await cleanupLoopCoordinatorSpec({ coordinator, workspace });
  }, 20_000);

  async function runThreeTurns(compactionEnabled: boolean, transition: boolean): Promise<CapturedTurn[]> {
    const turns: CapturedTurn[] = [];
    const lastSealed = new Promise<void>((resolve) => {
      coordinator.on('loop:iteration-complete', (payload: { loopRunId: string; seq: number }) => {
        if (payload.seq === 2) {
          coordinator.pauseLoop(payload.loopRunId);
          resolve();
        }
      });
    });
    coordinator.on('loop:invoke-iteration', (unknownPayload: unknown) => {
      const payload = unknownPayload as {
        loopRunId: string; seq: number; stage: LoopStage; prompt: string;
        forceContextReset: boolean; callback(result: LoopChildResult): void;
      };
      const state = coordinator.getLoop(payload.loopRunId)!;
      turns[payload.seq] = {
        prompt: payload.prompt, stage: payload.stage, reset: payload.forceContextReset,
        anchorSeq: state.lastFullAnchorSeq,
      };
      if (payload.seq === 0 && transition) {
        writeFileSync(resolveLoopArtifactPaths(workspace, payload.loopRunId).stage, 'IMPLEMENT\n');
      }
      queueMicrotask(() => payload.callback({
        childInstanceId: null,
        output: `Changed unique scheduling module ${payload.seq} and ran its focused check ${payload.seq * 19}.`,
        tokens: 1,
        filesChanged: [{ path: `src/progress-${payload.seq}.ts`, additions: 1, deletions: 0, contentHash: `hash-${payload.seq}` }],
        toolCalls: [], errors: [], testPassCount: payload.seq + 1, testFailCount: null,
        exitedCleanly: true, threadCaps: THREAD_CAPS,
      }));
    });
    const config = defaultLoopConfig(workspace, GOAL);
    config.initialStage = 'PLAN';
    config.contextStrategy = 'same-session';
    config.context!.compaction.enabled = compactionEnabled;
    config.caps.maxIterations = 5;
    config.completion.verifyCommand = '';
    const started = await coordinator.startLoop('chat-stage-anchor', config, undefined, {
      existingSessionContext: PARENT_REPLAY,
    });
    await lastSealed;
    expect(coordinator.getLoop(started.id)?.totalIterations).toBe(3);
    expect(coordinator.getLoop(started.id)?.config.context?.compaction.enabled).toBe(compactionEnabled);
    expect(coordinator.getLoop(started.id)?.lastThreadCaps).toEqual(THREAD_CAPS);
    return turns;
  }

  it.each([false, true])('re-anchors PLAN→IMPLEMENT while preserving compaction enabled=%s', async (enabled) => {
    const turns = await runThreeTurns(enabled, true);
    expect(turns.map((turn) => turn.stage)).toEqual(['PLAN', 'IMPLEMENT', 'IMPLEMENT']);
    for (const seq of [0, 1]) {
      expect(turns[seq].prompt).toContain('Goal (persistent across iterations)');
      expect(turns[seq].prompt).toContain(GOAL);
      expect(turns[seq].prompt).toContain('Loop Terminal Control:');
      expect(turns[seq].prompt).not.toContain('# Loop Mode — Continuation');
    }
    expect(turns.map((turn) => turn.reset)).toEqual([false, enabled, false]);
    expect(turns.map((turn) => turn.anchorSeq)).toEqual([0, 1, 1]);
    expect(turns[0].prompt).toContain(PARENT_REPLAY);
    expect(turns[1].prompt.includes(PARENT_REPLAY)).toBe(enabled);
    expect(turns[2].prompt).toContain('# Loop Mode — Continuation');
    expect(turns[2].prompt).not.toContain('Goal (persistent across iterations)');
    expect(turns[2].prompt).not.toContain('Loop Terminal Control:');
    expect(turns[2].prompt).not.toContain(PARENT_REPLAY);
  }, 20_000);

  it.each([false, true])('keeps ordinary same-thread PLAN continuation with compaction enabled=%s', async (enabled) => {
    const turns = await runThreeTurns(enabled, false);
    expect(turns.map((turn) => turn.stage)).toEqual(['PLAN', 'PLAN', 'PLAN']);
    expect(turns.map((turn) => turn.reset)).toEqual([false, false, false]);
    expect(turns.map((turn) => turn.anchorSeq)).toEqual([0, 0, 0]);
    for (const turn of turns.slice(1)) {
      expect(turn.prompt).toContain('# Loop Mode — Continuation');
      expect(turn.prompt).not.toContain('Goal (persistent across iterations)');
      expect(turn.prompt).not.toContain('Loop Terminal Control:');
      expect(turn.prompt).not.toContain(PARENT_REPLAY);
    }
  }, 20_000);
});
