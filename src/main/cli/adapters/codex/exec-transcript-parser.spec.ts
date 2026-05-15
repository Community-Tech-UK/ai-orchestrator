import { describe, expect, it } from 'vitest';
import { parseCodexExecTranscript } from './exec-transcript-parser';

describe('parseCodexExecTranscript', () => {
  it('preserves dynamic tool call names and arguments', () => {
    const transcript = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'tool-1',
          type: 'dynamicToolCall',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect current UI', status: 'completed' },
              { step: 'Add progress panel', status: 'in_progress' },
            ],
          },
          output: 'ok',
        },
      }),
    ].join('\n');

    const parsed = parseCodexExecTranscript(transcript, [], 'response-1');

    expect(parsed.hasMeaningfulOutput).toBe(true);
    expect(parsed.response.toolCalls).toEqual([
      {
        id: 'tool-1',
        name: 'update_plan',
        arguments: {
          plan: [
            { step: 'Inspect current UI', status: 'completed' },
            { step: 'Add progress panel', status: 'in_progress' },
          ],
        },
        result: 'ok',
      },
    ]);
  });
});
