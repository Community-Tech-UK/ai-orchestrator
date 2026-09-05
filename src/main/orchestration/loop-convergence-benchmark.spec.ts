/**
 * B2 — the convergence benchmark, run as a regression gate.
 *
 * The baseline lives beside this file. A change that makes a scenario cost more
 * paid turns, or send materially more prompt bytes, fails here — that is the
 * whole point: "we saved tokens" has to be a measured delta, not a claim.
 *
 * Tolerances are wide enough to absorb copy edits (prompt bytes ±25%) and tight
 * where the number is discrete and meaningful (child calls exact, terminal
 * status exact).
 */

import { describe, expect, it } from 'vitest';
import {
  LOOP_BENCHMARK_SCENARIOS,
  LOOP_BENCHMARK_RESULT_VERSION,
  runLoopConvergenceScenario,
} from './loop-convergence-benchmark';
import baseline from './loop-convergence-baseline.json';
import { LoopStageMachine } from './loop-stage-machine';
import { defaultLoopConfig } from '../../shared/types/loop.types';

interface BaselineEntry {
  childCalls: number;
  promptBytesTotal: number;
  terminalStatus: string;
}

const PROMPT_BYTES_TOLERANCE = 0.25;

describe('B2 loop convergence benchmark', () => {
  it('keeps the baseline in step with the scenario list', () => {
    expect(baseline.version).toBe(LOOP_BENCHMARK_RESULT_VERSION);
    expect(Object.keys(baseline.scenarios).sort())
      .toEqual(LOOP_BENCHMARK_SCENARIOS.map((s) => s.id).sort());
  });

  for (const scenario of LOOP_BENCHMARK_SCENARIOS) {
    it(`converges within budget: ${scenario.id}`, async () => {
      const result = await runLoopConvergenceScenario(scenario);
      const expected = (baseline.scenarios as Record<string, BaselineEntry>)[scenario.id]!;

      // A cheaper run that stops for the wrong reason is not an improvement.
      expect(result.terminalStatus).toBe(expected.terminalStatus);
      expect(result.childCalls).toBe(expected.childCalls);

      // Prompt bytes are the surface T2/T8/T12/T15 move. A regression here is a
      // scaffold creeping back into every iteration.
      const ceiling = Math.round(expected.promptBytesTotal * (1 + PROMPT_BYTES_TOLERANCE));
      expect(result.promptBytesTotal).toBeLessThanOrEqual(ceiling);

      // Builder spend must be attributed; an unattributed total is what B1 exists
      // to stop.
      expect(result.tokensByPurpose.builder).toBeGreaterThan(0);
    }, 40_000);
  }

  // The continuation card is what makes a later iteration cheaper than the
  // first (T2/T8/T12). It cannot fire in this harness — model resolution needs
  // a settings manager — so the saving is measured directly at the assembly
  // seam instead. See `loop-continuation-prompt.spec.ts` for the shape guard.
  it('measures the continuation card against the full scaffold at the prompt seam', () => {
    const config = defaultLoopConfig('/tmp/bench-seam', 'Refactor the module until it is clean.');
    const machine = new LoopStageMachine('/tmp/bench-seam', 'bench-seam');
    const shared = {
      config,
      iterationSeq: 3,
      pendingInterventions: [],
      capUsage: { totalTokens: 10, totalCostCents: 1 },
    };

    const full = machine.buildPrompt({ ...shared, reanchorGoal: true });
    const card = machine.buildPrompt({ ...shared, reanchorGoal: false });

    // The card must be a fraction of the scaffold, or T12 has regressed.
    expect(Buffer.byteLength(card, 'utf8')).toBeLessThan(Buffer.byteLength(full, 'utf8') / 2);
    expect(full).toContain(config.initialPrompt);
    expect(card).not.toContain(config.initialPrompt);
  });
});
