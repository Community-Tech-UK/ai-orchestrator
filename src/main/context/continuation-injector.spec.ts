import { describe, it, expect } from 'vitest';
import { ContinuationInjector, type ConversationMessage } from './continuation-injector';

describe('ContinuationInjector', () => {
  it('creates a continuation message for truncated output', () => {
    const injector = new ContinuationInjector();
    const truncatedMessages: ConversationMessage[] = [
      { role: 'user', content: 'Write a long essay' },
      { role: 'assistant', content: 'Here is the beginning of the essay...' },
    ];

    const continuation = injector.createContinuation(truncatedMessages);
    expect(continuation.role).toBe('user');
    expect(continuation.content).toContain('Resume');
    expect(continuation.content).toContain('no apology');
    expect(continuation.content).toContain('no recap');
    expect(continuation.metadata?.isContinuation).toBe(true);
  });

  it('adds attempt number for multi-turn recovery', () => {
    const injector = new ContinuationInjector();
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Write code' },
      { role: 'assistant', content: 'function...' },
    ];

    const continuation = injector.createContinuation(messages, { attemptNumber: 2 });
    expect(continuation.metadata?.attemptNumber).toBe(2);
  });

  it('includes context hint from truncated output', () => {
    const injector = new ContinuationInjector();
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Write a function' },
      { role: 'assistant', content: 'Here is the code:\n```typescript\nfunction hello() {\n  console.log("' },
    ];

    const continuation = injector.createContinuation(messages);
    // Should include tail of truncated output as context
    expect(continuation.content).toContain('console.log');
  });
});
