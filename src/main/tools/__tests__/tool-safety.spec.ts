import { describe, it, expect } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
}));

import { vi } from 'vitest';
import { getToolSafety, type ToolSafetyMetadata } from '../tool-registry';
import type { ToolModule } from '../tool-registry';

function makeMinimalTool(overrides: Partial<ToolModule> = {}): ToolModule {
  return {
    description: 'test tool',
    execute: async () => ({}),
    ...overrides,
  };
}

describe('getToolSafety()', () => {
  it('returns safety metadata when tool.safety is defined', () => {
    const safety: ToolSafetyMetadata = {
      isConcurrencySafe: true,
      isReadOnly: true,
      isDestructive: false,
      estimatedDurationMs: 100,
    };
    const tool = makeMinimalTool({ safety });
    expect(getToolSafety(tool)).toEqual(safety);
  });

  it('derives isConcurrencySafe from legacy concurrencySafe=true', () => {
    const tool = makeMinimalTool({ concurrencySafe: true });
    const result = getToolSafety(tool);
    expect(result.isConcurrencySafe).toBe(true);
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(false);
  });

  it('derives isConcurrencySafe from legacy concurrencySafe=false', () => {
    const tool = makeMinimalTool({ concurrencySafe: false });
    const result = getToolSafety(tool);
    expect(result.isConcurrencySafe).toBe(false);
  });

  it('defaults isConcurrencySafe to true when neither safety nor concurrencySafe is set', () => {
    const tool = makeMinimalTool();
    const result = getToolSafety(tool);
    expect(result.isConcurrencySafe).toBe(true);
    expect(result.isReadOnly).toBe(false);
    expect(result.isDestructive).toBe(false);
  });

  it('prefers tool.safety over legacy concurrencySafe when both present', () => {
    const safety: ToolSafetyMetadata = {
      isConcurrencySafe: false,
      isReadOnly: true,
      isDestructive: false,
    };
    const tool = makeMinimalTool({ concurrencySafe: true, safety });
    // safety field takes precedence
    expect(getToolSafety(tool).isConcurrencySafe).toBe(false);
    expect(getToolSafety(tool).isReadOnly).toBe(true);
  });

  it('estimatedDurationMs is optional', () => {
    const tool = makeMinimalTool({
      safety: { isConcurrencySafe: true, isReadOnly: false, isDestructive: false },
    });
    expect(getToolSafety(tool).estimatedDurationMs).toBeUndefined();
  });
});
