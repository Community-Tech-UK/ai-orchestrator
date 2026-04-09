import { beforeEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
  },
}));

import { defineTool, isToolDefinition } from './define-tool';
import { ToolRegistry, _resetToolRegistryForTesting } from './tool-registry';
import type { ToolModule } from './tool-registry';

beforeEach(() => {
  _resetToolRegistryForTesting();
});

describe('ToolRegistry dual-path loading', () => {
  function callToLoadedTool(
    registry: ToolRegistry,
    toolId: string,
    filePath: string,
    def: unknown,
  ): unknown {
    return (
      registry as unknown as {
        toLoadedTool: (id: string, path: string, value: unknown) => unknown;
      }
    ).toLoadedTool(toolId, filePath, def);
  }

  it('accepts a legacy ToolModule', () => {
    const registry = ToolRegistry.getInstance();
    const legacyTool: ToolModule = {
      description: 'A legacy tool',
      args: { value: z.string() },
      execute: ({ value }: { value: string }) => value.toUpperCase(),
    };

    const loaded = callToLoadedTool(
      registry,
      'legacy:tool',
      '/tools/legacy.js',
      legacyTool,
    ) as { description: string; id: string } | null;

    expect(loaded).not.toBeNull();
    expect(loaded?.description).toBe('A legacy tool');
    expect(loaded?.id).toBe('legacy:tool');
  });

  it('accepts a ToolDefinition from defineTool()', () => {
    const registry = ToolRegistry.getInstance();
    const tool = defineTool({
      id: 'my-typed-tool',
      description: 'A typed tool',
      args: z.object({ count: z.number() }),
      safety: {
        isConcurrencySafe: false,
        isReadOnly: false,
        isDestructive: true,
      },
      execute: ({ count }) => count * 2,
    });

    const loaded = callToLoadedTool(
      registry,
      'fallback-id',
      '/tools/typed.js',
      tool,
    ) as { id: string; description: string; concurrencySafe: boolean } | null;

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('my-typed-tool');
    expect(loaded?.description).toBe('A typed tool');
    expect(loaded?.concurrencySafe).toBe(false);
  });

  it('distinguishes ToolDefinition from the legacy module shape', () => {
    const legacyTool: ToolModule = {
      description: 'legacy',
      execute: () => null,
    };
    const typedTool = defineTool({
      description: 'typed',
      args: z.object({}),
      execute: () => null,
    });

    expect(isToolDefinition(legacyTool)).toBe(false);
    expect(isToolDefinition(typedTool)).toBe(true);
  });
});
