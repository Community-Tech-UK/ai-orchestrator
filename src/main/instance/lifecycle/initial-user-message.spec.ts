import { describe, expect, it } from 'vitest';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { createInitialUserMessage } from './initial-user-message';

const config = (extra: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig =>
  ({ workingDirectory: '/project', initialPrompt: 'Do the task', ...extra });

describe('createInitialUserMessage', () => {
  it('marks a prompt an agent wrote so it cannot pass as the user\'s own words', () => {
    expect(createInitialUserMessage(config({ initialPromptAgentAuthored: true }))?.metadata).toEqual({ agentAuthored: true });
  });

  it('leaves a prompt the user typed unmarked', () => {
    expect(createInitialUserMessage(config())?.metadata).toBeUndefined();
  });
});
