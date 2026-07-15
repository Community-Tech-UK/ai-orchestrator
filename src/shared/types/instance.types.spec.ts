import { describe, expect, it } from 'vitest';
import { createInstance, type OutputMessage } from './instance.types';

describe('createInstance', () => {
  it('defaults bare mode off', () => {
    const instance = createInstance({
      workingDirectory: '/tmp/project',
    });

    expect(instance.bareMode).toBe(false);
  });

  it('preserves explicit bare mode', () => {
    const instance = createInstance({
      workingDirectory: '/tmp/project',
      bareMode: true,
    });

    expect(instance.bareMode).toBe(true);
  });

  it('keeps generated app history identity independent from provider identity', () => {
    const instance = createInstance({
      workingDirectory: '/tmp/project',
      sessionId: 'provider-native-session',
    });

    expect(instance.sessionId).toBe('provider-native-session');
    expect(instance.providerSessionId).toBe('provider-native-session');
    expect(instance.historyThreadId).not.toBe('provider-native-session');
  });

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
