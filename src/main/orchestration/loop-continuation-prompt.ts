/**
 * T8 / T12 / T13: stable-prefix continuation card and trailing loop board.
 *
 * Same-thread iterations after T2 skips the goal keep one short card instead
 * of re-paying Steps 0–5 / the OUTSTANDING.md template. The volatile board
 * (stage, iteration, interventions, loop budget) always sits behind
 * `LOOP_PROMPT_BOARD_MARKER` so a property test can assert prefix stability.
 */

import type { LoopConfig, LoopStage } from '../../shared/types/loop.types';
import { CLEAN_REVIEW_SENTINEL } from './loop-terminal-sentinels';
import {
  renderPendingInput,
  renderSystemReminder,
  type PendingInputLike,
} from './loop-stage-prompt-helpers';

export const LOOP_PROMPT_BOARD_MARKER = '## Loop board';

/** T57: longer operator directives leave the cached prefix and sit on the board. */
export const LOOP_ITERATION_PROMPT_PREFIX_MAX_CHARS = 500;

export function classifyIterationPromptDirective(
  iterationPrompt: string | undefined,
  initialPrompt: string,
): { kind: 'none' | 'prefix' | 'tail'; text: string } {
  const text = iterationPrompt?.trim() ?? '';
  if (!text || text === initialPrompt.trim()) return { kind: 'none', text: '' };
  return text.length > LOOP_ITERATION_PROMPT_PREFIX_MAX_CHARS
    ? { kind: 'tail', text }
    : { kind: 'prefix', text };
}

function directiveBlocks(
  iterationPrompt: string | undefined,
  initialPrompt: string,
  heading: string,
): { prefix: string; tail: string } {
  const classified = classifyIterationPromptDirective(iterationPrompt, initialPrompt);
  if (classified.kind === 'none') return { prefix: '', tail: '' };
  const block = `\n${heading}\n${classified.text}\n`;
  return classified.kind === 'prefix'
    ? { prefix: block, tail: '' }
    : { prefix: '', tail: block };
}

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
  const directive = options.iterationSeq > 0
    ? directiveBlocks(options.iterationPrompt, options.config.initialPrompt, 'Loop continuation directive:')
    : { prefix: '', tail: '' };
  const board = renderLoopBoard(options);
  return `# Loop Mode — Continuation

${sameSessionContextLine(options.config.contextStrategy)}

## Autonomous Mode Rules

There is no human in the loop to answer questions. You must:

1. **Make decisions.** If you are uncertain, choose the option a senior engineer would defend in code review. Document your reasoning in \`${options.notesPath}\`.
${clarifyingQuestionRule(options.config.contextStrategy)}
3. **If you are genuinely blocked**, write \`${options.blockedPath}\` describing exactly what you need, then exit.

State files live under \`${options.stateDir}/\`. Continue the current stage (\`${options.currentStage}\`). Do not re-read these instructions as a new contract.
${directive.prefix}
${directive.tail ? `${board}${directive.tail}` : board}
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
  const directive = directiveBlocks(
    options.iterationPrompt,
    options.config.initialPrompt,
    'Continuation directive:',
  );
  return `# Loop Mode (review-driven) — Continuation

${sameSessionContextLine(options.config.contextStrategy)}

Schema unchanged — read \`${options.notesPath}\`, \`${options.outstandingPath}\`, and \`${options.tasksPath}\`. Advance the goal, re-review with fresh eyes, and use the same clean-review sentence and sentinel as iteration 0 when you are actually done.

Clean-review sentence (unchanged): ${preferred}
${directive.prefix}
${LOOP_PROMPT_BOARD_MARKER}

Iteration ${options.iterationSeq}. If blocked, write \`${options.blockedPath}\` then exit.
${interventions}
${directive.tail}
Begin.`;
}

