import { describe, expect, it } from 'vitest';
import z from 'zod';

import { defineTool } from './define-tool';
import type { ToolSafetyMetadata } from '../../shared/types/tool.types';

describe('defineTool()', () => {
  it('wraps a tool config and exposes metadata getters', () => {
    const tool = defineTool({
      description: 'Greet a user by name',
      args: z.object({ name: z.string() }),
      execute: ({ name }) => `Hello, ${name}!`,
    });

    expect(tool.description).toBe('Greet a user by name');
    expect(tool.schema).toBeDefined();
  });

  it('validates args through the Zod schema', () => {
    const tool = defineTool({
      description: 'Add two numbers',
      args: z.object({ a: z.number(), b: z.number() }),
      execute: ({ a, b }) => a + b,
    });

    expect(tool.schema.safeParse({ a: 1, b: 2 }).success).toBe(true);
    expect(tool.schema.safeParse({ a: 'bad', b: 2 }).success).toBe(false);
  });

  it('carries safety metadata when provided', () => {
    const safety: ToolSafetyMetadata = {
      isConcurrencySafe: true,
      isReadOnly: true,
      isDestructive: false,
      estimatedDurationMs: 100,
    };

    const tool = defineTool({
      description: 'Read a file',
      args: z.object({ path: z.string() }),
      safety,
      execute: ({ path }) => path,
    });

    expect(tool.safety).toEqual(safety);
  });

  it('defaults safety to non-destructive and concurrency-safe', () => {
    const tool = defineTool({
      description: 'No-op tool',
      args: z.object({}),
      execute: () => null,
    });

    expect(tool.safety.isDestructive).toBe(false);
    expect(tool.safety.isConcurrencySafe).toBe(true);
  });

  it('execute receives typed args and context', async () => {
    const tool = defineTool({
      description: 'Echo tool',
      args: z.object({ value: z.string() }),
      execute: ({ value }, ctx) => `${value} from ${ctx.instanceId}`,
    });

    const result = await tool.execute(
      { value: 'hello' },
      { instanceId: 'inst-1', workingDirectory: '/tmp' },
    );

    expect(result).toBe('hello from inst-1');
  });

  it('forwards an explicit id when provided', () => {
    const tool = defineTool({
      id: 'my-tool',
      description: 'Tool with explicit id',
      args: z.object({}),
      execute: () => null,
    });

    expect(tool.id).toBe('my-tool');
  });

  it('leaves id undefined when omitted', () => {
    const tool = defineTool({
      description: 'Tool without id',
      args: z.object({}),
      execute: () => null,
    });

    expect(tool.id).toBeUndefined();
  });
});
