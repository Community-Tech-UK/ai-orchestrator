import {
  defaultLoopConfig,
  type LoopConfig,
  type LoopProvider,
} from '../../shared/types/loop.types';
import { detectLoopGoalIntent } from './loop-intent';
import { resolveLoopVerification, type ResolvedLoopVerification, type ResolveLoopVerificationInput } from './loop-verify-command';

export type GoalSignOffReason = { kind: 'investigation' | 'no-command' } | { kind: 'contended'; paths: string[] };
export type GoalCompletion = { kind: 'checks'; verifyCommand: string; source: string } | { kind: 'sign-off'; reason: GoalSignOffReason };

export async function resolveGoalCompletion(input: {
  workspaceCwd: string;
  intent: 'implementation' | 'investigation';
  resolve?: (input: ResolveLoopVerificationInput) => Promise<ResolvedLoopVerification>;
}): Promise<GoalCompletion> {
  if (input.intent === 'investigation') return { kind: 'sign-off', reason: { kind: 'investigation' } };
  const verification = await (input.resolve ?? resolveLoopVerification)({ workspaceCwd: input.workspaceCwd, requireAuthority: true, isolated: false });
  if (verification.authority === 'inferred' && verification.verifyCommand) {
    return { kind: 'checks', verifyCommand: verification.verifyCommand, source: verification.inferredSource ?? 'package.json scripts' };
  }
  return { kind: 'sign-off', reason: verification.contendedPaths?.length ? { kind: 'contended', paths: verification.contendedPaths } : { kind: 'no-command' } };
}

export function goalCompletionNote(completion: GoalCompletion): string {
  if (completion.kind === 'checks') return `Harness will check this work with \`${completion.verifyCommand}\` and finish on its own when it passes.`;
  if (completion.reason.kind === 'contended') return `Harness will ask for your sign-off when it thinks it's done: another session is editing this folder (${completion.reason.paths.slice(0, 5).map(p => `\`${p}\``).join(', ')}), so the folder's checks would grade that work too.`;
  if (completion.reason.kind === 'investigation') return "Harness will ask for your sign-off when it thinks the investigation is done.";
  return "Harness will ask for your sign-off when it thinks it's done: it found no check command in this folder (it looks at package.json scripts).";
}

export const GOAL_COMMAND_MAX_OBJECTIVE_CHARS = 20_000;

export type GoalCommandAction =
  | { type: 'start'; objective: string }
  | { type: 'status' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'clear' }
  | { type: 'invalid'; reason: string };

const CONTROL_ACTIONS = new Set(['pause', 'resume', 'clear']);

export function parseGoalCommandArgs(args: readonly string[]): GoalCommandAction {
  const cleaned = args.map((arg) => arg.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { type: 'status' };
  }

  const first = cleaned[0]?.toLowerCase();
  if (cleaned.length === 1 && first && CONTROL_ACTIONS.has(first)) {
    return { type: first as 'pause' | 'resume' | 'clear' };
  }

  const objective = cleaned.join(' ').trim();
  if (!objective) {
    return { type: 'status' };
  }

  if (
    objective.length > GOAL_COMMAND_MAX_OBJECTIVE_CHARS
    && !looksLikeGoalFileReference(objective)
  ) {
    return {
      type: 'invalid',
      reason:
        `Goal objective is too long (${objective.length} chars). ` +
        `Put the objective in a file and run /goal @path/to/goal.md.`,
    };
  }

  return { type: 'start', objective };
}

export function buildGoalLoopStartConfig(input: {
  objective: string;
  workspaceCwd: string;
  provider?: LoopProvider;
  completion?: GoalCompletion;
}): LoopConfig {
  const base = defaultLoopConfig(input.workspaceCwd, input.objective);
  const goalIntent = detectLoopGoalIntent(input.objective);

  return {
    ...base,
    initialPrompt: input.objective,
    workspaceCwd: input.workspaceCwd,
    provider: input.provider ?? base.provider,
    goalIntent: goalIntent.intent,
    completion: {
      ...base.completion,
      mode: input.completion?.kind === 'checks' ? 'review-driven' : 'gated',
      verifyCommand: input.completion?.kind === 'checks' ? input.completion.verifyCommand : '',
      allowOperatorReviewedCompletion: input.completion?.kind !== 'checks',
    },
  };
}

function looksLikeGoalFileReference(value: string): boolean {
  return /^@[\w./~ -]+\.(?:md|markdown|txt)$/i.test(value)
    || /^file:[\w./~ -]+\.(?:md|markdown|txt)$/i.test(value);
}
