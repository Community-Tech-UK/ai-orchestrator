# Phase 2: Provider/Tool SDK Formalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the tool, plugin, and provider APIs with typed contracts and add a deterministic CLI mock harness for adapter testing — replacing `any`-typed payloads with safe interfaces and replacing the hard-coded provider factory with runtime registration.

**Architecture:** A new `defineTool()` builder provides typed tool authoring with validation, safety metadata, and context. Plugin hooks get typed payload interfaces via mapped types. The provider registry gains `registerProvider()` for runtime extensibility. A CLI mock harness enables deterministic adapter testing with scripted stdin/stdout interactions.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest, Node.js child_process mocking

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/shared/types/plugin.types.ts` | Typed plugin hook payload interfaces |
| Create | `src/main/tools/define-tool.ts` | `defineTool()` builder with typed args |
| Create | `src/main/tools/define-tool.spec.ts` | TDD tests for defineTool |
| Create | `src/main/tools/tool-registry-interop.spec.ts` | Legacy + new tool interop tests |
| Create | `src/main/plugins/plugin-manager.spec.ts` | Typed hook tests |
| Create | `src/main/providers/provider-registry.spec.ts` | Runtime registration tests |
| Create | `src/main/cli/__tests__/cli-mock-harness.ts` | Mock CLI process for adapter testing |
| Create | `src/main/cli/__tests__/cli-mock-harness.spec.ts` | Harness self-tests |
| Create | `src/main/cli/__tests__/adapter-parity.spec.ts` | Cross-adapter parity tests |
| Modify | `src/main/plugins/plugin-manager.ts` | Use typed hooks, generic emit |
| Modify | `src/main/tools/tool-registry.ts` | Accept `ToolDefinition` alongside `ToolModule` |
| Modify | `src/main/providers/provider-registry.ts` | Runtime `registerProvider()` / `unregisterProvider()` |

## Pre-flight Checks

Before starting, verify the baseline is green:

```bash
cd /Users/suas/work/orchestrat0r/ai-orchestrator
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```

All four commands must pass with zero errors before any task begins. If they don't, fix baseline issues first.

---

## Task Group A: Typed Plugin Hooks

### A1 — Create `src/shared/types/plugin.types.ts` with typed hook payloads

**File:** `src/shared/types/plugin.types.ts` (new file)

The current `OrchestratorHooks` type in `src/main/plugins/plugin-manager.ts` is:
```typescript
export type OrchestratorHooks = Partial<Record<string, (payload: any) => void | Promise<void>>>;
```

This task replaces that loose map with a properly typed mapped type.

- [ ] Create `src/shared/types/plugin.types.ts` with the following exact content:

```typescript
/**
 * Typed plugin hook payloads for the Orchestrator plugin system.
 *
 * These interfaces define the exact shape of the data passed to each hook.
 * They live in src/shared/ so both the main process (PluginManager) and
 * any future renderer-side tooling can import them without circular deps.
 */

import type { OutputMessage } from './instance.types';

/**
 * Typed payload for every plugin hook event.
 * Keys must match the event strings used in PluginManager.emitToPlugins().
 */
export interface PluginHookPayloads {
  'instance.created': {
    instanceId: string;
    workingDirectory: string;
    provider: string;
  };
  'instance.removed': {
    instanceId: string;
  };
  'instance.output': {
    instanceId: string;
    message: OutputMessage;
  };
  'verification.started': {
    instanceId: string;
    verificationId: string;
  };
  'verification.completed': {
    instanceId: string;
    verificationId: string;
    result: unknown;
  };
  'verification.error': {
    instanceId: string;
    verificationId: string;
    error: string;
  };
}

/**
 * Union of all valid hook event names.
 */
export type PluginHookEvent = keyof PluginHookPayloads;

/**
 * Typed hook map — each key maps to a handler receiving the correct payload type.
 * Replaces the old `Partial<Record<string, (payload: any) => ...>>` contract.
 */
export type TypedOrchestratorHooks = {
  [K in PluginHookEvent]?: (payload: PluginHookPayloads[K]) => void | Promise<void>;
};
```

- [ ] Run `npx tsc --noEmit` — must pass (new file introduces no errors yet).

---

### A2 — Update `plugin-manager.ts` to use `TypedOrchestratorHooks`

**File:** `src/main/plugins/plugin-manager.ts`

- [ ] Add the import at the top of the file (after the existing `getLogger` import):

```typescript
import type { PluginHookPayloads, PluginHookEvent, TypedOrchestratorHooks } from '../../shared/types/plugin.types';
```

- [ ] Add the `OutputMessage` import (not previously imported in plugin-manager.ts):

```typescript
import type { OutputMessage } from '../../shared/types/instance.types';
```

- [ ] Replace the exported type aliases (the `OrchestratorHooks` and `OrchestratorPluginModule` lines) with:

```typescript
export type OrchestratorHooks = TypedOrchestratorHooks;
export type OrchestratorPluginModule =
  | OrchestratorHooks
  | ((ctx: OrchestratorPluginContext) => OrchestratorHooks | Promise<OrchestratorHooks>);
