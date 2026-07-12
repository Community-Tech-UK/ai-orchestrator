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

  // Fails CLOSED is correct for a genuinely-broken evaluator (above). But it is
  // NOT correct to fail closed because an *auxiliary* model was unavailable —
  // that would let a missing local model silently deny every tool call.
  //
  // The auxiliary slots (`approvalScoring` et al) return a stub payload when no
  // endpoint is healthy (`{"score":0,...,"reason":"No auxiliary model
  // available"}`). If prompt hooks ever routed through an auxiliary slot, that
  // stub would be parsed as a denial. They must use the plain subQuery path.
  //
  // hook-executor.ts:evaluatePrompt satisfies this today — it passes no
  // `auxiliarySlot`. Nothing pinned it until now, and the prompt audit already
  // found this codebase shipping quality gates that fail open by accident.
  // Rescued from tag `preserve/routing-tier-policy`.
  it('does not route prompt hooks through an auxiliary slot, so an aux fallback cannot deny them', async () => {
    hoisted.subQuery.mockImplementation(async (request: { auxiliarySlot?: string }) => {
      // Simulate the aux-slot stub that a missing local model would produce.
      if (request.auxiliarySlot) {
        return '{"score":0,"confidence":0,"reason":"No auxiliary model available"}';
      }
      return '{"approved":true,"reasoning":"normal approval path"}';
    });

    const result = await HookExecutor.getInstance().execute(hook, { command: 'pwd' });

    expect(result.success).toBe(true);
    expect(result.output).toBe('normal approval path');

    const request = hoisted.subQuery.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty('auxiliarySlot');
  });
});
