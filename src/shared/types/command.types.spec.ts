import { describe, expect, it } from 'vitest';
import { BUILT_IN_COMMANDS } from './command.types';

describe('built-in /goal command', () => {
  it('is exposed as an orchestrator loop command instead of a provider-native slash command', () => {
    const command = BUILT_IN_COMMANDS.find((candidate) => candidate.name === 'goal');

    expect(command?.execution).toEqual({ type: 'goal' });
    expect(command?.applicability?.provider).toBeUndefined();
    expect(command?.applicability?.requiresWorkingDirectory).toBe(true);
    expect(command?.disabledReason).toMatch(/working directory/i);
  });
});
