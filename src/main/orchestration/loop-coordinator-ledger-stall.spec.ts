/**
 * Regression: ledger-progress stall terminal.
 *
 * Repro of loop-1782864004679 — a review-driven loop that made a real
 * production file change every iteration (so the file-churn stall guard reset
 * each round) while its LOOP_TASKS.md open-count never reached a new low. The
 * old guard never tripped and the loop spun to the iteration cap. The new
 * ledger-progress backstop stops it as `completed-needs-review` after
 * `maxLedgerStallIterations` iterations without a new ledger low — even though
 * files change every round.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { mkdirSync } from 'node:fs';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';

function writeRunState(payload: unknown, name: string, content: string): void {
  const p = payload as { loopRunId: string; workspaceCwd: string };
  const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(loopStateFile(paths, name), content);
}

let workspace: string;
let coordinator: LoopCoordinator;

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: workspace,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-ledger-stall-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'app.js'), 'const x = 0;\n');
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed']);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  try { await coordinator.cancelLoop(coordinator.getActiveLoops()[0]?.id ?? ''); } catch { /* noop */ }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator ledger-progress stall backstop', () => {
  it('stops as completed-needs-review when the ledger open-count never improves, despite file changes every round', async () => {
    let iterations = 0;

    // Every iteration: make a REAL production change (resets the file-churn
    // guard) and re-write LOOP_TASKS.md keeping the SAME open item (open-count
    // never reaches a new low).
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; callback: (r: LoopChildResult) => void };
      iterations = p.seq + 1;
      writeFileSync(join(workspace, 'app.js'), `const x = ${p.seq + 1};\n`);
      writeRunState(
        payload,
        'LOOP_TASKS.md',
        '# Loop Tasks\n- [x] Done item\n- [ ] Continue remaining slices per the spec\n',
      );
      queueMicrotask(() =>
        p.callback({
          childInstanceId: null,
          output: `iteration ${p.seq}: still working the ledger, more slices remain.`,
          tokens: 1,
          filesChanged: [{ path: 'app.js', additions: 1, deletions: 1, contentHash: `app-${p.seq}` }],
          toolCalls: [],
          errors: [],
          testPassCount: null,
          testFailCount: null,
          exitedCleanly: true,
        }),
      );
    });

    const terminal = new Promise<{ reason: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('loop did not stall in time')), 25_000);
      coordinator.on('loop:completed-needs-review', (d: { reason: string }) => { clearTimeout(t); resolve(d); });
      coordinator.on('loop:completed', () => { clearTimeout(t); reject(new Error('unexpected clean completion')); });
      coordinator.on('loop:cap-reached', () => { clearTimeout(t); reject(new Error('reached the iteration cap — stall backstop did not fire')); });
    });

    const state = await coordinator.startLoop('chat-ledger-stall', {
      initialPrompt: 'implement all remaining slices',
      workspaceCwd: workspace,
      caps: {
        maxIterations: 30,
        maxWallTimeMs: 120_000,
        maxTokens: 1_000_000,
        maxCostCents: 100_000,
        maxToolCallsPerIteration: 200,
      },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        mode: 'review-driven',
        maxLedgerStallIterations: 3,
        verifyCommand: '',
        crossModelReview: { enabled: false, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    const evt = await terminal;

    const final = coordinator.getLoop(state.id);
    expect(final?.status).toBe('completed-needs-review');
    expect(evt.reason).toMatch(/no meaningful LOOP_TASKS\.md task transition/i);
    // WS3: the terminal reason names the unchanged open leaf task(s) by id.
    expect(evt.reason).toMatch(/Unchanged open leaf task\(s\): lf-[0-9a-f]{12}/);
    // Fired well before the 30-iteration cap — a few iterations after the
    // open-count plateaued (limit 3), not at the cap.
    expect(iterations).toBeLessThan(10);
    // It genuinely made a production change every round (the OLD guard would
    // have reset each time and never stopped).
    expect(final?.lastIteration?.filesChanged.some((f) => f.path === 'app.js')).toBe(true);
  }, 30_000);
});
