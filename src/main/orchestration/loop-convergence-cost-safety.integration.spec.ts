/**
 * WS9 (loop-convergence plan) — incident-level integration coverage.
 *
 * Cross-module proof that the WS2–WS8 fixes work TOGETHER on the actual
 * failure shapes and survive persistence/restart: the false ledger stall, the
 * 55M-aggregate-token phantom recycle, the blind degraded replay over
 * workspace writes, verify-less implementation starts, Fable-shaped plan
 * import, and checkpoint round-trips for the new convergence tracker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { CompletedFileWatcher } from './loop-completion-detector';
import { buildLoopCheckpoint } from './loop-checkpoint';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import {
  isLedgerConvergenceStalled,
  unresolvedKnownTaskIds,
  updateLedgerConvergence,
} from './loop-ledger-progress';
import { parseTaskLedger } from './loop-task-ledger';
import { shouldRecycleLoopContext } from './loop-context-discipline';
import { prepareLoopStartConfig } from './loop-start-config';
import { buildCampaignFromPlan, INTEGRATION_GATE_NODE_ID } from './campaign-plan-import';
import { validateCampaignSpec } from './campaign-coordinator';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: workspace,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function writeRunLedger(payload: unknown, content: string): void {
  const p = payload as { loopRunId: string; workspaceCwd: string };
  const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(loopStateFile(paths, 'LOOP_TASKS.md'), content);
}

function reviewDrivenConfig(
  overrides: Record<string, unknown> = {},
): Partial<import('../../shared/types/loop.types').LoopConfig> & { initialPrompt: string; workspaceCwd: string } {
  return {
    initialPrompt: 'keep going',
    workspaceCwd: workspace,
    caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 6 },
    completion: {
      ...defaultLoopConfig(workspace, 'x').completion,
      mode: 'review-driven',
      verifyCommand: 'false',
      runVerifyTwice: false,
      requireCompletedFileRename: false,
      crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
    },
    ...overrides,
  } as Partial<import('../../shared/types/loop.types').LoopConfig> & { initialPrompt: string; workspaceCwd: string };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition was not met before timeout');
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-ws9-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'app.js'), 'const x = 0;\n');
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed']);
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  vi.restoreAllMocks();
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('WS9 §1 — incident ledger trajectory (stable ids, no false stall)', () => {
  it('WS4/WS5 child tasks resolve while discoveries hold the raw count flat; the tracker names the resolved ids', () => {
    const ledgerAt = (round: number): ReturnType<typeof parseTaskLedger> => {
      const planned = ['ws4.a', 'ws4.b', 'ws5.a', 'ws5.b'];
      const lines = [
        ...planned.map((id, index) =>
          `- [${index < round ? 'x' : ' '}] task ${id} <!-- loop-task-id:${id} -->`),
        ...Array.from({ length: round }, (_, i) => `- [ ] discovered d${i} <!-- loop-task-id:d${i} -->`),
      ];
      return parseTaskLedger(lines.join('\n'));
    };

    let tracker = updateLedgerConvergence(undefined, ledgerAt(0), null)!.next;
    const resolvedSeen: string[] = [];
    for (let round = 1; round <= 4; round++) {
      const update = updateLedgerConvergence(tracker, ledgerAt(round), null)!;
      expect(update.meaningfulTransition).toBe(true);
      expect(update.next.noMeaningfulTransitionIterations).toBe(0);
      tracker = update.next;
      resolvedSeen.push(...Object.entries(tracker.knownTaskStates)
        .filter(([, state]) => state === 'done')
        .map(([id]) => id)
        .filter((id) => !resolvedSeen.includes(id)));
    }
    // Raw open count never dropped (4 open at every round) yet there is no stall,
    // and the tracker knows EXACTLY which planned ids resolved.
    expect(isLedgerConvergenceStalled(tracker, 3)).toBe(false);
    expect(resolvedSeen.sort()).toEqual(['ws4.a', 'ws4.b', 'ws5.a', 'ws5.b']);
    expect(unresolvedKnownTaskIds(tracker).sort()).toEqual(['d0', 'd1', 'd2', 'd3']);
  });
});

describe('WS9 §2 — aggregate tokens can never fabricate occupancy', () => {
  it('55M aggregate Codex tokens + healthy 60k/200k observation → no recycle, no impossible percentage', () => {
    const decision = shouldRecycleLoopContext({
      enabled: true,
      resetAtUtilization: 0.6,
      observation: { status: 'known', used: 60_000, total: 200_000, source: 'provider-turn' },
      cumulativeTokens: 55_000_000,
    });
    expect(decision.recycle).toBe(false);
    expect(decision.utilization).toBeCloseTo(0.3, 5);
    // The diagnostic never contains a >100% phantom (the old fallback showed 27500%).
    expect(decision.reason).toContain('30%');
    expect(decision.reason).not.toMatch(/\d{3,}%/);
  });
});

describe('WS9 §3/§4 — degraded turn with vs without workspace writes', () => {
  it('a degraded attempt that WROTE pauses with sealed bounded evidence; no replay', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      // The 101-byte/900-second shape: tiny output, died mid-write, but the
      // workspace observation shows a real write.
      p.callback({
        error: 'stream cut after 101 bytes',
        attemptEvidence: {
          outcome: 'failed',
          outputExcerpt: 'x'.repeat(101),
          workspaceEffect: 'writes-observed',
          filesChanged: [{ path: 'src/half.ts', additions: 3, deletions: 0, contentHash: 'h' }],
          providerThreadReusable: false,
        },
      } as never);
    });

    const state = await coordinator.startLoop('chat-ws9-writes', reviewDrivenConfig({
      degradedIterationRetry: { enabled: true, maxRetries: 2 },
    }));

    await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'completed-needs-review');
    expect(invokeCount).toBe(1); // sealed — never replayed
    const final = coordinator.getLoop(state.id);
    expect(final?.endEvidence?.['workspaceEffect']).toBe('writes-observed');
    expect(final?.endEvidence?.['changedPaths']).toEqual(['src/half.ts']);
  });

  it('the same failure with a PROVEN clean workspace retries exactly once per budget without duplicating the seq', async () => {
    let invokeCount = 0;
    const seqs: number[] = [];
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      seqs.push(p.seq);
      if (invokeCount === 1) {
        p.callback({
          error: 'stream cut after 101 bytes',
          attemptEvidence: {
            outcome: 'failed',
            outputExcerpt: 'x'.repeat(101),
            workspaceEffect: 'none-observed',
            filesChanged: [],
            providerThreadReusable: false,
          },
        } as never);
        return;
      }
      p.callback({
        childInstanceId: null,
        output: 'recovered fine',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      });
    });

    const state = await coordinator.startLoop('chat-ws9-clean', reviewDrivenConfig({
      degradedIterationRetry: { enabled: true, maxRetries: 1 },
    }));

    await waitForCondition(() => invokeCount >= 2);
    expect(seqs[0]).toBe(0);
    expect(seqs[1]).toBe(0); // the SAME iteration seq retried — never duplicated
    await coordinator.cancelLoop(state.id);
  });
});

describe('WS9 §5 — verify-less implementation start is rejected before any adapter', () => {
  it('prepareLoopStartConfig throws; nothing downstream can be invoked', async () => {
    await expect(prepareLoopStartConfig({
      initialPrompt: 'implement the widget',
      workspaceCwd: workspace,
      completion: { ...defaultLoopConfig(workspace, 'x').completion, verifyCommand: '' },
    })).rejects.toThrow(/verification authority/i);
  });
});

describe('WS9 §6 — Fable-shaped plan becomes a sequential campaign', () => {
  it('one node per workstream, a final integration gate, and a valid graph', () => {
    const fablePlan = [
      '# Fable Implementation Plan',
      'implement one workstream per run from the plan.',
      '## WS1 — Provider registration',
      '- [ ] register',
      '## WS2 — Model catalog',
      '- [ ] catalog',
      '## WS3 — Streaming runtime',
      '- [ ] stream',
    ].join('\n');

    const { spec, assessment } = buildCampaignFromPlan({
      workspaceCwd: workspace,
      planFile: 'docs/plans/fable-plan.md',
      planText: fablePlan,
      baseLoop: { verifyCommand: 'npm test' },
      now: 1_700_000_000_000,
    });

    expect(assessment.disposition).toBe('campaign-required');
    expect(spec.nodes.map((n) => n.id)).toEqual(['ws1', 'ws2', 'ws3', INTEGRATION_GATE_NODE_ID]);
    expect(spec.policy.maxParallel).toBe(1);
    expect(validateCampaignSpec(spec)).toEqual({ valid: true, errors: [] });
  });
});

describe('WS9 §7/§8 — persistence and restore', () => {
  it('a parked write-observed attempt NEVER replays on restore (terminal park is refused re-activation) and its evidence survives the checkpoint round-trip', async () => {
    const seeded = await startedThenCancelledState();
    // Count ONLY invocations attributed to the parked run — the seed loop's
    // own (cancelled) run may still flush a queued emission.
    let invocations = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      if ((payload as { loopRunId?: string }).loopRunId === parkedId) invocations += 1;
    });

    const parkedId = seeded.id;
    const parked: LoopState = {
      ...seeded,
      status: 'completed-needs-review',
      endedAt: null,
      endReason: 'Iteration 3 paused for review instead of an automatic replay: writes observed',
      endEvidence: {
        attemptOutcome: 'failed',
        workspaceEffect: 'writes-observed',
        changedPaths: ['src/half.ts'],
        pausedIterationSeq: 3,
      },
      ledgerConvergence: {
        version: 1,
        knownTaskStates: { 'ws4.a': 'done', 'ws4.b': 'todo' },
        plannedLeafIds: ['ws4.a', 'ws4.b'],
        discoveredLeafIds: [],
        noMeaningfulTransitionIterations: 2,
      },
    };
    const checkpoint = buildLoopCheckpoint({ state: parked, history: [], now: 1 });

    // The sealed evidence and tracker survive serialization…
    const roundTripped = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
    expect(roundTripped.state.endEvidence?.['workspaceEffect']).toBe('writes-observed');
    expect(roundTripped.state.endEvidence?.['changedPaths']).toEqual(['src/half.ts']);
    expect(roundTripped.state.ledgerConvergence?.knownTaskStates['ws4.a']).toBe('done');
    expect(roundTripped.state.ledgerConvergence?.noMeaningfulTransitionIterations).toBe(2);

    // …and the coordinator REFUSES to re-activate the parked run — the same
    // decision it made when sealing it: no replay on startup.
    await expect(coordinator.restoreLoopFromCheckpoint(roundTripped)).rejects.toThrow(/non-paused/i);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(invocations).toBe(0);
  });

  it('a PAUSED checkpoint with the tracker restores it intact (same next decision)', async () => {
    const paused: LoopState = {
      ...(await startedThenCancelledState()),
      status: 'paused',
      endedAt: null,
      ledgerConvergence: {
        version: 1,
        // Discovered ids are tracked in knownTaskStates too (as the real
        // updateLedgerConvergence records them).
        knownTaskStates: { 'ws4.a': 'done', 'ws4.b': 'todo', 'd1': 'todo' },
        plannedLeafIds: ['ws4.a', 'ws4.b'],
        discoveredLeafIds: ['d1'],
        noMeaningfulTransitionIterations: 2,
      },
    };

    const restored = await coordinator.restoreLoopFromCheckpoint(
      buildLoopCheckpoint({ state: paused, history: [], now: 1 }),
    );

    expect(restored.ledgerConvergence?.plannedLeafIds).toEqual(['ws4.a', 'ws4.b']);
    expect(restored.ledgerConvergence?.discoveredLeafIds).toEqual(['d1']);
    expect(restored.ledgerConvergence?.noMeaningfulTransitionIterations).toBe(2);
    expect(unresolvedKnownTaskIds(restored.ledgerConvergence!).sort()).toEqual(['d1', 'ws4.b']);
  });

  it('a legacy checkpoint (historical count fields only) initializes the tracker on the next ledger observation', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      writeRunLedger(payload, '- [ ] legacy task <!-- loop-task-id:legacy.1 -->\n');
      queueMicrotask(() => p.callback({
        childInstanceId: null,
        output: 'working',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      }));
    });

    const legacy: LoopState = {
      ...(await startedThenCancelledState()),
      status: 'paused',
      endedAt: null,
      // Pre-WS3 fields only; NO ledgerConvergence. Old counts must never be
      // misread as task ids.
      ledgerOpenCountBest: 4,
      ledgerNoImprovementIterations: 7,
    };
    delete (legacy as Partial<LoopState>).ledgerConvergence;

    const restored = await coordinator.restoreLoopFromCheckpoint(
      buildLoopCheckpoint({ state: legacy, history: [], now: 1 }),
    );
    expect(restored.ledgerConvergence).toBeUndefined();

    coordinator.resumeLoop(restored.id);
    await waitForCondition(() => invokeCount >= 1 && !!coordinator.getLoop(restored.id)?.ledgerConvergence);

    const tracker = coordinator.getLoop(restored.id)?.ledgerConvergence;
    expect(tracker?.version).toBe(1);
    expect(tracker?.plannedLeafIds).toEqual(['legacy.1']);
    // Fresh counter: the legacy no-improvement count measured the old,
    // false-stall-prone quantity and is deliberately not carried over.
    expect(tracker?.noMeaningfulTransitionIterations).toBe(0);
    await coordinator.cancelLoop(restored.id);
  });

  async function startedThenCancelledState(): Promise<LoopState> {
    const listener = (payload: unknown): void => {
      const p = payload as { callback: (r: LoopChildResult | { error: string }) => void };
      queueMicrotask(() => p.callback({
        childInstanceId: null,
        output: 'seed',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      }));
    };
    coordinator.on('loop:invoke-iteration', listener);
    const seeded = await coordinator.startLoop('chat-ws9-restore-seed', reviewDrivenConfig({
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
    }));
    await coordinator.cancelLoop(seeded.id);
    coordinator.off('loop:invoke-iteration', listener);
    const snapshot = structuredClone({
      ...coordinator.getLoop(seeded.id) ?? seeded,
      id: `loop-ws9-${Math.floor(Math.random() * 1e9)}`,
      config: undefined,
    });
    return {
      ...snapshot,
      config: { ...(coordinator.getLoop(seeded.id) ?? seeded).config },
    } as LoopState;
  }
});
