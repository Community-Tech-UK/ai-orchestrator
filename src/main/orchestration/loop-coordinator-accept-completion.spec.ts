/**
 * LF-7 (loopfixex §12.2 #1) — operator accept-completion.
 *
 * A loop with no verify command and `allowOperatorReviewedCompletion` was a
 * half-built feature: it paused for human sign-off, but the UI exposed no way
 * to give it, so the loop could never reach `completed` from a paused state.
 * `acceptCompletion` is the missing action: it runs verify if one is
 * configured (pass → `completed`, fail → stays paused) and otherwise lands
 * `completed-needs-review`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';

/**
 * Write a loop-state file (e.g. DONE.txt) into the run's per-run state dir —
 * loop state is scoped under .aio-loop-state/<runId>/, not the workspace root.
 * The invoke-iteration payload carries loopRunId + workspaceCwd.
 */
function writeRunState(payload: unknown, name: string, content: string): void {
  const p = payload as { loopRunId: string; workspaceCwd: string };
  const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(loopStateFile(paths, name), content);
}

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-accept-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  // Cancel every loop still live on this coordinator (the "not paused" test
  // deliberately hangs an iteration, so its loop must be force-cancelled by id,
  // not chatId) before tearing down the workspace dir.
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function claimsDone(): LoopChildResult {
  return {
    childInstanceId: null,
    output: '<promise>DONE</promise>\nTASK COMPLETE',
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

function liveState(id: string): (LoopState & { lastCompletionOutcome?: string }) | undefined {
  return (coordinator as unknown as { active: Map<string, LoopState> }).active.get(id);
}

async function waitForStatus(id: string, status: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (liveState(id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Start a manual-review loop (no verify command) that declares done each
 *  iteration so it pauses for operator review. */
async function startManualReviewLoop(): Promise<LoopState> {
  coordinator.on('loop:invoke-iteration', (payload: unknown) => {
    const p = payload as { callback: (r: LoopChildResult) => void };
    writeRunState(payload, 'DONE.txt', 'done\n');
    queueMicrotask(() => p.callback(claimsDone()));
  });
  const state = await coordinator.startLoop('chat-accept', {
    initialPrompt: 'do the thing',
    workspaceCwd: workspace,
    completion: {
      ...defaultLoopConfig(workspace, 'x').completion,
      verifyCommand: '', // manual-review only
    },
    caps: { ...defaultLoopConfig(workspace, 'x').caps, maxCostCents: 100 },
  });
  await waitForStatus(state.id, 'paused');
  return state;
}

describe('LoopCoordinator.acceptCompletion (LF-7)', () => {
  it('accepts a paused manual-review loop → completed-needs-review', async () => {
    let needsReview: { acceptedByOperator?: boolean } | null = null;
    coordinator.on('loop:completed-needs-review', (p: unknown) => {
      needsReview = p as { acceptedByOperator?: boolean };
    });

    const state = await startManualReviewLoop();
    expect(liveState(state.id)?.status).toBe('paused');
    expect(liveState(state.id)?.manualReviewOnly).toBe(true);

    const ok = await coordinator.acceptCompletion(state.id);

    expect(ok).toBe(true);
    expect(liveState(state.id)?.status).toBe('completed-needs-review');
    expect(liveState(state.id)?.lastCompletionOutcome).toBe('accepted');
    expect(needsReview).not.toBeNull();
    expect(needsReview!.acceptedByOperator).toBe(true);
  });

  it('returns false when the loop is not paused', async () => {
    // Hang the iteration so the loop stays 'running'.
    coordinator.on('loop:invoke-iteration', () => { /* never call back */ });
    const state = await coordinator.startLoop('chat-accept', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...defaultLoopConfig(workspace, 'x').completion, verifyCommand: '' },
    });

    expect(liveState(state.id)?.status).toBe('running');
    const ok = await coordinator.acceptCompletion(state.id);
    expect(ok).toBe(false);
    expect(liveState(state.id)?.status).toBe('running');
  });

  it('returns false when a manual-review loop is paused before any completion attempt', async () => {
    // Hang the first iteration, then manually pause the loop before it has
    // emitted any DONE evidence. Manual-review-only is a startup capability,
    // not proof that the work is ready for operator sign-off.
    coordinator.on('loop:invoke-iteration', () => { /* never call back */ });
    const state = await coordinator.startLoop('chat-accept-premature', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...defaultLoopConfig(workspace, 'x').completion, verifyCommand: '' },
    });

    expect(coordinator.pauseLoop(state.id)).toBe(true);
    expect(liveState(state.id)?.status).toBe('paused');
    expect(liveState(state.id)?.lastCompletionOutcome).toBeUndefined();

    const ok = await coordinator.acceptCompletion(state.id);

    expect(ok).toBe(false);
    expect(liveState(state.id)?.status).toBe('paused');
    expect(liveState(state.id)?.lastCompletionOutcome).toBeUndefined();
  });

  it('runs verify on accept and terminates completed when it passes', async () => {
    let completed: { acceptedByOperator?: boolean } | null = null;
    coordinator.on('loop:completed', (p: unknown) => {
      completed = p as { acceptedByOperator?: boolean };
    });

    const state = await startManualReviewLoop();
    // Operator configured a verify command after the fact; accept now runs it.
    liveState(state.id)!.config.completion.verifyCommand = 'true';

    const ok = await coordinator.acceptCompletion(state.id);

    expect(ok).toBe(true);
    expect(liveState(state.id)?.status).toBe('completed');
    expect(completed).not.toBeNull();
    expect(completed!.acceptedByOperator).toBe(true);
  });

  it('rejects accept and stays paused when verify fails', async () => {
    const state = await startManualReviewLoop();
    liveState(state.id)!.config.completion.verifyCommand = 'false'; // exits non-zero

    const ok = await coordinator.acceptCompletion(state.id);

    expect(ok).toBe(false);
    expect(liveState(state.id)?.status).toBe('paused');
    expect(liveState(state.id)?.lastCompletionOutcome).toBe('verify-failed');
  });

  it('rejects operator accept when final audit gate finds open ledger items', async () => {
    const state = await startManualReviewLoop();
    const live = liveState(state.id)!;
    const paths = resolveLoopArtifactPaths(workspace, state.id);
    writeFileSync(paths.tasks, '# Loop Tasks\n\n- [ ] finish the actual work\n');
    live.config.completion.verifyCommand = 'true';
    live.config.audit.finalAuditMode = 'gate';

    const ok = await coordinator.acceptCompletion(state.id);

    expect(ok).toBe(false);
    expect(liveState(state.id)?.status).toBe('paused');
    expect(liveState(state.id)?.lastCompletionOutcome).toBe('review-blocked');
    expect(liveState(state.id)?.latestFinalAudit?.status).toBe('failed');
    expect(liveState(state.id)?.pendingInterventions.at(-1)?.message).toContain('final audit');
    expect(existsSync(paths.audit)).toBe(true);
    expect(readFileSync(paths.audit, 'utf8')).toContain('ledger-open');
  });
});