```

- [ ] Update the `LoadedPlugin` interface so the `hooks` field uses the typed type:

```typescript
interface LoadedPlugin {
  filePath: string;
  hooks: TypedOrchestratorHooks;
}
```

- [ ] Replace the `emitToPlugins` method signature and body to be generic on event name:

```typescript
private async emitToPlugins<K extends PluginHookEvent>(
  workingDirectory: string,
  ctx: OrchestratorPluginContext,
  event: K,
  payload: PluginHookPayloads[K],
): Promise<void> {
  const plugins = await this.getPlugins(workingDirectory, ctx);
  for (const plugin of plugins) {
    const hook = plugin.hooks[event];
    if (!hook) continue;
    try {
      await (hook as (p: PluginHookPayloads[K]) => void | Promise<void>)(payload);
    } catch {
      // Never let plugins crash the host.
    }
  }
}
```

- [ ] Update each `emitToPlugins` call site in `initialize()` to pass typed payloads:

```typescript
instanceManager.on('instance:created', (payload: { instanceId: string; workingDirectory: string; provider?: string }) => {
  const wd = payload?.workingDirectory || process.cwd();
  void this.emitToPlugins(wd, ctx, 'instance.created', {
    instanceId: payload.instanceId,
    workingDirectory: payload.workingDirectory,
    provider: payload.provider ?? 'unknown',
  });
});

instanceManager.on('instance:removed', (instanceId: string) => {
  void this.emitToPlugins(process.cwd(), ctx, 'instance.removed', { instanceId });
});

instanceManager.on('instance:output', (payload: { instanceId: string; message: OutputMessage }) => {
  const instance = instanceManager.getInstance(payload?.instanceId);
  const wd = instance?.workingDirectory || process.cwd();
  void this.emitToPlugins(wd, ctx, 'instance.output', {
    instanceId: payload.instanceId,
    message: payload.message,
  });
});

verify.on('verification:started', (payload: { instanceId: string; id: string }) => {
  const instance = instanceManager.getInstance(payload?.instanceId);
  const wd = instance?.workingDirectory || process.cwd();
  void this.emitToPlugins(wd, ctx, 'verification.started', {
    instanceId: payload.instanceId,
    verificationId: payload.id,
  });
});

verify.on('verification:completed', (payload: { instanceId?: string; id: string; result?: unknown }) => {
  void this.emitToPlugins(process.cwd(), ctx, 'verification.completed', {
    instanceId: payload.instanceId ?? '',
    verificationId: payload.id,
    result: payload.result,
  });
});

verify.on('verification:error', (payload: { instanceId?: string; id: string; error?: string }) => {
  void this.emitToPlugins(process.cwd(), ctx, 'verification.error', {
    instanceId: payload.instanceId ?? '',
    verificationId: payload.id,
    error: payload.error ?? 'unknown error',
  });
});
```

- [ ] Run `npx tsc --noEmit` — must pass with zero errors.

---

### A3 — Write tests for typed plugin hooks

**File:** `src/main/plugins/plugin-manager.spec.ts` (new file)

- [ ] Create the test file:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-home'),
    getAppPath: vi.fn().mockReturnValue('/tmp/test-app'),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../orchestration/multi-verify-coordinator', () => ({
  getMultiVerifyCoordinator: () => ({ on: vi.fn() }),
}));

import {
  _resetOrchestratorPluginManagerForTesting,
  OrchestratorPluginManager,
} from './plugin-manager';
import type { TypedOrchestratorHooks } from '../../shared/types/plugin.types';

beforeEach(() => {
  _resetOrchestratorPluginManagerForTesting();
});

describe('TypedOrchestratorHooks contract', () => {
  it('accepts a valid typed hook object without TypeScript errors', () => {
    // Compile-time check: if the types are wrong, tsc catches it.
    const hooks: TypedOrchestratorHooks = {
      'instance.created': (payload) => {
        const _id: string = payload.instanceId;
        const _wd: string = payload.workingDirectory;
        const _prov: string = payload.provider;
        void _id; void _wd; void _prov;
      },
      'instance.removed': (payload) => {
        const _id: string = payload.instanceId;
        void _id;
      },
      'verification.error': (payload) => {
        const _err: string = payload.error;
        void _err;
      },
    };
    expect(Object.keys(hooks)).toHaveLength(3);
  });

  it('OrchestratorPluginManager is a singleton', () => {
    const a = OrchestratorPluginManager.getInstance();
    const b = OrchestratorPluginManager.getInstance();
    expect(a).toBe(b);
  });

  it('_resetForTesting creates a new instance', () => {
    const a = OrchestratorPluginManager.getInstance();
    _resetOrchestratorPluginManagerForTesting();
    const b = OrchestratorPluginManager.getInstance();
    expect(a).not.toBe(b);
  });
});
```

- [ ] Run: `npx vitest run src/main/plugins/plugin-manager.spec.ts`
- [ ] All 3 tests must pass.
- [ ] Run `npx tsc --noEmit -p tsconfig.spec.json` — must pass.

---

### A4 — Commit Group A

```bash
git add src/shared/types/plugin.types.ts src/main/plugins/plugin-manager.ts src/main/plugins/plugin-manager.spec.ts
git commit -m "feat(plugins): typed hook payloads via PluginHookPayloads mapped type"
```

---

## Task Group B: `defineTool()` Builder

### B1 — Write the `defineTool()` test first (TDD)

**File:** `src/main/tools/define-tool.spec.ts` (new file)

- [ ] Create the test file:

