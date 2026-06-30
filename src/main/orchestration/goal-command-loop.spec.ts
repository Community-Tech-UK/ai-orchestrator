import { describe, expect, it } from 'vitest';
import {
  GOAL_COMMAND_MAX_OBJECTIVE_CHARS,
  buildGoalLoopStartConfig,
  parseGoalCommandArgs,
} from './goal-command-loop';

describe('parseGoalCommandArgs', () => {
  it('treats /goal with no args as a status request', () => {
    expect(parseGoalCommandArgs([])).toEqual({ type: 'status' });
  });

  it('maps exact control subcommands without stealing normal objectives', () => {
    expect(parseGoalCommandArgs(['pause'])).toEqual({ type: 'pause' });
    expect(parseGoalCommandArgs(['resume'])).toEqual({ type: 'resume' });
    expect(parseGoalCommandArgs(['clear'])).toEqual({ type: 'clear' });
    expect(parseGoalCommandArgs(['pause', 'the', 'release', 'after', 'tests'])).toEqual({
      type: 'start',
      objective: 'pause the release after tests',
    });
  });

  it('rejects overlong inline objectives with a file-reference hint', () => {
    const result = parseGoalCommandArgs(['x'.repeat(GOAL_COMMAND_MAX_OBJECTIVE_CHARS + 1)]);

    expect(result).toEqual({
      type: 'invalid',
      reason: `Goal objective is too long (${GOAL_COMMAND_MAX_OBJECTIVE_CHARS + 1} chars). Put the objective in a file and run /goal @path/to/goal.md.`,
    });
  });
});

describe('buildGoalLoopStartConfig', () => {
  it('maps /goal objectives to gated Loop Mode with manual-review fallback', () => {
    const config = buildGoalLoopStartConfig({
      objective: 'Fix the renderer startup bug',
      workspaceCwd: '/work/project',
      provider: 'gemini',
    });

    expect(config.initialPrompt).toBe('Fix the renderer startup bug');
    expect(config.workspaceCwd).toBe('/work/project');
    expect(config.provider).toBe('gemini');
    expect(config.goalIntent).toBe('implementation');
    expect(config.completion?.mode).toBe('gated');
    expect(config.completion?.verifyCommand).toBe('');
    expect(config.completion?.allowOperatorReviewedCompletion).toBe(true);
  });

  it('classifies question-style goals as investigation goals', () => {
    const config = buildGoalLoopStartConfig({
      objective: 'Is the loop checkpointing feature fully implemented?',
      workspaceCwd: '/work/project',
      provider: 'codex',
    });

    expect(config.goalIntent).toBe('investigation');
  });
});