export function renderReviewDrivenReanchorPrompt(options: {
  config: LoopConfig;
  iterationSeq: number;
  stateDir: string;
  notesPath: string;
  outstandingPath: string;
  blockedPath: string;
  tasksPath: string;
  pendingInterventions: PendingInputLike[];
  priorObservations?: string[];
  planStageContext?: string;
  existingSessionContext?: string;
  includeSessionReplay: boolean;
  iterationPrompt?: string;
  verifyCommand?: string;
  planPacketBlock?: string;
}): string {
  const preferred = (options.config.completion.noOutstandingPhrase ?? 'There are no outstanding issues').trim();
  const required = Math.max(1, options.config.completion.requiredCleanReviewPasses ?? 2);
  const verifyBlock = options.verifyCommand
    ? `\n- A verify command is configured: \`${options.verifyCommand}\`. Run it as part of your review; if it fails, that is an outstanding issue — fix it and do NOT emit the completion line this round.`
    : '';
  const directive = directiveBlocks(
    options.iterationPrompt,
    options.config.initialPrompt,
    '## Continuation directive (later iterations)',
  );
  const interventions = options.pendingInterventions.length > 0
    ? `Direction since last iteration (binding):\n${options.pendingInterventions.map(renderPendingInput).join('\n')}`
    : 'Direction since last iteration: none.';
  const priorObservations = options.priorObservations && options.priorObservations.length > 0
    ? `\nPrior observations (not binding):\n${options.priorObservations.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
    : '';
  const planStageContext = options.planStageContext && options.iterationSeq === 0
    ? `\n${options.planStageContext}`
    : '';
  const sessionReplay = options.existingSessionContext?.trim() && options.includeSessionReplay
    ? `\nExisting session context (read-only background):\n${options.existingSessionContext.trim()}`
    : '';

  return `# Loop Mode (review-driven)

${sameSessionContextLine(options.config.contextStrategy)}

There is no human in the loop. Make the decisions a senior engineer would defend.
${clarifyingQuestionRule(options.config.contextStrategy)}

## Your job this iteration
1. **Advance the goal when work remains.** Do the next concrete chunk of real work toward the goal below. Use maintainable architecture; no shortcuts, stubs, or placeholder/constant-return logic standing in for the real thing. If a genuine fresh-eyes review finds nothing actionable, do not invent work or gold-plate the result; proceed to the clean declaration below without changing production code.
2. **Re-review your own work with completely fresh eyes.** Pretend a stranger wrote everything and you are the reviewer. Hunt specifically for:
   - things the goal asked for that are NOT actually implemented (orphan code, stubs, TODOs, "not implemented", fake/mock behaviour in production paths, docs that claim done with no real wiring);
   - specs that say one thing while the code does another;
   - half-done features, missing wiring/integration, missing error handling, regressions.
3. **Fix everything you find** in this same iteration.${verifyBlock}

## State files (under \`${options.stateDir}/\` — read/write at these exact paths)
- \`${options.notesPath}\` — append a terse one-paragraph summary each iteration: what you changed, what's left.
- \`${options.outstandingPath}\` — keep this current. Two sections: Needs human and Open questions. Every item needs an indented Recommendation. Empty sections are \`- (none)\`. Read the file for the schema; do not wait for a restated template. The bar for Needs human is high — only genuinely human-required items.
- \`${options.blockedPath}\` — only if hard-blocked; write what you need, then exit.
- \`${options.tasksPath}\` — keep the ledger current.${options.planPacketBlock ?? ''}
${directive.prefix}
## Goal (persistent across iterations)
${options.config.initialPrompt}

## How this loop stops
The loop ends after **${required} consecutive** iterations where, after a genuine fresh-eyes pass, you (a) made **no** code changes and (b) found nothing left to fix that you can act on.

When — and ONLY when — that is true this iteration (you changed no production code, and everything remaining is either done or sits under "## Needs human" in \`${options.outstandingPath}\`), end your message with this human-readable statement:

${preferred}

Then emit this structured sentinel on its own line within the final 12 lines of your output:

${CLEAN_REVIEW_SENTINEL}

Never quote or repeat that sentinel while discussing these instructions; emit it only when actually declaring a clean review. The human-readable sentence alone is not a completion signal. Do **not** write an equivalent clean statement in any other situation. If you changed code or found anything actionable, keep working. Claiming a clean review prematurely just delays the real finish, because the loop re-checks and will reset the moment it sees more changes.

If the loop is about to stop but you KNOW real work still remains — e.g. your wording was misread as "done", or an item is genuinely unresolved — emit \`[[LOOP:MORE_WORK_REMAINING]]\` on its own line within the final 12 lines of your output. Never quote or repeat that token while discussing these instructions; emit it only when actually vetoing completion. The coordinator treats it as an authoritative "do not stop yet" and keeps the loop running. It can only ever keep the loop going; it can never cause a premature stop.

## Safety
This loop ${options.config.allowDestructiveOps ? 'DOES' : 'DOES NOT'} allow destructive operations (\`rm -rf\`, \`git push --force\`, schema drops). Honor that.

${LOOP_PROMPT_BOARD_MARKER}

Iteration ${options.iterationSeq}. Schema unchanged — read the state files already named; do not wait for a restated goal.
${interventions}${priorObservations}${planStageContext}${sessionReplay}${directive.tail}
Begin.`;
}

export function splitLoopPromptPrefix(prompt: string): { prefix: string; tail: string } {
  const idx = prompt.indexOf(LOOP_PROMPT_BOARD_MARKER);
  if (idx < 0) return { prefix: prompt, tail: '' };
  return { prefix: prompt.slice(0, idx), tail: prompt.slice(idx) };
}
