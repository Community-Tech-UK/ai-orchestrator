/**
 * LF-5 (loopfixex.md) — coordinator wiring for branch-and-select.
 *
 * Verifies that on a CRITICAL no-progress, when exploration is enabled + a cost
 * cap is set, the coordinator invokes the (injected) branch selector before
 * pausing — and that with exploration off the selector is never touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { passingVerifyCommand } from './loop-test-commands';
import { defaultLoopConfig } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-branch-coord-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

// Identical, empty iterations → identical work hash → no-progress CRITICAL.
function noProgressResult(): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'working...',
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

function startConfig(enabled: boolean) {
  const base = defaultLoopConfig(workspace, 'do the thing');
  return {
    initialPrompt: 'do the thing',
    workspaceCwd: workspace,
    completion: { ...base.completion, verifyCommand: passingVerifyCommand() },
    caps: { ...base.caps, maxCostCents: 1000, maxWallTimeMs: 60_000 },
    exploration: { enabled, fanout: 3, crossModel: false, selector: 'verify+listwise' as const },
    progressThresholds: {
      ...base.progressThresholds,
      identicalHashWarnConsecutive: 2,
      identicalHashCriticalConsecutive: 2,
    },
  };
}

describe('LoopCoordinator branch-select wiring (LF-5)', () => {
  it('invokes the branch selector on CRITICAL when exploration is enabled', async () => {
    const selector = vi.fn(async () => ({ adopted: false, reason: 'stub: no winner', candidateCount: 3 }));
    coordinator.setBranchSelector(selector);

    let branchEvent: { adopted: boolean; reason: string } | null = null;
    coordinator.on('loop:branch-select', (p: unknown) => { branchEvent = p as { adopted: boolean; reason: string }; });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback(noProgressResult()));
    });

    const state = await coordinator.startLoop('chat-branch-on', startConfig(true));

    for (let i = 0; i < 120 && !branchEvent; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(selector).toHaveBeenCalled();
    expect(branchEvent).not.toBeNull();
    expect(branchEvent!.adopted).toBe(false);
    // selector input carried the gating context
    expect(selector.mock.calls[0][0]).toMatchObject({ loopRunId: state.id, exploration: { enabled: true } });
  });

  it('never invokes the branch selector when exploration is disabled', async () => {
    const selector = vi.fn(async () => ({ adopted: false, reason: 'should-not-be-called', candidateCount: 0 }));
    coordinator.setBranchSelector(selector);

    let pausedNoProgress = false;
    coordinator.on('loop:paused-no-progress', () => { pausedNoProgress = true; });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback(noProgressResult()));
    });

    await coordinator.startLoop('chat-branch-off', startConfig(false));

    for (let i = 0; i < 120 && !pausedNoProgress; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(pausedNoProgress).toBe(true);
    expect(selector).not.toHaveBeenCalled();
  });
});
