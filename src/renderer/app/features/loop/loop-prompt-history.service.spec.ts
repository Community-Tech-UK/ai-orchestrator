import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOOP_PROMPT, LoopPromptHistoryService } from './loop-prompt-history.service';

const LEGACY_DEFAULT_LOOP_PROMPT =
  "Please continue. Choose the best architectural decision — don't be lazy, don't take shortcuts. " +
  'Re-review your work with completely fresh eyes after each stage and fix any issues. ' +
  'When a plan file is fully implemented, rename it with `_Completed`.';

describe('LoopPromptHistoryService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('migrates the old built-in default prompt when it appears in recent history', () => {
    localStorage.setItem('loop:recent-prompts', JSON.stringify([LEGACY_DEFAULT_LOOP_PROMPT]));

    const service = new LoopPromptHistoryService();

    expect(service.recent()).toEqual([DEFAULT_LOOP_PROMPT]);
  });
});
