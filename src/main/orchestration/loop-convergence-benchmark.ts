/**
 * B2 — reproducible "cost to convergence" benchmark.
 *
 * Every token claim in the enhancements plan is supposed to cite a measurement,
 * not a percentage from a tool's own README. This harness drives the REAL
 * `LoopCoordinator` with a scripted child so the numbers come from the code
 * that ships, and it records the four things that actually move a bill:
 *
 *   - **childCalls** — how many paid turns convergence took.
 *   - **promptBytes** — what we sent, per iteration. The scaffold, replay and
 *     goal re-anchor all land here, so T2/T8/T12/T15 show up as a delta.
 *   - **tokensByPurpose** — builder vs review vs verify, so a "saving" that
 *     merely moved spend to the reviewer is visible as such.
 *   - **terminalStatus / terminalReason** — a cheaper run that stops for the
 *     wrong reason is not an improvement.
 *
 * Deliberately excluded from assertions: wall time (machine-dependent) and any
 * live provider call. The scripted child returns fixed outputs, so a run is
 * deterministic apart from timing.
 *
 * One honest limitation: model resolution needs a real settings manager, which
 * a headless harness does not have, so `shouldReanchorLoopGoal` fails closed
 * here and the T2 goal skip never fires. Prompt-shape savings from T2/T8/T12
 * are therefore measured at the prompt-assembly seam
 * (`loop-continuation-prompt.spec.ts`), and this harness measures paid turns,
 * total prompt bytes and terminal status.
 *
 * No credentials, no real prompts, no network. Every scenario is a fixture.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { loopStateFile, resolveLoopArtifactPaths } from './loop-artifact-paths';
import { defaultCrossModelReviewConfig, defaultLoopConfig, type LoopConfig } from '../../shared/types/loop.types';
import type { LoopSpendPurpose } from './loop-resource-view';

/** Schema version of a result document. Bump when the shape changes. */
export const LOOP_BENCHMARK_RESULT_VERSION = 1;

export interface LoopBenchmarkTurn {
  /** What the scripted child "says". */
  output: string;
  /** Files the turn claims to have changed (paths only). */
  filesChanged?: string[];
  tokens?: number;
  /** Write these loop-state files before returning, e.g. `DONE.txt`. */
  writeStateFiles?: Record<string, string>;
}

/**
 * Adapter capabilities the scripted child claims. Absent means "unknown", which
 * is what a real adapter that cannot prove same-thread continuation reports —
 * and the T2 predicate then fails closed and keeps the goal. Supplying this is
 * how a scenario exercises the continuation-card path.
 */
export interface LoopBenchmarkThreadCaps {
  supportsResume: boolean;
  sameThreadContinuation: boolean;
  model: string | null;
}

export interface LoopBenchmarkScenario {
  id: string;
  description: string;
  goal: string;
  /** Turns are consumed in order; the last one repeats if the loop keeps going. */
  script: LoopBenchmarkTurn[];
  /** Config overrides merged over the deterministic benchmark defaults. */
  config?: Partial<LoopConfig>;
  /** Files seeded into the workspace before the run. */
  workspaceFiles?: Record<string, string>;
  /** Hard stop so a misbehaving scenario cannot hang the suite. */
  maxIterations: number;
  /** Capabilities every scripted turn reports. Omit to stay fail-closed. */
  threadCaps?: LoopBenchmarkThreadCaps;
}

export interface LoopBenchmarkResult {
  version: number;
  scenarioId: string;
  childCalls: number;
  promptBytesTotal: number;
  promptBytesByIteration: number[];
  tokensByPurpose: Partial<Record<LoopSpendPurpose, number>>;
  terminalStatus: string;
  terminalReason: string | null;
  /** Recorded for context only — never asserted on. */
  wallMs: number;
}

/**
 * Deterministic base config: no verify command (so no spawns), no cross-model
 * review (so no reviewer sessions), unbounded cost. Scenarios opt back in.
 */
