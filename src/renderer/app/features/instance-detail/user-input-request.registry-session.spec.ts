import { describe, expect, it, vi } from 'vitest';
import { UserInputRequestRegistry } from './user-input-request.registry';

describe('question registry session ownership', () => {
  it('allows two sessions to answer questions with the same provider request id independently', async () => {
    const registry = new UserInputRequestRegistry();
    let finishFirst!: () => void;
    const firstAnswer = new Promise<void>(resolve => { finishFirst = resolve; });
    const secondAnswer = vi.fn(async () => 'answered' as const);
    registry.replace('first-card', [{
      requestId: 'provider-question-1', instanceId: 'first-session', createdAt: 1,
      answer: async () => { await firstAnswer; return 'answered'; },
    }]);
    registry.replace('second-card', [{
      requestId: 'provider-question-1', instanceId: 'second-session', createdAt: 1, answer: secondAnswer,
    }]);
    const first = registry.offer('first-session', 'First answer');
    try {
      expect(await registry.offer('second-session', 'Second answer')).toBe('answered');
      expect(secondAnswer).toHaveBeenCalledWith('Second answer');
    } finally {
      finishFirst();
      await first;
    }
  });
});
