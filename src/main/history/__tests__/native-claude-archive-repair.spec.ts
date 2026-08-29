import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { createNativeClaudeArchiveRepairPlan } from '../native-claude-archive-repair';

describe('native Claude archive repair', () => {
  it('sanitizes a context-polluted archive even when no earlier backup exists', () => {
    const authoredPrompt = 'Summarize the first authored message into a title.';
    const nativeMessages: OutputMessage[] = [
      { id: 'native-u1', timestamp: 1, type: 'user', content: authoredPrompt },
      { id: 'native-a1', timestamp: 2, type: 'assistant', content: 'Done.' },
    ];
    const archivedMessages: OutputMessage[] = [
      {
        id: 'native-u1',
        timestamp: 1,
        type: 'user',
        content: [
          '[Indexed Codebase Context]',
          'Source: Harness indexed codebase search',
          '[End Indexed Codebase Context]',
          '',
          authoredPrompt,
        ].join('\n'),
      },
      nativeMessages[1],
    ];

    expect(createNativeClaudeArchiveRepairPlan(
      nativeMessages,
      archivedMessages,
      authoredPrompt,
    )).toEqual({
      backupLabel: 'runtime-context-pollution',
      repairKind: 'runtime-context-pollution',
      repairedMessages: nativeMessages,
    });
  });
});
