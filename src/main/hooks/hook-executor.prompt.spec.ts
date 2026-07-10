import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  subQuery: vi.fn(),
}));

vi.mock('../rlm/llm-service', () => ({
  getLLMService: vi.fn(() => ({ subQuery: hoisted.subQuery })),
}));

vi.mock('../core/error-recovery', () => ({
  retryWithBackoff: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import { HookExecutor, type HookConfig } from './hook-executor';

const hook: HookConfig = {
  id: 'security-prompt',
  name: 'Security prompt',
  enabled: true,
  event: 'before-tool',
  handler: { type: 'prompt', prompt: 'Should ${command} run?' },
};

describe('legacy prompt hook evaluation', () => {
  beforeEach(() => {
    HookExecutor._resetForTesting();
    hoisted.subQuery.mockReset();
  });

  it('accepts an explicit valid approval object', async () => {
    hoisted.subQuery.mockResolvedValue('{"approved":true,"reasoning":"safe read-only command"}');

    const result = await HookExecutor.getInstance().execute(hook, { command: 'pwd' });

    expect(result.success).toBe(true);
    expect(result.output).toBe('safe read-only command');
  });

  it('fails closed when the evaluator returns prose instead of the JSON contract', async () => {
    hoisted.subQuery.mockResolvedValue('This looks allowed, but the format is uncertain.');

    const result = await HookExecutor.getInstance().execute(hook, { command: 'rm -rf target' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('invalid evaluator response');
  });

  it('fails closed when the evaluator is unavailable', async () => {
    hoisted.subQuery.mockRejectedValue(new Error('model offline'));

    const result = await HookExecutor.getInstance().execute(hook, { command: 'npm test' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('model offline');
  });
});