```typescript
import { describe, it, expect } from 'vitest';
import z from 'zod';

// Import will fail until B2 creates the module — expected (TDD red phase).
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

    const validParse = tool.schema.safeParse({ a: 1, b: 2 });
    expect(validParse.success).toBe(true);

    const invalidParse = tool.schema.safeParse({ a: 'not-a-number', b: 2 });
    expect(invalidParse.success).toBe(false);
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

  it('defaults safety to non-destructive, concurrency-safe when omitted', () => {
    const tool = defineTool({
      description: 'No-op tool',
      args: z.object({}),
      execute: () => null,
    });

    expect(tool.safety.isDestructive).toBe(false);
    expect(tool.safety.isConcurrencySafe).toBe(true);
  });

  it('execute function receives typed args and context', async () => {
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

  it('optional id is forwarded when provided', () => {
    const tool = defineTool({
      id: 'my-tool',
      description: 'Tool with explicit id',
      args: z.object({}),
      execute: () => null,
    });

    expect(tool.id).toBe('my-tool');
  });

  it('id is undefined when not provided', () => {
    const tool = defineTool({
      description: 'Tool without id',
      args: z.object({}),
      execute: () => null,
    });

    expect(tool.id).toBeUndefined();
  });
});
```

- [ ] Run: `npx vitest run src/main/tools/define-tool.spec.ts`
- [ ] Confirm it FAILS with "Cannot find module './define-tool'" (red phase confirmed).

---

### B2 — Implement `src/main/tools/define-tool.ts`

**File:** `src/main/tools/define-tool.ts` (new file)

- [ ] Create the implementation:

```typescript
/**
 * defineTool() — typed tool builder for the Orchestrator tool registry.
 *
 * Provides a single surface for defining a tool's description, Zod schema,
 * safety metadata, and execute function with full TypeScript inference.
 *
 * The resulting ToolDefinition is accepted by ToolRegistry alongside the
 * legacy { description, args, execute } ToolModule contract.
 *
 * Usage:
 *   module.exports = defineTool({
 *     description: 'Read a file',
 *     args: z.object({ path: z.string() }),
 *     safety: { isConcurrencySafe: true, isReadOnly: true, isDestructive: false },
 *     execute: async ({ path }, ctx) => readFileSync(path, 'utf8'),
 *   });
 */

import z from 'zod';
import type { ToolSafetyMetadata } from '../../shared/types/tool.types';
import type { ToolContext } from './tool-registry';

const DEFAULT_SAFETY: ToolSafetyMetadata = {
  isConcurrencySafe: true,
  isReadOnly: false,
  isDestructive: false,
};

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Optional stable identifier. When omitted, the registry derives one from the file path. */
  readonly id?: string;
  /** Human-readable description of what the tool does. */
  readonly description: string;
  /** Compiled Zod schema for the tool's argument object. */
  readonly schema: TSchema;
  /** Safety metadata used by the orchestration scheduler. */
  readonly safety: ToolSafetyMetadata;
  /** Execute the tool with validated args and context. */
  execute(args: z.infer<TSchema>, ctx: ToolContext): unknown | Promise<unknown>;
  /** Marker so ToolRegistry can distinguish ToolDefinition from legacy ToolModule. */
  readonly __isToolDefinition: true;
}

export interface ToolDefinitionConfig<TSchema extends z.ZodTypeAny> {
  id?: string;
  description: string;
  args: TSchema;
  safety?: ToolSafetyMetadata;
  execute: (args: z.infer<TSchema>, ctx: ToolContext) => unknown | Promise<unknown>;
}

/**
 * Build a fully-typed ToolDefinition from a config object.
 *
 * @example
 * ```typescript
 * module.exports = defineTool({
 *   description: 'Run a shell command',
 *   args: z.object({ command: z.string() }),
 *   safety: { isConcurrencySafe: false, isReadOnly: false, isDestructive: true },
 *   execute: async ({ command }, ctx) => runCommand(command, ctx.workingDirectory),
 * });
 * ```
 */
export function defineTool<TSchema extends z.ZodTypeAny>(
  config: ToolDefinitionConfig<TSchema>,
): ToolDefinition<TSchema> {
  return {
    id: config.id,
    description: config.description,
    schema: config.args,
    safety: config.safety ?? { ...DEFAULT_SAFETY },
    execute: config.execute,
    __isToolDefinition: true,
  };
}

/**
 * Type guard: returns true if value is a ToolDefinition created by defineTool().
 */
export function isToolDefinition(value: unknown): value is ToolDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['__isToolDefinition'] === true
  );
}
```

- [ ] Run: `npx vitest run src/main/tools/define-tool.spec.ts`
- [ ] All 7 tests must pass (green phase).
- [ ] Run `npx tsc --noEmit` — must pass.

---

### B3 — Update `ToolRegistry.loadModule()` to accept `ToolDefinition`

**File:** `src/main/tools/tool-registry.ts`

The `toLoadedTool()` method currently only handles `ToolModule`. We need to accept both `ToolModule` and `ToolDefinition`.

- [ ] Add the imports at the top of `tool-registry.ts` (after the existing `ToolSafetyMetadata` import line):

```typescript
import { isToolDefinition } from './define-tool';
import type { ToolDefinition } from './define-tool';
```

- [ ] Update the `loadModule` return type to include `ToolDefinition`:

```typescript
private loadModule(filePath: string): ToolModule | ToolDefinition {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve(filePath)];
  } catch {
    /* intentionally ignored: require.resolve may fail for some module paths */
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(filePath);
  const def = (mod && (mod.default || mod)) as ToolModule | ToolDefinition;
  return def;
}
```

- [ ] Replace the `toLoadedTool` method signature and body to handle both contracts:

