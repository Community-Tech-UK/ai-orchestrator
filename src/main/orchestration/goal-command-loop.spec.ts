import { describe, expect, it } from 'vitest';
import {
  GOAL_COMMAND_MAX_OBJECTIVE_CHARS,
  buildGoalLoopStartConfig,
  parseGoalCommandArgs,
  resolveGoalCompletion,
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
  it('adopts a safe folder verifier as ordinary review-driven completion', async () => {
    const completion = await resolveGoalCompletion({ workspaceCwd: '/repo', intent: 'implementation', resolve: async () => ({ authority: 'inferred', verifyCommand: 'npm run verify', inferredSource: 'package.json' }) });
    expect(completion).toEqual({ kind: 'checks', verifyCommand: 'npm run verify', source: 'package.json' });
    expect(buildGoalLoopStartConfig({ objective: 'Fix startup', workspaceCwd: '/repo', completion }).completion).toMatchObject({ mode: 'review-driven', verifyCommand: 'npm run verify', allowOperatorReviewedCompletion: false });
  });

  it('keeps sign-off for contended, missing and investigation checks', async () => {
    expect(await resolveGoalCompletion({ workspaceCwd: '/repo', intent: 'implementation', resolve: async () => ({ authority: 'none', verifyCommand: '', contendedPaths: ['x.spec.ts'] }) })).toMatchObject({ kind: 'sign-off', reason: { kind: 'contended', paths: ['x.spec.ts'] } });
    expect(await resolveGoalCompletion({ workspaceCwd: '/repo', intent: 'implementation', resolve: async () => ({ authority: 'none', verifyCommand: '' }) })).toMatchObject({ kind: 'sign-off', reason: { kind: 'no-command' } });
    expect(await resolveGoalCompletion({ workspaceCwd: '/repo', intent: 'investigation', resolve: async () => { throw new Error('must not infer'); } })).toMatchObject({ kind: 'sign-off', reason: { kind: 'investigation' } });
  });
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
