import { describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { createInitialUserMessage } from './initial-user-message';

const config = (extra: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig =>
  ({ workingDirectory: '/project', initialPrompt: 'Do the task', ...extra });

describe('createInitialUserMessage', () => {
  it('marks a prompt a person typed, never later than now', () => {
    vi.useFakeTimers({ now: 5_000 });
    try {
      expect(createInitialUserMessage(config({ initialPromptOrigin: { kind: 'person', typedAt: 4_000 } }))?.metadata)
        .toEqual({ inputOrigin: { kind: 'person', typedAt: 4_000 } });
      expect(createInitialUserMessage(config({ initialPromptOrigin: { kind: 'person', typedAt: 9_000 } }))?.metadata)
        .toEqual({ inputOrigin: { kind: 'person', typedAt: 5_000 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a prompt nobody typed unmarked, such as a spawn or run_on_node prompt', () => {
    expect(createInitialUserMessage(config())?.metadata).toBeUndefined();
  });
});
