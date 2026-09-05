import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  LOOP_PROMPT_BOARD_MARKER,
  renderReviewDrivenContinuationCard,
  renderStagedContinuationCard,
  splitLoopPromptPrefix,
} from './loop-continuation-prompt';
import { defaultLoopConfig, type LoopConfig } from '../../shared/types/loop.types';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-continuation-prompt-'));

function configFor(): LoopConfig {
  return defaultLoopConfig(tmpDir, 'Ship the stable-prefix continuation card');
}

function stagedCard(overrides: {
  iterationSeq: number;
  pendingInterventions?: string[];
  capUsage?: { totalTokens: number; totalCostCents: number };
  iterationPrompt?: string;
}): string {
  return renderStagedContinuationCard({
    blockedPath: `${tmpDir}/BLOCKED.md`,
    capUsage: overrides.capUsage,
    config: configFor(),
    currentStage: 'IMPLEMENT',
    iterationPrompt: overrides.iterationPrompt,
    iterationSeq: overrides.iterationSeq,
    notesPath: `${tmpDir}/NOTES.md`,
    pendingInterventions: overrides.pendingInterventions ?? [],
    stagePath: `${tmpDir}/STAGE.md`,
    stateDir: tmpDir,
    tasksPath: `${tmpDir}/LOOP_TASKS.md`,
  });
}

function reviewDrivenCard(overrides: {
  iterationSeq: number;
  pendingInterventions?: string[];
  iterationPrompt?: string;
}): string {
  return renderReviewDrivenContinuationCard({
    blockedPath: `${tmpDir}/BLOCKED.md`,
    config: configFor(),
    iterationPrompt: overrides.iterationPrompt,
    iterationSeq: overrides.iterationSeq,
    notesPath: `${tmpDir}/NOTES.md`,
    outstandingPath: `${tmpDir}/OUTSTANDING.md`,
    pendingInterventions: overrides.pendingInterventions ?? [],
    stateDir: tmpDir,
    tasksPath: `${tmpDir}/LOOP_TASKS.md`,
  });
}

/**
 * T8 property: on a same-thread continuation the bytes before
 * `LOOP_PROMPT_BOARD_MARKER` must not change between iterations. Everything
 * that moves (iteration number, stage board, interventions, loop budget) lives
 * behind the marker, so the provider's prompt cache keeps the prefix hit.
 */
describe('T8 stable prefix / volatile tail', () => {
  const varyingTails: Array<{
    label: string;
    iterationSeq: number;
    pendingInterventions: string[];
    capUsage: { totalTokens: number; totalCostCents: number };
  }> = [
    { label: 'quiet iteration', iterationSeq: 3, pendingInterventions: [], capUsage: { totalTokens: 1_000, totalCostCents: 10 } },
    { label: 'steered iteration', iterationSeq: 4, pendingInterventions: ['fix the failing spec'], capUsage: { totalTokens: 90_000, totalCostCents: 900 } },
    { label: 'ledger-reminder iteration', iterationSeq: 10, pendingInterventions: ['a', 'b'], capUsage: { totalTokens: 5, totalCostCents: 0 } },
  ];

  it('keeps the staged continuation prefix byte-identical while the tail changes', () => {
    const cards = varyingTails.map((sample) => stagedCard(sample));
    const prefixes = cards.map((card) => splitLoopPromptPrefix(card).prefix);
    const tails = cards.map((card) => splitLoopPromptPrefix(card).tail);

    for (const prefix of prefixes) expect(prefix).toBe(prefixes[0]);
    expect(new Set(tails).size).toBe(tails.length);
    for (const card of cards) expect(card).toContain(LOOP_PROMPT_BOARD_MARKER);
  });

  it('keeps the review-driven continuation prefix byte-identical while the tail changes', () => {
    const cards = varyingTails.map((sample) => reviewDrivenCard(sample));
    const prefixes = cards.map((card) => splitLoopPromptPrefix(card).prefix);
    const tails = cards.map((card) => splitLoopPromptPrefix(card).tail);

    for (const prefix of prefixes) expect(prefix).toBe(prefixes[0]);
    expect(new Set(tails).size).toBe(tails.length);
  });

  it('puts the iteration number and loop budget in the tail, never the prefix', () => {
    const { prefix, tail } = splitLoopPromptPrefix(
      stagedCard({ iterationSeq: 7, capUsage: { totalTokens: 12, totalCostCents: 3 } }),
    );
    expect(tail).toContain('Iteration 7.');
    expect(tail).toContain('Loop budget remaining (this run, not the model window)');
    expect(prefix).not.toContain('Iteration 7.');
    expect(prefix).not.toContain('Loop budget remaining');
  });

  // The continuation directive comes from static per-run config, so it belongs
  // in the STABLE prefix. If a future edit moves it behind the marker (or moves
  // something volatile in front of it) the cache contract silently breaks.
  it('keeps a custom continuation directive in the stable prefix on both card shapes', () => {
    const directive = 'Focus on the failing integration test before anything else.';
    const staged = varyingTails.map((sample) => stagedCard({ ...sample, iterationPrompt: directive }));
    const reviewDriven = varyingTails.map((sample) => reviewDrivenCard({ ...sample, iterationPrompt: directive }));

    for (const cards of [staged, reviewDriven]) {
      const prefixes = cards.map((card) => splitLoopPromptPrefix(card).prefix);
      for (const prefix of prefixes) expect(prefix).toBe(prefixes[0]);
      expect(prefixes[0]).toContain(directive);
      expect(splitLoopPromptPrefix(cards[0]!).tail).not.toContain(directive);
    }
  });

  it('returns the whole prompt as the prefix when no board marker is present', () => {
    expect(splitLoopPromptPrefix('no board here')).toEqual({ prefix: 'no board here', tail: '' });
  });
});
