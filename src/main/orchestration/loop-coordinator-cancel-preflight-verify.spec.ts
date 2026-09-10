/**
 * LT-350 — cancelling a loop must kill an in-flight preflight/quick-verify
 * subprocess, not just the (nonexistent, at that point) CLI adapter/instance.
 *
 * Reproduced live: a loop cancelled before iteration 0 (while
 * `runLoopPreflight` was still awaiting its verify child) left the spawned
 * process running to completion, unsupervised, well after the loop reported
 * `cancelled`. See `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`
 * (LT-350) and the register entry it links to.
 */
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { LoopCoordinator } from './loop-coordinator';
import { cleanupLoopCoordinatorSpec } from './loop-coordinator-test-cleanup';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-cancel-preflight-'));
  LoopCoordinator._resetForTesting();
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  await cleanupLoopCoordinatorSpec({ coordinator, workspace });
}, 20_000);

describe('LT-350: cancelLoop kills an in-flight preflight verify subprocess', () => {
  it('kills the verify child instead of letting it run to completion after cancel', async () => {
    const markerPath = join(workspace, 'verify-completed-marker');
    // A real script file, not an inline `-e` one-liner, so no shell/JS
    // nested-quoting hazards around the marker path.
    const scriptPath = join(workspace, 'slow-verify.js');
    writeFileSync(
      scriptPath,
      `setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(markerPath)}, '1'); }, 4000);\n`,
    );
    const node = process.execPath;
    const base = defaultLoopConfig(workspace, 'cancel me during preflight');

    const state = await coordinator.startLoop('chat-cancel-preflight', {
      initialPrompt: 'irrelevant — cancelled before any iteration runs',
      workspaceCwd: workspace,
      caps: { ...base.caps, maxIterations: 5 },
      audit: { ...base.audit, preflightMode: 'block' },
      completion: {
        ...base.completion,
        verifyCommand: `"${node}" "${scriptPath}"`,
        verifyTimeoutMs: 30_000,
      },
    });

    // Give the preflight's verify child a moment to actually spawn before
    // cancelling — cancelling before spawn would trivially pass this test
    // for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const cancelled = await coordinator.cancelLoop(state.id);
    expect(cancelled).toBe(true);

    const live = coordinator.getLoop(state.id);
    expect(live?.status).toBe('cancelled');

    // Wait past the script's own 4s sleep. Without the LT-350 fix, the
    // orphaned verify child keeps running and drops the marker anyway.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(existsSync(markerPath)).toBe(false);
  }, 20_000);
});
