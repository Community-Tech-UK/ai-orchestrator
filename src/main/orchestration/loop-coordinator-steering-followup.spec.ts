import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { passingVerifyCommand } from './loop-test-commands';

function childResult(seq: number): LoopChildResult {
  return {
    childInstanceId: null,
    output: `progress ${seq}`,
    tokens: 1,
    filesChanged: [{ path: `src/progress-${seq}.ts`, additions: 1, deletions: 0, contentHash: `hash-${seq}` }],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('LoopCoordinator — Pi Task 18 steering downgrade + follow-up drain', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    coordinator = new LoopCoordinator();
    workspace = mkdtempSync(join(tmpdir(), 'loop-steering-followup-'));
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  it('Task 18: emits loop:state-changed after an intervene so the queue is persisted immediately', async () => {
    const stateChanges: Array<{ loopRunId: string; state: { pendingInterventions: Array<{ message: string; kind: string; drainMode?: string }> } }> = [];

    const firstInvoke = new Promise<void>((resolve) => {
      let started = false;
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as { seq: number; callback: (r: LoopChildResult) => void };
        if (p.seq === 0 && !started) { started = true; resolve(); }
        queueMicrotask(() => p.callback(childResult(p.seq)));
      });
    });

    const config = defaultLoopConfig(workspace, 'keep running');
    config.caps.maxIterations = 50;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 1000;
    config.completion.verifyCommand = '';

    const state = await coordinator.startLoop('chat-persist', config);
    await firstInvoke;

    // Only start listening after startup so we isolate the intervene's emission.
    coordinator.on('loop:state-changed', (d: unknown) => stateChanges.push(d as (typeof stateChanges)[number]));
    const ok = coordinator.intervene(state.id, 'check the edge case', 'follow-up', 'one-at-a-time');
    expect(ok).toBe(true);

    const withQueued = stateChanges.find((c) =>
      c.state.pendingInterventions.some((i) => i.message === 'check the edge case'),
    );
    expect(withQueued).toBeDefined();
    const queued = withQueued!.state.pendingInterventions.find((i) => i.message === 'check the edge case')!;
    expect(queued.kind).toBe('follow-up');
    expect(queued.drainMode).toBe('one-at-a-time');

    await coordinator.cancelLoop(state.id);
  }, 20_000);

  it('Task 18: a one-at-a-time follow-up drains a single message per completion seam', async () => {
    const drained: Array<{ count: number; remaining: number }> = [];
    coordinator.on('loop:follow-up-drained', (d: unknown) => drained.push(d as { count: number; remaining: number }));

    let queuedTwo = false;
    const completed = new Promise<void>((resolve) => {
      coordinator.on('loop:completed', () => resolve());
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; loopRunId: string; workspaceCwd: string; callback: (r: LoopChildResult) => void };
      const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
      if (p.seq === 0 && !queuedTwo) {
        // Queue two one-at-a-time follow-ups during iteration 0.
        coordinator.intervene(p.loopRunId, 'first-check', 'follow-up', 'one-at-a-time');
        coordinator.intervene(p.loopRunId, 'second-check', 'follow-up', 'one-at-a-time');
        queuedTwo = true;
      }
      queueMicrotask(() => p.callback(childResult(p.seq)));
    });

    const config = defaultLoopConfig(workspace, 'finish after two sequential follow-ups');
    config.caps.maxIterations = 8;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 1000;
    config.completion.verifyCommand = passingVerifyCommand();
    config.completion.runVerifyTwice = false;
    config.completion.requireCompletedFileRename = false;

    const stateRun = await coordinator.startLoop('chat-oat', config);
    await completed;

    // Each follow-up drained on a separate completion seam (count 1 each), not all at once.
    expect(drained.length).toBeGreaterThanOrEqual(2);
    expect(drained.every((d) => d.count === 1)).toBe(true);
    // The first drain deferred the remaining one; the later drain leaves none.
    expect(drained[0].remaining).toBe(1);
    expect(drained[drained.length - 1].remaining).toBe(0);
    expect(coordinator.getLoop(stateRun.id)?.status).toBe('completed');
  }, 20_000);

  it('downgrades a steer intervention to next-iteration and surfaces the downgrade', async () => {
    const downgrades: unknown[] = [];
    coordinator.on('loop:steering-downgraded', (d: unknown) => downgrades.push(d));

    let started = false;
    const firstInvoke = new Promise<void>((resolve) => {
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as { seq: number; callback: (r: LoopChildResult) => void };
        if (p.seq === 0 && !started) {
          started = true;
          resolve();
        }
        // Never complete — keep the loop running so we can intervene.
        queueMicrotask(() => p.callback(childResult(p.seq)));
      });
    });

    const config = defaultLoopConfig(workspace, 'keep running');
    config.caps.maxIterations = 50;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 1000;
    config.completion.verifyCommand = '';

    const state = await coordinator.startLoop('chat-steer', config);
    await firstInvoke;

    const ok = coordinator.intervene(state.id, 'change direction now', 'steer');
    expect(ok).toBe(true);

    const queued = coordinator.getLoop(state.id)?.pendingInterventions ?? [];
    expect(queued.length).toBeGreaterThanOrEqual(1);
    // Stored as next-iteration (queue), not steer.
    expect(queued.every((i) => i.kind !== 'steer')).toBe(true);
    expect(queued.some((i) => i.message === 'change direction now' && i.kind === 'queue')).toBe(true);
    expect(downgrades).toHaveLength(1);
    expect(downgrades[0]).toMatchObject({ requestedKind: 'steer', effectiveKind: 'queue' });

    await coordinator.cancelLoop(state.id);
  }, 20_000);

  it('does not downgrade a steer intervention when live steering is supported', async () => {
    const downgrades: unknown[] = [];
    coordinator.on('loop:steering-downgraded', (d: unknown) => downgrades.push(d));
    coordinator.setLiveSteeringSupported(true);

    const firstInvoke = new Promise<void>((resolve) => {
      let started = false;
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as { seq: number; callback: (r: LoopChildResult) => void };
        if (p.seq === 0 && !started) {
          started = true;
          resolve();
        }
        queueMicrotask(() => p.callback(childResult(p.seq)));
      });
    });

    const config = defaultLoopConfig(workspace, 'keep running');
    config.caps.maxIterations = 50;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 1000;
    config.completion.verifyCommand = '';

    const state = await coordinator.startLoop('chat-steer-live', config);
    await firstInvoke;

    coordinator.intervene(state.id, 'steer live', 'steer');
    const queued = coordinator.getLoop(state.id)?.pendingInterventions ?? [];
    expect(queued.some((i) => i.message === 'steer live' && i.kind === 'steer')).toBe(true);
    expect(downgrades).toHaveLength(0);

    await coordinator.cancelLoop(state.id);
  }, 20_000);

  it('defers a would-be completion to run queued follow-up messages first', async () => {
    const drained: unknown[] = [];
    coordinator.on('loop:follow-up-drained', (d: unknown) => drained.push(d));

    let followUpQueued = false;
    const seqOnePrompt = new Promise<string>((resolve) => {
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as {
          seq: number;
          prompt: string;
          loopRunId: string;
          workspaceCwd: string;
          callback: (r: LoopChildResult) => void;
        };
        // Write DONE.txt so every iteration would otherwise complete.
        const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
        if (p.seq === 0) {
          // Queue a follow-up during iteration 0 so it is present at the seam.
          if (!followUpQueued) {
            followUpQueued = coordinator.intervene(p.loopRunId, 'also check the edge case', 'follow-up');
          }
          queueMicrotask(() => p.callback(childResult(p.seq)));
          return;
        }
        if (p.seq === 1) {
          resolve(p.prompt);
        }
        queueMicrotask(() => p.callback(childResult(p.seq)));
      });
    });

    const config = defaultLoopConfig(workspace, 'finish but with a follow-up');
    config.caps.maxIterations = 5;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 1000;
    config.completion.verifyCommand = passingVerifyCommand();
    config.completion.runVerifyTwice = false;
    config.completion.requireCompletedFileRename = false;

    const state = await coordinator.startLoop('chat-followup', config);
    const prompt = await seqOnePrompt;
    await coordinator.cancelLoop(state.id);

    // The follow-up deferred completion and re-queued as a next-iteration hint.
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ count: 1 });
    expect(prompt).toContain('also check the edge case');
  }, 20_000);

  it('D5: vetoes a would-be completion when the agent self-declares more work remaining', async () => {
    const vetoes: unknown[] = [];
    coordinator.on('loop:more-work-declared', (d: unknown) => vetoes.push(d));

    const completed = new Promise<void>((resolve) => {
      coordinator.on('loop:completed', () => resolve());
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        seq: number;
        loopRunId: string;
        workspaceCwd: string;
        callback: (r: LoopChildResult) => void;
      };
      // DONE.txt exists every iteration → a forensic completion signal fires.
      const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
      const r = childResult(p.seq);
      // Seq 0 declares more work remaining → completion vetoed; seq 1 does not → completes.
      if (p.seq === 0) r.output = `${r.output}\n[[LOOP:MORE_WORK_REMAINING]]`;
      queueMicrotask(() => p.callback(r));
    });

    const config = defaultLoopConfig(workspace, 'finish unless more work declared');
    config.caps.maxIterations = 5;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 1000;
    config.completion.verifyCommand = passingVerifyCommand();
    config.completion.runVerifyTwice = false;
    config.completion.requireCompletedFileRename = false;

    const state = await coordinator.startLoop('chat-more-work', config);
    await completed;

    // Completion was vetoed exactly once (seq 0), then accepted at seq 1.
    expect(vetoes).toHaveLength(1);
    expect(vetoes[0]).toMatchObject({ seq: 0 });
    expect(coordinator.getLoop(state.id)?.status).toBe('completed');
    expect(coordinator.getLoop(state.id)?.totalIterations).toBeGreaterThanOrEqual(2);
  }, 20_000);
});
