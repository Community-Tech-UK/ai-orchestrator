/**
 * Part 3g: a stalled run ends `completed-needs-review` with the merge hold
 * staged, so its work stays on the session branch instead of merging.
 *
 * Covers both stall endings in the coordinator run loop: the review-driven
 * CRITICAL no-progress stall and the ledger-convergence stall. The two
 * final-audit endings are covered in loop-review-driven-terminal.spec.ts and
 * loop-final-audit-blocked-completion.spec.ts. The ping-pong final-audit
 * merge hold is covered here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
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
  workspace = mkdtempSync(join(tmpdir(), 'loop-merge-hold-'));
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
  vi.restoreAllMocks();
  try { await coordinator.cancelLoop(coordinator.getActiveLoops()[0]?.id ?? ''); } catch { /* noop */ }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

const CRITICAL_OUTPUT = 'persistent CRITICAL review with no structural work';

describe('LoopCoordinator merge hold on stall endings (part 3g)', () => {
  it('stages the stalled merge hold on the review-driven stall ending', async () => {
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback({
        childInstanceId: null,
        output: CRITICAL_OUTPUT,
        tokens: 1,
        costUsd: 0,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      }));
    });

    const terminal = new Promise<{ loopRunId: string; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('review stall did not terminalize')), 25_000);
      coordinator.on('loop:completed-needs-review', (event: { loopRunId: string; reason: string }) => {
        clearTimeout(timeout);
        resolve(event);
      });
      coordinator.on('loop:cap-reached', () => {
        clearTimeout(timeout);
        reject(new Error('cap beat the review stall'));
      });
    });

    const state = await coordinator.startLoop('chat-merge-hold-review-stall', {
      initialPrompt: 'make progress',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        mode: 'review-driven',
        maxStalledReviewIterations: 1,
        verifyCommand: '',
        crossModelReview: { enabled: false, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    const event = await terminal;
    expect(event.reason).toMatch(/stalled/i);
    expect(coordinator.getLoop(state.id)?.endEvidence).toMatchObject({
      mergeHold: true,
      mergeHoldKind: 'stalled',
    });
  }, 30_000);

  it('stages the stalled merge hold on the ledger-convergence stall ending', async () => {
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      writeRunState(payload, 'LOOP_TASKS.md', '# Loop Tasks\n- [ ] Open task 1\n- [ ] Open task 2\n');
      queueMicrotask(() => p.callback({
        childInstanceId: null,
        output: CRITICAL_OUTPUT,
        tokens: 1,
        costUsd: 0,
        filesChanged: [{ path: 'app.js', additions: 1, deletions: 0, contentHash: `h${Math.random()}` }],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      }));
    });

    const terminal = new Promise<{ loopRunId: string; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ledger stall did not terminalize')), 25_000);
      coordinator.on('loop:completed-needs-review', (event: { loopRunId: string; reason: string }) => {
        clearTimeout(timeout);
        resolve(event);
      });
      coordinator.on('loop:cap-reached', () => {
        clearTimeout(timeout);
        reject(new Error('cap beat the ledger stall'));
      });
    });

    const state = await coordinator.startLoop('chat-merge-hold-ledger-stall', {
      initialPrompt: 'close the tasks',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        mode: 'review-driven',
        maxStalledReviewIterations: 5,
        maxLedgerStallIterations: 1,
        verifyCommand: '',
        crossModelReview: { enabled: false, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    const event = await terminal;
    expect(event.reason).toMatch(/stalled/i);
    expect(coordinator.getLoop(state.id)?.endEvidence).toMatchObject({
      mergeHold: true,
      mergeHoldKind: 'stalled',
    });
  }, 30_000);

  it('stages the final-audit merge hold on the ping-pong path when the audit needs operator review', async () => {
    const auditRuntime = await import('./loop-audit-runtime');
    const freshEyes = await import('./loop-fresh-eyes-reviewer');
    vi.spyOn(auditRuntime, 'runLoopFinalAudit').mockResolvedValue({
      status: 'needs-review', findings: [], ranAt: Date.now(), changedFiles: [],
      coverage: { criteriaTotal: 0, criteriaVerified: 0, criteriaUnverified: 0, verifyCommandRan: true, repoComparisonRan: true, cleanlinessScanRan: true },
    } as never);
    vi.spyOn(freshEyes, 'runLocalOnlyFreshEyesReview').mockResolvedValue({ status: 'skipped', findings: [], summary: 'off' } as never);
    coordinator.setCleanReviewClassifier(async () => ({ clean: true, confidence: 1, reason: 'reviewed' }));
    coordinator.setPingPongReviewerForTesting(async () => ({ verdict: 'APPROVED', reviewerProvider: 'codex', findings: [], ledgerClassifications: [], summary: 'approved', tokensUsed: 0, costCents: 0 }));
    coordinator.on('loop:invoke-iteration', (payload: { callback: (r: unknown) => void }) => {
      queueMicrotask(() => (payload.callback as (r: unknown) => void)({
        childInstanceId: null, output: 'There are no outstanding issues', tokens: 1, costUsd: 0,
        filesChanged: [], toolCalls: [], errors: [], testPassCount: null, testFailCount: null, exitedCleanly: true,
      }));
    });

    const terminal = new Promise<{ loopRunId: string; reason: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ping-pong audit hold did not terminalize')), 25_000);
      coordinator.on('loop:completed-needs-review', (event: { loopRunId: string; reason: string }) => {
        clearTimeout(timeout);
        resolve(event);
      });
    });

    const state = await coordinator.startLoop('chat-merge-hold-pingpong-audit', {
      initialPrompt: 'implement everything',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        mode: 'review-driven',
        verifyCommand: '',
        crossModelReview: { enabled: true, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured', pingPong: { enabled: true, reviewerProvider: 'auto', subject: 'impl', maxRounds: 15 } },
      },
      audit: { finalAuditMode: 'gate', preflightMode: 'off', planPacketMode: 'off', cleanlinessScan: true },
    });

    await terminal;
    expect(coordinator.getLoop(state.id)?.endEvidence).toMatchObject({
      mergeHold: true,
      mergeHoldKind: 'final-audit-blocked',
    });
  }, 30_000);
});
