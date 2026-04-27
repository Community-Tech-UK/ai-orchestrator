import { describe, expect, it } from 'vitest';
import { createInstance, type OutputMessage } from './instance.types';

describe('createInstance', () => {
  it('copies the initial output buffer instead of retaining the caller array', () => {
    const initialOutputBuffer: OutputMessage[] = [
      {
        id: 'message-1',
        timestamp: 1,
        type: 'assistant',
        content: 'Restored message',
      },
    ];

    const instance = createInstance({
      workingDirectory: '/tmp/project',
      initialOutputBuffer,
    });

    instance.outputBuffer.push({
      id: 'message-2',
      timestamp: 2,
      type: 'error',
      content: 'No conversation found with session ID: stale-session',
    });

    expect(instance.outputBuffer).toHaveLength(2);
    expect(initialOutputBuffer).toHaveLength(1);
    expect(instance.outputBuffer).not.toBe(initialOutputBuffer);
  });
});
