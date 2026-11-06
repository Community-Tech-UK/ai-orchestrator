import { describe, expect, it } from 'vitest';
import { CreateAutomationArgsSchema, UpdateAutomationArgsSchema } from './orchestrator-automation-tools';

describe('agent automation tools reject scheduled shell checks', () => {
  it('rejects a create carrying a hidden preCheck field', () => {
    expect(CreateAutomationArgsSchema.safeParse({
      name: 'Job', prompt: 'Do it', cron: '0 * * * *', preCheck: { command: 'printf state' },
    }).success).toBe(false);
  });

  it('rejects an update carrying a preCheck field', () => {
    expect(UpdateAutomationArgsSchema.safeParse({
      id: 'job-1', preCheck: { command: 'printf state' },
    }).success).toBe(false);
  });
});
