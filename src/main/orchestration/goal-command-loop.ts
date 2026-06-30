import {
  defaultLoopConfig,
  type LoopConfig,
  type LoopProvider,
} from '../../shared/types/loop.types';
import { detectLoopGoalIntent } from './loop-intent';

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
      mode: 'gated',
      verifyCommand: '',
      allowOperatorReviewedCompletion: true,
    },
  };
}

function looksLikeGoalFileReference(value: string): boolean {
  return /^@[\w./~ -]+\.(?:md|markdown|txt)$/i.test(value)
    || /^file:[\w./~ -]+\.(?:md|markdown|txt)$/i.test(value);
}
