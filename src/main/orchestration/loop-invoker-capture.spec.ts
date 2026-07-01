import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  createLoopInvocationCapture,
  extractFinishReasonFromResponse,
} from './loop-invoker-capture';

describe('createLoopInvocationCapture', () => {
  it('captures read paths, result hashes, durations, and unresolved tool calls', () => {
    let timestamp = 100;
    const capture = createLoopInvocationCapture({
      workspaceDir: '/workspace/project',
      now: () => timestamp,
    });

    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Read',
      detail: { id: 'read-1', name: 'Read', input: { file_path: '/workspace/project/src/input.ts' } },
    });
    timestamp = 125;
    capture.recordActivity({
      kind: 'tool_result',
      message: 'Tool result: Read',
      detail: { id: 'read-1', name: 'Read', result: '' },
    });
    timestamp = 150;
    capture.recordActivity({
      kind: 'tool_use',
      message: 'Using tool: Bash',
      detail: { id: 'bash-1', name: 'Bash', input: { command: 'npm test' } },
    });
    timestamp = 175;
    capture.recordActivity({
      kind: 'complete',
      message: 'done',
      detail: { finishReason: 'tool_use' },
    });

    expect(capture.finalize()).toEqual({
      filesRead: ['src/input.ts'],
      finishReason: 'tool_use',
      unresolvedToolCalls: true,
      toolCalls: [
        {
          toolName: 'Read',
          argsHash: expect.any(String),
          resultHash: sha16(''),
          success: true,
          durationMs: 25,
        },
        {
          toolName: 'Bash',
          argsHash: expect.any(String),
          success: true,
          durationMs: 25,
        },
      ],
    });
  });
});

describe('extractFinishReasonFromResponse', () => {
  it('reads finish reasons from direct, metadata, and raw response shapes', () => {
    expect(extractFinishReasonFromResponse({ finishReason: 'end_turn' })).toBe('end_turn');
    expect(extractFinishReasonFromResponse({ metadata: { stopReason: 'tool_use' } })).toBe('tool_use');
    expect(extractFinishReasonFromResponse({ raw: { stop_reason: 'max_tokens' } })).toBe('max_tokens');
  });
});

function sha16(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