function benchmarkConfig(
  workspace: string,
  scenario: LoopBenchmarkScenario,
): Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string } {
  const base = defaultLoopConfig(workspace, scenario.goal);
  return {
    ...scenario.config,
    initialPrompt: scenario.goal,
    workspaceCwd: workspace,
    caps: {
      ...base.caps,
      maxIterations: scenario.maxIterations,
      maxWallTimeMs: 60_000,
      maxTokens: null,
      maxCostCents: null,
    },
    completion: {
      ...base.completion,
      ...scenario.config?.completion,
      verifyCommand: '',
      allowOperatorReviewedCompletion: true,
      runVerifyTwice: false,
      crossModelReview: { ...defaultCrossModelReviewConfig(), enabled: false },
    },
  };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Loop benchmark timed out waiting for ${description}`);
}

/**
 * Run one scenario end to end and return its measurements. The caller owns
 * cleanup of the returned workspace only if it asked for one; by default a
 * fresh temp dir is created and left to the OS.
 */
export async function runLoopConvergenceScenario(
  scenario: LoopBenchmarkScenario,
): Promise<LoopBenchmarkResult> {
  const workspace = mkdtempSync(join(tmpdir(), `loop-bench-${scenario.id}-`));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  for (const [name, content] of Object.entries(scenario.workspaceFiles ?? {})) {
    const target = join(workspace, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }

  const coordinator = new LoopCoordinator();
  const promptBytesByIteration: number[] = [];
  const tokensByPurpose: Partial<Record<LoopSpendPurpose, number>> = {};
  let childCalls = 0;
  interface TerminalObservation { status: string; reason: string | null }
  // Held in a box: TypeScript narrows a `let` captured only by a callback to
  // `never` at the read site, which would hide the real value.
  const terminal: { value: TerminalObservation | null } = { value: null };
  const startedAt = Date.now();

  coordinator.on('loop:state-changed', (data: unknown) => {
    const state = (data as { state: { status: string; endReason?: string } }).state;
    if (['completed', 'completed-needs-review', 'cap-reached', 'error', 'failed', 'paused'].includes(state.status)) {
      terminal.value ??= { status: state.status, reason: state.endReason ?? null };
    }
  });

  coordinator.on('loop:invoke-iteration', (payload: unknown) => {
    const p = payload as {
      prompt: string;
      callback: (result: LoopChildResult) => void;
      loopRunId: string;
      workspaceCwd: string;
    };
    const turn = scenario.script[Math.min(childCalls, scenario.script.length - 1)]!;
    childCalls += 1;
    promptBytesByIteration.push(Buffer.byteLength(p.prompt ?? '', 'utf8'));
    tokensByPurpose.builder = (tokensByPurpose.builder ?? 0) + (turn.tokens ?? 1);

    const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
    mkdirSync(paths.dir, { recursive: true });
    for (const [name, content] of Object.entries(turn.writeStateFiles ?? {})) {
      writeFileSync(loopStateFile(paths, name), content);
    }

    queueMicrotask(() => p.callback({
      childInstanceId: null,
      output: turn.output,
      tokens: turn.tokens ?? 1,
      filesChanged: (turn.filesChanged ?? []).map((path) => ({
        path, additions: 1, deletions: 0, contentHash: `h-${path}-${childCalls}`,
      })),
      toolCalls: [],
      errors: [],
      testPassCount: null,
      testFailCount: null,
      exitedCleanly: true,
      ...(scenario.threadCaps ? { threadCaps: scenario.threadCaps, model: scenario.threadCaps.model ?? undefined } : {}),
    }));
  });

  const state = await coordinator.startLoop(`bench-${scenario.id}`, benchmarkConfig(workspace, scenario));
  try {
    await waitFor(() => terminal.value !== null, `${scenario.id} to reach a terminal state`);
  } finally {
    await coordinator.cancelLoop(state.id).catch(() => undefined);
  }

  const observed = terminal.value;
  return {
    version: LOOP_BENCHMARK_RESULT_VERSION,
    scenarioId: scenario.id,
    childCalls,
    promptBytesTotal: promptBytesByIteration.reduce((sum, n) => sum + n, 0),
    promptBytesByIteration,
    tokensByPurpose,
    terminalStatus: observed?.status ?? 'unknown',
    terminalReason: observed?.reason ?? null,
    wallMs: Date.now() - startedAt,
  };
}

const DONE = '<promise>DONE</promise>\nTASK COMPLETE';
const CLEAN_REVIEW = 'I re-read the diff. There are no outstanding issues.';

/**
 * The fixture set from B2. Each one is a shape that has actually cost money:
 * a review that finds nothing, a blocker that clears, a finding that cannot be
 * located, a run that keeps going, and a run that stops on its cap.
 */
export const LOOP_BENCHMARK_SCENARIOS: readonly LoopBenchmarkScenario[] = [
  {
    id: 'clean-no-change-review',
    description: 'The child declares done on the first turn with nothing to fix.',
    goal: 'Confirm the module is already correct.',
    maxIterations: 5,
    script: [{ output: `${CLEAN_REVIEW}\n${DONE}`, writeStateFiles: { 'DONE.txt': 'done\n' } }],
  },
  {
    id: 'one-blocker-then-clean',
    description: 'One iteration of real work, then a clean finish.',
    goal: 'Fix the failing edge case and confirm it.',
    maxIterations: 6,
    script: [
      { output: 'Found the edge case. Patching it now.', filesChanged: ['src/app.ts'], tokens: 3 },
      { output: `${CLEAN_REVIEW}\n${DONE}`, writeStateFiles: { 'DONE.txt': 'done\n' }, tokens: 2 },
    ],
  },
  {
    id: 'same-thread-claimed',
    description:
      'The child claims same-thread capability. The goal is still re-anchored '
      + 'because the T2 predicate also requires the resolved model to match, '
      + 'and model resolution is unavailable in a headless harness — this '
      + 'scenario pins that fail-closed cost so it cannot silently invert.',
    goal: 'Keep refactoring the module until it is clean.',
    maxIterations: 3,
    threadCaps: { supportsResume: true, sameThreadContinuation: true, model: 'sonnet' },
    config: { provider: 'claude' },
    script: [{ output: 'Working on it.', filesChanged: ['src/app.ts'] }],
  },
  {
    id: 'no-terminal-signal',
    description: 'The child works forever and never declares done — the cap must stop it.',
    goal: 'Keep improving the module.',
    maxIterations: 3,
    script: [{ output: 'Still working. More to do.', filesChanged: ['src/app.ts'] }],
  },
];
