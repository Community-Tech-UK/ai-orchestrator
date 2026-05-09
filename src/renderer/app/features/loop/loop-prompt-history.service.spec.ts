import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOOP_PROMPT, LoopPromptHistoryService } from './loop-prompt-history.service';

const LEGACY_DEFAULT_LOOP_PROMPT =
  "Please continue. Choose the best architectural decision — don't be lazy, don't take shortcuts. " +
  'Re-review your work with completely fresh eyes after each stage and fix any issues. ' +
  'When a plan file is fully implemented, rename it with `_Completed`.';

const PREVIOUS_DEFAULT_LOOP_PROMPT =
  "Continue toward the user's goal. Read relevant files before changing code, " +
  'choose the maintainable architecture, and make concrete progress this turn. ' +
  'If implementing a plan, update the code and tests until the plan is fully implemented. ' +
  'Verify with the appropriate checks. If a plan file is fully implemented and verified, ' +
  'rename it with _completed. Before stopping, review your own work with fresh eyes. ' +
  'Fix any issues you find. If blocked, explain the blocker clearly and stop.';

const VERBOSE_DEFAULT_LOOP_PROMPT =
  "Continue toward the user's goal.\n\n" +
  'Investigation: be thorough, read relevant files in full, and do not take shortcuts.\n\n' +
  'Planning: choose the best architecture even when it takes longer. Review the plan, ' +
  'fix issues, then re-review it with fresh eyes.\n\n' +
  'Implementation: implement the plan with the right architecture. Update code and tests ' +
  'until the plan is fully implemented. Verify with appropriate checks. Before stopping, ' +
  're-review your work with fresh eyes and fix any issues. If a plan file is fully ' +
  'implemented and verified, rename it with _completed. If blocked, explain the blocker clearly and stop.';

describe('LoopPromptHistoryService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('migrates built-in default prompts when they appear in recent history', () => {
    localStorage.setItem('loop:recent-prompts', JSON.stringify([
      LEGACY_DEFAULT_LOOP_PROMPT,
      PREVIOUS_DEFAULT_LOOP_PROMPT,
      VERBOSE_DEFAULT_LOOP_PROMPT,
    ]));

    const service = new LoopPromptHistoryService();

    expect(service.recent()).toEqual([DEFAULT_LOOP_PROMPT]);
  });
});