```typescript
private toLoadedTool(toolId: string, filePath: string, def: ToolModule | ToolDefinition): LoadedTool | null {
  if (!def || typeof def !== 'object') return null;

  // ToolDefinition path (created via defineTool())
  if (isToolDefinition(def)) {
    return {
      id: def.id ?? toolId,
      description: def.description,
      filePath,
      schema: def.schema,
      concurrencySafe: def.safety.isConcurrencySafe,
    };
  }

  // Legacy ToolModule path — unchanged behaviour
  if (typeof def.description !== 'string') return null;
  if (typeof def.execute !== 'function') return null;

  let schema: z.ZodTypeAny;
  if (!def.args) {
    schema = z.object({});
  } else if (def.args instanceof z.ZodType) {
    schema = def.args;
  } else {
    schema = z.object(def.args as z.ZodRawShape);
  }

  return {
    id: toolId,
    description: def.description,
    filePath,
    schema,
    concurrencySafe: def.concurrencySafe !== false,
  };
}
```

- [ ] Run `npx tsc --noEmit` — must pass.

---

### B4 — Write integration test: legacy module still works alongside `defineTool`

**File:** `src/main/tools/tool-registry-interop.spec.ts` (new file)

- [ ] Create the test file:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import z from 'zod';

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp'), getAppPath: vi.fn().mockReturnValue('/tmp') },
}));

import { defineTool, isToolDefinition } from './define-tool';
import { ToolRegistry, _resetToolRegistryForTesting } from './tool-registry';
import type { ToolModule } from './tool-registry';

beforeEach(() => {
  _resetToolRegistryForTesting();
});

