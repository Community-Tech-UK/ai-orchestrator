/**
 * T8 / T12 / T13: stable-prefix continuation card and trailing loop board.
 *
 * Same-thread iterations after T2 skips the goal keep one short card instead
 * of re-paying Steps 0–5 / the OUTSTANDING.md template. The volatile board
 * (stage, iteration, interventions, loop budget) always sits behind
 * `LOOP_PROMPT_BOARD_MARKER` so a property test can assert prefix stability.
 */

import type { LoopConfig, LoopStage } from '../../shared/types/loop.types';
import {
  renderPendingInput,
  renderSystemReminder,
  type PendingInputLike,
} from './loop-stage-prompt-helpers';

export const LOOP_PROMPT_BOARD_MARKER = '## Loop board';

export function sameSessionContextLine(strategy: LoopConfig['contextStrategy']): string {
  return strategy === 'same-session'
    ? 'You are running inside an autonomous Loop Mode using one persistent child CLI session across iterations. State still belongs on disk so the loop can recover if the process restarts.'
    : 'You are running inside an autonomous Loop Mode. State lives on disk; do not rely on chat history. Every iteration is a fresh process.';
}

export function clarifyingQuestionRule(strategy: LoopConfig['contextStrategy']): string {
  return strategy === 'same-session'
    ? '2. **Do not ask clarifying questions.** They will not be answered — this persistent session continues, but the operator is not in the loop.'
    : '2. **Do not ask clarifying questions.** They will not be answered — the next iteration is a fresh process and will not see them.';
}

export function renderLoopBoard(options: {
  config: LoopConfig;
  iterationSeq: number;
  currentStage: LoopStage;
  stagePath: string;
  tasksPath: string;
  blockedPath: string;
  pendingInterventions: PendingInputLike[];
  capUsage?: { totalTokens: number; totalCostCents: number };
}): string {
  const reminder = renderSystemReminder({
    blockedPath: options.blockedPath,
    capUsage: options.capUsage,
    config: options.config,
    currentStage: options.currentStage,
    iterationSeq: options.iterationSeq,
    stagePath: options.stagePath,
    tasksPath: options.tasksPath,
  }).trim();
  const interventions = options.pendingInterventions.length > 0
    ? `Direction since last iteration (binding):\n${options.pendingInterventions.map(renderPendingInput).join('\n')}`
    : 'Direction since last iteration: none.';
  return `${LOOP_PROMPT_BOARD_MARKER}

Iteration ${options.iterationSeq}. Schema unchanged — read the state files already named; do not wait for a restated goal.
${reminder}
${interventions}
`;
}

export function renderStagedContinuationCard(options: {
  config: LoopConfig;
  iterationSeq: number;
  currentStage: LoopStage;
  stateDir: string;
  stagePath: string;
  notesPath: string;
  tasksPath: string;
  blockedPath: string;
  pendingInterventions: PendingInputLike[];
  capUsage?: { totalTokens: number; totalCostCents: number };
  iterationPrompt?: string;
}): string {
  const directive = options.iterationSeq > 0 && options.iterationPrompt?.trim()
    ? `\nLoop continuation directive:\n${options.iterationPrompt.trim()}\n`
    : '';
  return `# Loop Mode — Continuation

${sameSessionContextLine(options.config.contextStrategy)}

## Autonomous Mode Rules

There is no human in the loop to answer questions. You must:

1. **Make decisions.** If you are uncertain, choose the option a senior engineer would defend in code review. Document your reasoning in \`${options.notesPath}\`.
${clarifyingQuestionRule(options.config.contextStrategy)}
3. **If you are genuinely blocked**, write \`${options.blockedPath}\` describing exactly what you need, then exit.

State files live under \`${options.stateDir}/\`. Continue the current stage (\`${options.currentStage}\`). Do not re-read these instructions as a new contract.
${directive}
${renderLoopBoard(options)}
Begin.`;
}

export function renderReviewDrivenContinuationCard(options: {
  config: LoopConfig;
  iterationSeq: number;
  stateDir: string;
  notesPath: string;
  outstandingPath: string;
  blockedPath: string;
  tasksPath: string;
  pendingInterventions: PendingInputLike[];
  iterationPrompt?: string;
}): string {
  const preferred = (options.config.completion.noOutstandingPhrase ?? 'There are no outstanding issues').trim();
  // T8: interventions change every iteration, so they belong behind the board
  // marker with the rest of the volatile tail. Keeping them in the prefix would
  // bust the provider prompt cache on every steered iteration.
  const interventions = options.pendingInterventions.length > 0
    ? `Direction since last iteration (binding):\n${options.pendingInterventions.map(renderPendingInput).join('\n')}`
    : 'Direction since last iteration: none.';
  // The continuation directive comes from config and does not change between
  // iterations of a run, so it stays in the stable prefix.
  const directive = options.iterationPrompt?.trim()
    && options.iterationPrompt.trim() !== options.config.initialPrompt.trim()
    ? `\nContinuation directive:\n${options.iterationPrompt.trim()}\n`
    : '';
  return `# Loop Mode (review-driven) — Continuation

${sameSessionContextLine(options.config.contextStrategy)}

Schema unchanged — read \`${options.notesPath}\`, \`${options.outstandingPath}\`, and \`${options.tasksPath}\`. Advance the goal, re-review with fresh eyes, and use the same clean-review sentence and sentinel as iteration 0 when you are actually done.

Clean-review sentence (unchanged): ${preferred}
${directive}
${LOOP_PROMPT_BOARD_MARKER}

Iteration ${options.iterationSeq}. If blocked, write \`${options.blockedPath}\` then exit.
${interventions}

Begin.`;
}

export function splitLoopPromptPrefix(prompt: string): { prefix: string; tail: string } {
  const idx = prompt.indexOf(LOOP_PROMPT_BOARD_MARKER);
  if (idx < 0) return { prefix: prompt, tail: '' };
  return { prefix: prompt.slice(0, idx), tail: prompt.slice(idx) };
}