describe('ToolRegistry.toLoadedTool() dual-path acceptance', () => {
  function callToLoadedTool(
    registry: ToolRegistry,
    toolId: string,
    filePath: string,
    def: unknown,
  ) {
    return (registry as unknown as {
      toLoadedTool(id: string, fp: string, def: unknown): unknown;
    }).toLoadedTool(toolId, filePath, def);
  }

  it('accepts a legacy ToolModule', () => {
    const registry = ToolRegistry.getInstance();
    const legacyTool: ToolModule = {
      description: 'A legacy tool',
      args: { value: z.string() },
      execute: ({ value }: { value: string }) => value.toUpperCase(),
    };

    const loaded = callToLoadedTool(registry, 'legacy:tool', '/tools/legacy.js', legacyTool);
    expect(loaded).not.toBeNull();
    expect((loaded as { description: string }).description).toBe('A legacy tool');
    expect((loaded as { id: string }).id).toBe('legacy:tool');
  });

  it('accepts a ToolDefinition from defineTool()', () => {
    const registry = ToolRegistry.getInstance();
    const tool = defineTool({
      id: 'my-typed-tool',
      description: 'A typed tool',
      args: z.object({ count: z.number() }),
      safety: { isConcurrencySafe: false, isReadOnly: false, isDestructive: true },
      execute: ({ count }) => count * 2,
    });

    const loaded = callToLoadedTool(registry, 'fallback-id', '/tools/typed.js', tool);
    expect(loaded).not.toBeNull();
    // When ToolDefinition has an explicit id, that takes precedence over the derived toolId
    expect((loaded as { id: string }).id).toBe('my-typed-tool');
    expect((loaded as { description: string }).description).toBe('A typed tool');
    // concurrencySafe maps from safety.isConcurrencySafe
    expect((loaded as { concurrencySafe: boolean }).concurrencySafe).toBe(false);
  });

  it('isToolDefinition() correctly distinguishes the two shapes', () => {
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
```

- [ ] Run: `npx vitest run src/main/tools/tool-registry-interop.spec.ts`
- [ ] All 3 tests must pass.
- [ ] Run `npx tsc --noEmit -p tsconfig.spec.json` — must pass.

---

### B5 — Commit Group B

```bash
git add src/main/tools/define-tool.ts src/main/tools/define-tool.spec.ts src/main/tools/tool-registry.ts src/main/tools/tool-registry-interop.spec.ts
git commit -m "feat(tools): defineTool() typed builder with dual-path ToolRegistry acceptance"
```

---

## Task Group C: Extensible Provider Registry

### C1 — Write provider registry extensibility tests first (TDD)

**File:** `src/main/providers/provider-registry.spec.ts` (new file)

- [ ] Create the test file:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock all provider constructors so no real CLI environment is required
vi.mock('./claude-cli-provider', () => ({
  ClaudeCliProvider: vi.fn().mockImplementation(() => ({ type: 'claude-cli' })),
}));
vi.mock('./codex-cli-provider', () => ({
  CodexCliProvider: vi.fn().mockImplementation(() => ({ type: 'openai' })),
}));
vi.mock('./gemini-cli-provider', () => ({
  GeminiCliProvider: vi.fn().mockImplementation(() => ({ type: 'google' })),
}));
vi.mock('./anthropic-api-provider', () => ({
  AnthropicApiProvider: vi.fn().mockImplementation(() => ({ type: 'anthropic-api' })),
}));
vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: vi.fn().mockReturnValue({
      detectAll: vi.fn().mockResolvedValue({ available: [] }),
    }),
  },
}));

import { ProviderRegistry } from './provider-registry';
import type { ProviderConfig } from '../../shared/types/provider.types';
import type { BaseProvider } from './provider-interface';

function makeMinimalProvider(type: string): BaseProvider {
  return { type } as unknown as BaseProvider;
}

describe('ProviderRegistry.registerProvider()', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it('registers a custom provider factory and creates an instance', () => {
    registry.registerProvider('ollama', (config) => makeMinimalProvider(config.type), {
      name: 'Ollama',
      enabled: true,
      apiEndpoint: 'http://localhost:11434',
      defaultModel: 'llama3',
    });

    expect(registry.isSupported('ollama')).toBe(true);
    const instance = registry.createProvider('ollama' as never);
    expect(instance).toBeDefined();
  });

  it('allows overriding a built-in provider factory', () => {
    let factoryCalled = false;
    registry.registerProvider('claude-cli', (config) => {
      factoryCalled = true;
      return makeMinimalProvider(config.type);
    });

    registry.createProvider('claude-cli');
    expect(factoryCalled).toBe(true);
  });

  it('unregisterProvider() removes the factory, making isSupported() return false', () => {
    registry.registerProvider('ollama', (config) => makeMinimalProvider(config.type), {
      name: 'Ollama',
      enabled: true,
    });
    expect(registry.isSupported('ollama')).toBe(true);

    registry.unregisterProvider('ollama');
    expect(registry.isSupported('ollama')).toBe(false);
  });

  it('throws when creating a provider with no registered factory', () => {
    expect(() => registry.createProvider('amazon-bedrock')).toThrow(
      "Provider type 'amazon-bedrock' is not yet implemented",
    );
  });

  it('registerProvider() merges the default config into the registry', () => {
    const partialConfig: Partial<ProviderConfig> = {
      name: 'My Ollama',
      enabled: true,
      defaultModel: 'mistral',
    };

    registry.registerProvider(
      'ollama',
      (config) => makeMinimalProvider(config.type),
      partialConfig,
    );

    const config = registry.getConfig('ollama' as never);
    expect(config).toBeDefined();
    expect(config?.name).toBe('My Ollama');
    expect(config?.defaultModel).toBe('mistral');
  });

  it('built-in providers are supported by default', () => {
    expect(registry.isSupported('claude-cli')).toBe(true);
    expect(registry.isSupported('anthropic-api')).toBe(true);
    expect(registry.isSupported('openai')).toBe(true);
    expect(registry.isSupported('google')).toBe(true);
  });
});
```

- [ ] Run: `npx vitest run src/main/providers/provider-registry.spec.ts`
- [ ] Confirm tests fail because `registerProvider` and `unregisterProvider` do not exist yet (red phase).

---

### C2 — Implement `registerProvider()`, `unregisterProvider()`, and `registerBuiltinProviders()`

**File:** `src/main/providers/provider-registry.ts`

- [ ] Remove the module-level `PROVIDER_FACTORIES` constant entirely (the `const PROVIDER_FACTORIES: Partial<Record<ProviderType, ProviderFactory>> = { ... }` block).

- [ ] Update the class field declarations to widen the map key types from `ProviderType` to `string`, and add the `factories` map. Find the start of the `ProviderRegistry` class and replace the four field declarations:

```typescript
export class ProviderRegistry {
  private configs = new Map<string, ProviderConfig>();
  private factories = new Map<string, ProviderFactory>();
  private statusCache = new Map<string, ProviderStatus>();
  private statusCacheTime = new Map<string, number>();
  private readonly STATUS_CACHE_TTL = 60000; // 1 minute
```

- [ ] Update the constructor to call `registerBuiltinProviders()`:

```typescript
  constructor() {
    // Initialize with default configs
    for (const [type, config] of Object.entries(DEFAULT_PROVIDER_CONFIGS)) {
      this.configs.set(type, { ...config });
    }
    this.registerBuiltinProviders();
  }
```

- [ ] Add `registerBuiltinProviders()` as a private method immediately after the constructor:

```typescript
  private registerBuiltinProviders(): void {
    this.factories.set('claude-cli', (config) => new ClaudeCliProvider(config));
    this.factories.set('anthropic-api', (config) => new AnthropicApiProvider(config));
    this.factories.set('openai', (config) => new CodexCliProvider(config));
    this.factories.set('google', (config) => new GeminiCliProvider(config));
  }
```

- [ ] Add the two new public methods before `getAllConfigs()`:

```typescript
  /**
   * Register a provider factory at runtime.
   * Replaces any existing factory for the given type.
   * Optionally merges a partial default config into the registry.
   */
  registerProvider(
    type: string,
    factory: ProviderFactory,
    defaultConfig?: Partial<ProviderConfig>,
  ): void {
    this.factories.set(type, factory);
    if (defaultConfig) {
      const existing = this.configs.get(type);
      const merged: ProviderConfig = {
        type: (existing?.type ?? type) as ProviderType,
        name: defaultConfig.name ?? existing?.name ?? type,
        enabled: defaultConfig.enabled ?? existing?.enabled ?? false,
        ...existing,
        ...defaultConfig,
      };
      this.configs.set(type, merged);
    }
    this.statusCache.delete(type);
    this.statusCacheTime.delete(type);
  }

  /**
   * Unregister a provider factory. Primarily useful in tests.
   * Does not remove the config entry — only the factory.
   */
  unregisterProvider(type: string): void {
    this.factories.delete(type);
    this.statusCache.delete(type);
    this.statusCacheTime.delete(type);
  }
```

- [ ] Update `isSupported()` to use the instance `factories` map:

```typescript
  isSupported(type: string): boolean {
    return this.factories.has(type);
  }
```

- [ ] Update `createProvider()` to use the instance `factories` map:

```typescript
  createProvider(type: ProviderType, configOverrides?: Partial<ProviderConfig>): BaseProvider {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Provider type '${type}' is not yet implemented`);
    }

    const baseConfig = this.configs.get(type);
    if (!baseConfig) {
      throw new Error(`No configuration found for provider '${type}'`);
    }

    const config = { ...baseConfig, ...configOverrides };
    return factory(config);
  }
```

- [ ] Run: `npx vitest run src/main/providers/provider-registry.spec.ts`
- [ ] All 6 tests must pass (green phase).
- [ ] Run `npx tsc --noEmit` — must pass.

---

### C3 — Commit Group C

```bash
git add src/main/providers/provider-registry.ts src/main/providers/provider-registry.spec.ts
git commit -m "feat(providers): runtime registerProvider() / unregisterProvider() replaces hard-coded factory map"
```

---

## Task Group D: CLI Mock Harness

### D1 — Create the mock harness infrastructure

**File:** `src/main/cli/__tests__/cli-mock-harness.ts` (new file)

- [ ] Create the directory: `mkdir -p /Users/suas/work/orchestrat0r/ai-orchestrator/src/main/cli/__tests__`

- [ ] Create the harness file:

```typescript
/**
 * CLI Mock Harness — deterministic stdin/stdout simulation for adapter tests.
 *
 * Allows tests to script an interaction sequence and drive an adapter through
 * that sequence without spawning a real process.
 *
 * Usage:
 *   const harness = new MockCliHarness();
 *   harness.script([
 *     { trigger: 'hello', response: 'world\n' },
 *     { trigger: 'bye', exitCode: 0 },
 *   ]);
 *   const proc = harness.createProcess();
 *   // Inject into adapter: vi.spyOn(adapter, 'spawnProcess').mockReturnValue(proc)
 */

import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

export interface ScriptStep {
  /** Text to match in stdin input (substring match) */
  trigger: string;
  /** Lines to write to stdout when triggered. Include trailing \n. */
  response?: string;
  /** If set, emit 'close' with this exit code instead of writing a response */
  exitCode?: number;
  /** Delay in ms before emitting response (default: 0) */
  delayMs?: number;
}

/** The subset of ChildProcess that adapters interact with. */
export type MockChildProcess = Pick<ChildProcess, 'pid' | 'kill'> &
  EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
  };

export class MockCliHarness {
  private steps: ScriptStep[] = [];
  private proc: MockChildProcess | null = null;
  private stdinBuffer = '';

  /**
   * Provide an ordered list of scripted interaction steps.
   * Steps are consumed in order as stdin data matches each trigger.
   */
  script(steps: ScriptStep[]): this {
    this.steps = [...steps];
    return this;
  }

  /**
   * Create a mock ChildProcess that plays through the scripted steps.
   * Pass the returned object anywhere a ChildProcess is expected.
   */
  createProcess(pid = 9999): MockChildProcess {
    const proc = new EventEmitter() as MockChildProcess;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.killed = false;
    proc.pid = pid;
    proc.kill = ((signal?: string | number) => {
      if (!proc.killed) {
        proc.killed = true;
        setImmediate(() => proc.emit('close', signal === 'SIGKILL' ? 137 : 0, null));
      }
      return true;
    }) as ChildProcess['kill'];

    const remainingSteps = [...this.steps];

    proc.stdin.on('data', (chunk: Buffer) => {
      this.stdinBuffer += chunk.toString();
      const step = remainingSteps[0];
      if (!step) return;
      if (this.stdinBuffer.includes(step.trigger)) {
        remainingSteps.shift();
        this.stdinBuffer = '';
        const delay = step.delayMs ?? 0;
        const fire = () => {
          if (step.exitCode !== undefined) {
            proc.emit('close', step.exitCode, null);
            return;
          }
          if (step.response) {
            proc.stdout.write(step.response);
          }
        };
        if (delay > 0) {
          setTimeout(fire, delay);
        } else {
          setImmediate(fire);
        }
      }
    });

    this.proc = proc;
    return proc;
  }

  /**
   * Emit an unprompted stdout line — useful for simulating startup sequences
   * that happen before any stdin is sent.
   */
  emitStdout(line: string): void {
    if (!this.proc) throw new Error('createProcess() must be called before emitStdout()');
    this.proc.stdout.write(line);
  }

  /**
   * Simulate a process crash with the given exit code.
   */
  crash(code = 1): void {
    if (!this.proc) throw new Error('createProcess() must be called before crash()');
    this.proc.emit('close', code, null);
  }

  /**
   * Simulate a clean process exit (code 0).
   */
  exit(): void {
    if (!this.proc) throw new Error('createProcess() must be called before exit()');
    this.proc.emit('close', 0, null);
  }
}
```

- [ ] Run `npx tsc --noEmit` — must pass.

---

### D2 — Write harness self-tests

**File:** `src/main/cli/__tests__/cli-mock-harness.spec.ts` (new file)

- [ ] Create the test file:

```typescript
import { describe, it, expect } from 'vitest';
import { MockCliHarness } from './cli-mock-harness';

function collectStdout(proc: ReturnType<MockCliHarness['createProcess']>): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    proc.stdout.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    proc.once('close', () => resolve(lines));
  });
}

describe('MockCliHarness', () => {
  it('responds to stdin trigger with scripted stdout', async () => {
    const harness = new MockCliHarness();
    harness.script([{ trigger: 'ping', response: 'pong\n' }]);
    const proc = harness.createProcess();

    const linesPromise = collectStdout(proc);
    proc.stdin.write('ping\n');
    harness.exit();

    const lines = await linesPromise;
    expect(lines.join('')).toContain('pong');
  });

  it('emits close with the scripted exit code when exitCode is set', async () => {
    const harness = new MockCliHarness();
    harness.script([{ trigger: 'crash-me', exitCode: 2 }]);
    const proc = harness.createProcess();

    const closedWith = await new Promise<number | null>((resolve) => {
      proc.once('close', (code) => resolve(code));
      proc.stdin.write('crash-me\n');
    });

    expect(closedWith).toBe(2);
  });

  it('kill() sets killed flag and emits close', async () => {
    const harness = new MockCliHarness();
    harness.script([]);
    const proc = harness.createProcess();

    const closedWith = await new Promise<number | null>((resolve) => {
      proc.once('close', (code) => resolve(code));
      proc.kill('SIGTERM');
    });

    expect(proc.killed).toBe(true);
    expect(closedWith).toBe(0);
  });

  it('emitStdout() sends data before any stdin', async () => {
    const harness = new MockCliHarness();
    harness.script([]);
    const proc = harness.createProcess();

    const linePromise = new Promise<string>((resolve) => {
      proc.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    });

    harness.emitStdout('startup-banner\n');
    const line = await linePromise;
    expect(line).toBe('startup-banner\n');
  });

  it('crash() emits close with non-zero code', async () => {
    const harness = new MockCliHarness();
    harness.script([]);
    const proc = harness.createProcess();

    const codePromise = new Promise<number | null>((resolve) => {
      proc.once('close', (code) => resolve(code));
    });

    harness.crash(137);
    expect(await codePromise).toBe(137);
  });
});
```

- [ ] Run: `npx vitest run src/main/cli/__tests__/cli-mock-harness.spec.ts`
- [ ] All 5 tests must pass.

---

### D3 — Write adapter parity tests using the harness

**File:** `src/main/cli/__tests__/adapter-parity.spec.ts` (new file)

This file verifies that `ClaudeCliAdapter` and `GeminiCliAdapter` share identical lifecycle behavior for five core scenarios. (`CodexCliAdapter` is excluded because its dual-mode app-server spawn path requires additional mock setup — it has a dedicated spec file.)

- [ ] Create the test file:

```typescript
/**
 * Adapter parity tests — verify that CLI adapters handle core lifecycle
 * scenarios consistently, using MockCliHarness for deterministic I/O.
 *
 * Scenarios:
 *   1. Process spawns and emits 'spawned' event
 *   2. Graceful terminate
 *   3. Forced kill
 *   4. Process crash (non-zero exit code)
 *   5a. interrupt() returns true when process is running
 *   5b. interrupt() returns false when no process is running
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../security/env-filter', () => ({
  getSafeEnvForTrustedProcess: () => ({ ...process.env }),
}));

vi.mock('../../context/output-persistence', () => ({
  getOutputPersistenceManager: () => ({
    maybeExternalize: (_name: string, content: string) => Promise.resolve(content),
  }),
}));

import { ClaudeCliAdapter } from '../adapters/claude-cli-adapter';
import { GeminiCliAdapter } from '../adapters/gemini-cli-adapter';
import { MockCliHarness } from './cli-mock-harness';
import type { BaseCliAdapter } from '../adapters/base-cli-adapter';

type TargetAdapter = BaseCliAdapter & {
  interrupt(): boolean;
};

interface AdapterFixture {
  name: string;
  create(): TargetAdapter;
}

const ADAPTER_FIXTURES: AdapterFixture[] = [
  {
    name: 'ClaudeCliAdapter',
    create: () => new ClaudeCliAdapter() as unknown as TargetAdapter,
  },
  {
    name: 'GeminiCliAdapter',
    create: () => new GeminiCliAdapter() as unknown as TargetAdapter,
  },
];

describe.each(ADAPTER_FIXTURES)('$name lifecycle parity', ({ create }) => {
  let adapter: TargetAdapter;
  let harness: MockCliHarness;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = create();
    harness = new MockCliHarness();
    harness.script([]);

    spawnSpy = vi.spyOn(
      adapter as unknown as { spawnProcess(args: string[]): ChildProcess },
      'spawnProcess',
    ).mockImplementation(() => harness.createProcess() as unknown as ChildProcess);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('scenario 1: emits spawned event when spawnProcess is called', async () => {
    const spawnedPids: number[] = [];
    adapter.on('spawned', (pid: number) => spawnedPids.push(pid));

    (adapter as unknown as { spawnProcess(args: string[]): ChildProcess }).spawnProcess([]);
    await new Promise((r) => setImmediate(r));

    expect(spawnedPids).toContain(9999);
  });

  it('scenario 2: graceful terminate resolves without throwing', async () => {
    const mockProc = harness.createProcess();
    (adapter as unknown as { process: unknown }).process = mockProc as unknown;

    const terminatePromise = adapter.terminate(true);
    await new Promise((r) => setImmediate(r));
    harness.exit();
    await expect(terminatePromise).resolves.toBeUndefined();
  });

  it('scenario 3: forced kill resolves without throwing', async () => {
    (adapter as unknown as { process: unknown }).process =
      harness.createProcess() as unknown;

    const terminatePromise = adapter.terminate(false);
    await new Promise((r) => setImmediate(r));
    await expect(terminatePromise).resolves.toBeUndefined();
  });

  it('scenario 4: crash (non-zero close event) does not throw', () => {
    const mockProc = harness.createProcess();
    (adapter as unknown as { process: unknown }).process = mockProc as unknown;

    // Verify no exception is thrown when the process exits unexpectedly
    expect(() => {
      mockProc.emit('close', 137, null);
    }).not.toThrow();
  });

  it('scenario 5a: interrupt() returns true when process is running', () => {
    const mockProc = harness.createProcess();
    (adapter as unknown as { process: unknown }).process = mockProc as unknown;

    const result = adapter.interrupt();
    expect(result).toBe(true);
  });

  it('scenario 5b: interrupt() returns false when no process is running', () => {
    // adapter.process is null by default after construction
    const result = adapter.interrupt();
    expect(result).toBe(false);
  });
});
```

- [ ] Run: `npx vitest run src/main/cli/__tests__/adapter-parity.spec.ts`
- [ ] All tests must pass for both adapters (12 tests total: 6 scenarios × 2 adapters).
- [ ] Run `npx tsc --noEmit -p tsconfig.spec.json` — must pass.

---

### D4 — Commit Group D

```bash
git add src/main/cli/__tests__/cli-mock-harness.ts src/main/cli/__tests__/cli-mock-harness.spec.ts src/main/cli/__tests__/adapter-parity.spec.ts
git commit -m "test(adapters): CLI mock harness with scripted stdin/stdout and adapter parity suite"
```

---

## Task Group E: Final Verification

### E1 — Run full test suite

- [ ] Run:
  ```bash
  cd /Users/suas/work/orchestrat0r/ai-orchestrator
  npm run test
  ```
- [ ] All tests must pass. Note the final count: `X passed, 0 failed`.

---

### E2 — TypeScript compilation check (both tsconfigs)

- [ ] Run:
  ```bash
  npx tsc --noEmit
  ```
  Expected output: nothing (zero errors).

- [ ] Run:
  ```bash
  npx tsc --noEmit -p tsconfig.spec.json
  ```
  Expected output: nothing (zero errors).

---

### E3 — Lint check

- [ ] Run:
  ```bash
  npm run lint
  ```
  Expected: zero lint errors across all modified files.

  If errors appear, common fixes:
  - Unused variables: remove or prefix with `_`
  - Missing explicit return type on exported functions: add return type annotation
  - Remaining `any` usage: replace with the typed alternatives introduced in this plan

---

### E4 — Backward compatibility smoke check

Verify that each group's changes are purely additive for existing callers.

**Plugin system** — the `OrchestratorHooks` alias now resolves to `TypedOrchestratorHooks`. Existing CommonJS JS plugins exporting `{ 'instance.created': (payload) => { ... } }` continue to work because TypeScript's structural typing accepts them as `TypedOrchestratorHooks`. Run:
```bash
npx vitest run src/main/plugins/
```

**Tool registry** — the `loadModule` return type is widened; `toLoadedTool` has a second branch. The legacy path is unchanged. Run:
```bash
npx vitest run src/main/tools/
```

**Provider registry** — the module-level singleton `getProviderRegistry()` still returns a `ProviderRegistry` with identical public API. Run:
```bash
npx vitest run src/main/providers/
```

All three sub-suites must pass.

---

### E5 — Final commit

```bash
git add -A
git commit -m "chore(phase2): final verification — all tests pass, tsc clean, lint clean"
```

---

## Summary of Files Changed

| File | Status | Group |
|------|--------|-------|
| `src/shared/types/plugin.types.ts` | Created | A |
| `src/main/plugins/plugin-manager.ts` | Modified | A |
| `src/main/plugins/plugin-manager.spec.ts` | Created | A |
| `src/main/tools/define-tool.ts` | Created | B |
| `src/main/tools/define-tool.spec.ts` | Created | B |
| `src/main/tools/tool-registry.ts` | Modified | B |
| `src/main/tools/tool-registry-interop.spec.ts` | Created | B |
| `src/main/providers/provider-registry.ts` | Modified | C |
| `src/main/providers/provider-registry.spec.ts` | Created | C |
| `src/main/cli/__tests__/cli-mock-harness.ts` | Created | D |
| `src/main/cli/__tests__/cli-mock-harness.spec.ts` | Created | D |
| `src/main/cli/__tests__/adapter-parity.spec.ts` | Created | D |

## Key Design Decisions

**Why `TypedOrchestratorHooks` as a mapped type, not a class?** Mapped types keep the plugin API purely data-oriented. Authors write plain objects or async factory functions — no imports from the orchestrator required.

**Why keep `OrchestratorHooks` as a re-exported alias?** Any existing code that imports `OrchestratorHooks` from `plugin-manager.ts` continues to compile without changes. The alias is a zero-cost rename.

**Why widen `ProviderRegistry`'s internal maps from `Map<ProviderType, ...>` to `Map<string, ...>`?** The `ProviderType` union is a compile-time contract at the public API. Internally, the maps must accept runtime-registered providers whose type strings are not in the union. The public `createProvider(type: ProviderType, ...)` signature is unchanged, so all existing callers compile without modification.

**Why does `defineTool` not replace `ToolModule`?** The registry supports both shapes via the `isToolDefinition()` guard in `toLoadedTool()`. Existing tools require no migration; new tools get the typed builder. Authors can upgrade incrementally.

**Why are CodexCliAdapter parity tests excluded from `adapter-parity.spec.ts`?** Codex has a dual-mode spawn path (app-server vs exec) with JSON-RPC initialization sequences that require dedicated mocking of the app-server client module. Its behavior is covered by `codex-cli-adapter.spec.ts`. Extending the parity harness to Codex is a follow-up task.

**Why does `ToolDefinition` use a `__isToolDefinition: true` marker instead of `instanceof`?** Tools are loaded via `require()` from external CommonJS files. The class reference across module boundaries may not match, making `instanceof` unreliable. A plain property marker is stable across any `require()` context.
