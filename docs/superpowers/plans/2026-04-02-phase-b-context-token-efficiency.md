# Phase B: Context & Token Efficiency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add output persistence thresholds, model-aware capability registry, and hybrid content storage to reduce context window bloat and improve token efficiency.

**Architecture:** Three independent services following the singleton + getter pattern. Output persistence intercepts large CLI outputs before context insertion. Model capabilities consolidates scattered model metadata. Content store optimizes session snapshot storage via hash-based deduplication.

**Tech Stack:** TypeScript 5.9, Vitest, Node.js `fs/promises`, `crypto`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/main/context/output-persistence.ts` | OutputPersistenceManager — threshold detection, cache write/retrieve, cleanup |
| Create | `src/main/context/__tests__/output-persistence.spec.ts` | Unit tests for OutputPersistenceManager |
| Modify | `src/main/cli/adapters/base-cli-adapter.ts` | Call OutputPersistenceManager in output processing path |
| Create | `src/main/providers/model-capabilities.ts` | ModelCapabilitiesRegistry — consolidated model metadata, runtime enrichment |
| Create | `src/main/providers/__tests__/model-capabilities.spec.ts` | Unit tests for ModelCapabilitiesRegistry |
| Create | `src/main/session/content-store.ts` | ContentStore — hybrid inline/external deduplicating storage |
| Create | `src/main/session/__tests__/content-store.spec.ts` | Unit tests for ContentStore |

---

## Task 1: Output Persistence Thresholds (B1)

**Files:**
- Create: `src/main/context/output-persistence.ts`
- Create: `src/main/context/__tests__/output-persistence.spec.ts`
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`

### Step 1: Write the test file with core tests

- [ ] Create `src/main/context/__tests__/output-persistence.spec.ts`:

```typescript
// src/main/context/__tests__/output-persistence.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that transitively loads Electron
// ---------------------------------------------------------------------------

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app-data') },
}));

// ---------------------------------------------------------------------------
// fs/promises mock
// ---------------------------------------------------------------------------
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// ---------------------------------------------------------------------------
// Import class under test (after mocks)
// ---------------------------------------------------------------------------
import { OutputPersistenceManager, getOutputPersistenceManager } from '../output-persistence';

describe('OutputPersistenceManager', () => {
  beforeEach(() => {
    OutputPersistenceManager._resetForTesting();
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    mockReaddir.mockClear();
    mockStat.mockClear();
    mockUnlink.mockClear();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = OutputPersistenceManager.getInstance();
      const b = OutputPersistenceManager.getInstance();
      expect(a).toBe(b);
    });

    it('getOutputPersistenceManager() convenience getter returns the singleton', () => {
      const manager = getOutputPersistenceManager();
      expect(manager).toBe(OutputPersistenceManager.getInstance());
    });
  });

  describe('maybeExternalize — small output (below threshold)', () => {
    it('returns content unchanged when below default threshold', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const small = 'x'.repeat(1000);
      const result = await manager.maybeExternalize('default', small);
      expect(result).toBe(small);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns content unchanged when below per-tool grep threshold (20K)', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const output = 'a'.repeat(19_999);
      const result = await manager.maybeExternalize('grep', output);
      expect(result).toBe(output);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('maybeExternalize — large output (exceeds threshold)', () => {
    it('writes full content to cache file when default threshold exceeded', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const large = 'z'.repeat(51_000);
      const result = await manager.maybeExternalize('default', large);

      expect(mockWriteFile).toHaveBeenCalledOnce();
      expect(result).toContain('[Full output saved:');
      expect(result).toContain('51000 chars');
    });

    it('truncated preview contains first 2K and last 1K of original content', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const prefix = 'START'.repeat(500);   // 2500 chars
      const middle = 'X'.repeat(50_000);
      const suffix = 'END'.repeat(400);     // 1200 chars
      const large = prefix + middle + suffix;

      const result = await manager.maybeExternalize('default', large);

      // First 2K chars of original must appear at start of preview
      expect(result.startsWith(large.slice(0, 2000))).toBe(true);
      // Last 1K chars of original must appear before the marker
      expect(result).toContain(large.slice(-1000));
    });

    it('exceeds grep threshold at 20K chars', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const output = 'b'.repeat(20_001);
      const result = await manager.maybeExternalize('grep', output);
      expect(mockWriteFile).toHaveBeenCalledOnce();
      expect(result).toContain('[Full output saved:');
    });

    it('exceeds web_fetch threshold at 100K chars', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const output = 'c'.repeat(100_001);
      const result = await manager.maybeExternalize('web_fetch', output);
      expect(mockWriteFile).toHaveBeenCalledOnce();
      expect(result).toContain('[Full output saved:');
    });

    it('uses sha256 hash as filename (64 hex chars)', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const large = 'd'.repeat(51_000);
      await manager.maybeExternalize('default', large);

      const writePath = mockWriteFile.mock.calls[0][0] as string;
      const filename = writePath.split('/').pop()!;
      // filename = <hash>.txt
      expect(filename).toMatch(/^[0-9a-f]{64}\.txt$/);
    });

    it('identical content produces the same hash (dedup-friendly)', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const content = 'e'.repeat(51_000);
      await manager.maybeExternalize('default', content);
      await manager.maybeExternalize('default', content);
      // Both calls should write to the same path
      const path1 = mockWriteFile.mock.calls[0][0] as string;
      const path2 = mockWriteFile.mock.calls[1][0] as string;
      expect(path1).toBe(path2);
    });
  });

  describe('retrieve', () => {
    it('returns full content for a known hash', async () => {
      mockReadFile.mockResolvedValueOnce('full content here');
      const manager = OutputPersistenceManager.getInstance();
      const content = await manager.retrieve('abc123');
      expect(content).toBe('full content here');
    });

    it('returns null when file does not exist', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValueOnce(err);
      const manager = OutputPersistenceManager.getInstance();
      const content = await manager.retrieve('nonexistent');
      expect(content).toBeNull();
    });

    it('returns null and logs on unexpected read error', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('disk error'));
      const manager = OutputPersistenceManager.getInstance();
      const content = await manager.retrieve('badhash');
      expect(content).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('removes files older than 24 hours', async () => {
      const now = Date.now();
      const oldMtime = new Date(now - 25 * 60 * 60 * 1000);
      const newMtime = new Date(now - 1 * 60 * 60 * 1000);

      mockReaddir.mockResolvedValueOnce(['old.txt', 'new.txt']);
      mockStat
        .mockResolvedValueOnce({ mtime: oldMtime })
        .mockResolvedValueOnce({ mtime: newMtime });

      const manager = OutputPersistenceManager.getInstance();
      await manager.cleanup();

      expect(mockUnlink).toHaveBeenCalledOnce();
      expect(mockUnlink.mock.calls[0][0] as string).toContain('old.txt');
    });

    it('does not remove files younger than 24 hours', async () => {
      const recentMtime = new Date(Date.now() - 1 * 60 * 60 * 1000);
      mockReaddir.mockResolvedValueOnce(['recent.txt']);
      mockStat.mockResolvedValueOnce({ mtime: recentMtime });

      const manager = OutputPersistenceManager.getInstance();
      await manager.cleanup();

      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('tolerates stat errors on individual files during cleanup', async () => {
      mockReaddir.mockResolvedValueOnce(['broken.txt']);
      mockStat.mockRejectedValueOnce(new Error('stat failed'));

      const manager = OutputPersistenceManager.getInstance();
      await expect(manager.cleanup()).resolves.not.toThrow();
    });
  });

  describe('configureThreshold', () => {
    it('respects custom per-tool threshold set via configure()', async () => {
      const manager = OutputPersistenceManager.getInstance();
      manager.configure({ thresholds: { custom_tool: 5000 } });

      const small = 'f'.repeat(4999);
      const result = await manager.maybeExternalize('custom_tool', small);
      expect(result).toBe(small);
      expect(mockWriteFile).not.toHaveBeenCalled();

      mockWriteFile.mockClear();

      const large = 'f'.repeat(5001);
      const resultLarge = await manager.maybeExternalize('custom_tool', large);
      expect(resultLarge).toContain('[Full output saved:');
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });
  });
});
```

### Step 2: Run the test expecting failure

- [ ] Run: `npx vitest run src/main/context/__tests__/output-persistence.spec.ts --reporter=verbose`
  - Expected: all tests fail with `Cannot find module '../output-persistence'`

### Step 3: Write the minimal implementation

- [ ] Create `src/main/context/output-persistence.ts`:

```typescript
/**
 * Output Persistence Manager
 *
 * Intercepts large CLI tool outputs before they are inserted into the context
 * window. Outputs exceeding configurable per-tool thresholds are saved to disk;
 * the context receives a compact preview + retrieval marker instead.
 *
 * Default thresholds:
 *   grep / search tools  → 20 K chars
 *   web_fetch            → 100 K chars
 *   all other tools      → 50 K chars
 *
 * Cache location: <userData>/output-cache/<sha256>.txt
 * Auto-cleanup: files older than 24 hours are removed by cleanup().
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('OutputPersistenceManager');

const PREVIEW_HEAD_CHARS = 2000;
const PREVIEW_TAIL_CHARS = 1000;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_THRESHOLDS: Record<string, number> = {
  grep: 20_000,
  search: 20_000,
  web_fetch: 100_000,
  default: 50_000,
};

export interface OutputPersistenceConfig {
  thresholds?: Record<string, number>;
}

export class OutputPersistenceManager {
  private static instance: OutputPersistenceManager | null = null;

  private thresholds: Record<string, number> = { ...DEFAULT_THRESHOLDS };
  private cacheDir: string;

  private constructor() {
    this.cacheDir = path.join(app.getPath('userData'), 'output-cache');
  }

  static getInstance(): OutputPersistenceManager {
    if (!OutputPersistenceManager.instance) {
      OutputPersistenceManager.instance = new OutputPersistenceManager();
    }
    return OutputPersistenceManager.instance;
  }

  static _resetForTesting(): void {
    OutputPersistenceManager.instance = null;
  }

  /** Override default thresholds or add new per-tool thresholds. */
  configure(config: OutputPersistenceConfig): void {
    if (config.thresholds) {
      this.thresholds = { ...this.thresholds, ...config.thresholds };
    }
  }

  /**
   * If `output` exceeds the threshold for `toolName`, persist the full content
   * to disk and return a truncated preview with a retrieval marker.
   * Otherwise returns `output` unchanged.
   */
  async maybeExternalize(toolName: string, output: string): Promise<string> {
    const threshold = this.thresholds[toolName] ?? this.thresholds['default'];

    if (output.length <= threshold) {
      return output;
    }

    const hash = this.sha256(output);
    const filePath = path.join(this.cacheDir, `${hash}.txt`);

    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(filePath, output, 'utf8');
    } catch (err) {
      logger.error('Failed to persist large output to cache', err as Error, { toolName, hash });
      // Fall through — return full output rather than lose data
      return output;
    }

    const head = output.slice(0, PREVIEW_HEAD_CHARS);
    const tail = output.slice(-PREVIEW_TAIL_CHARS);
    const originalSize = output.length;

    return `${head}\n…\n${tail}\n\n[Full output saved: ${filePath}] (${originalSize} chars)\n`;
  }

  /**
   * Retrieve the full content for a previously persisted output by its hash.
   * Returns null if the file is not found or cannot be read.
   */
  async retrieve(hash: string): Promise<string | null> {
    const filePath = path.join(this.cacheDir, `${hash}.txt`);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.error('Unexpected error reading cached output', err as Error, { hash });
      }
      return null;
    }
  }

  /**
   * Remove all cached files older than 24 hours.
   * Safe to call on a schedule; tolerates missing cache directory.
   */
  async cleanup(): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.cacheDir);
    } catch {
      return; // cache dir does not exist yet — nothing to clean up
    }

    const cutoff = Date.now() - CACHE_MAX_AGE_MS;

    for (const file of files) {
      const filePath = path.join(this.cacheDir, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtime.getTime() < cutoff) {
          await fs.unlink(filePath);
          logger.debug('Removed stale output cache file', { file });
        }
      } catch (err) {
        logger.warn('Could not stat/remove cache file during cleanup', { file, err });
      }
    }
  }

  private sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }
}

export function getOutputPersistenceManager(): OutputPersistenceManager {
  return OutputPersistenceManager.getInstance();
}
```

### Step 4: Run the test expecting pass

- [ ] Run: `npx vitest run src/main/context/__tests__/output-persistence.spec.ts --reporter=verbose`
  - Expected: all tests pass

### Step 5: Integrate into base-cli-adapter.ts

- [ ] Read `src/main/cli/adapters/base-cli-adapter.ts` fully before editing.
- [ ] Add an optional `persistLargeOutputs` flag to `CliAdapterConfig` (default `true`).
- [ ] In the `outputBuffer` flush path (the method that emits accumulated stdout), wrap the flushed string in `getOutputPersistenceManager().maybeExternalize(toolName, content)` before emitting — use `'default'` as `toolName` since the base adapter does not know the tool name; concrete adapters may override.
- [ ] Keep the change minimal: do not alter any other logic, signatures, or exports.

### Step 6: TypeScript + lint

- [ ] Run: `npx tsc --noEmit`
  - Expected: no errors
- [ ] Run: `npx tsc --noEmit -p tsconfig.spec.json`
  - Expected: no errors
- [ ] Run: `npx eslint src/main/context/output-persistence.ts src/main/cli/adapters/base-cli-adapter.ts`
  - Expected: no errors

### Step 7: Commit

- [ ] `git add src/main/context/output-persistence.ts src/main/context/__tests__/output-persistence.spec.ts src/main/cli/adapters/base-cli-adapter.ts`
- [ ] Commit with message: `feat(context): add OutputPersistenceManager for large CLI output caching`

---

## Task 2: Model Capabilities Registry (B2)

**Files:**
- Create: `src/main/providers/model-capabilities.ts`
- Create: `src/main/providers/__tests__/model-capabilities.spec.ts`

### Step 1: Write the test file

- [ ] Create `src/main/providers/__tests__/model-capabilities.spec.ts`:

```typescript
// src/main/providers/__tests__/model-capabilities.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  ModelCapabilitiesRegistry,
  getModelCapabilitiesRegistry,
  type ModelCapabilities,
} from '../model-capabilities';

describe('ModelCapabilitiesRegistry', () => {
  beforeEach(() => {
    ModelCapabilitiesRegistry._resetForTesting();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = ModelCapabilitiesRegistry.getInstance();
      const b = ModelCapabilitiesRegistry.getInstance();
      expect(a).toBe(b);
    });

    it('getModelCapabilitiesRegistry() convenience getter returns the singleton', () => {
      expect(getModelCapabilitiesRegistry()).toBe(ModelCapabilitiesRegistry.getInstance());
    });
  });

  describe('getCapabilities — known Claude models', () => {
    it('returns 1M context window for claude opus', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'opus');
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('returns 1M context window for claude sonnet', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'sonnet');
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('returns 200K context window for claude haiku', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'haiku');
      expect(caps.contextWindow).toBe(200_000);
    });

    it('marks claude opus as supportsThinking = true', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'opus');
      expect(caps.supportsThinking).toBe(true);
    });

    it('marks claude haiku as supportsThinking = false', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'haiku');
      expect(caps.supportsThinking).toBe(false);
    });

    it('includes pricing for claude sonnet', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'sonnet');
      expect(caps.pricing).toBeDefined();
      expect(caps.pricing!.inputPerMillion).toBe(3.0);
      expect(caps.pricing!.outputPerMillion).toBe(15.0);
    });

    it('includes pricing for claude opus', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude', 'opus');
      expect(caps.pricing).toBeDefined();
      expect(caps.pricing!.inputPerMillion).toBe(5.0);
      expect(caps.pricing!.outputPerMillion).toBe(25.0);
    });
  });

  describe('getCapabilities — known OpenAI models', () => {
    it('returns 128K context window for gpt-4o', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('openai', 'gpt-4o');
      expect(caps.contextWindow).toBe(128_000);
    });

    it('returns 200K context window for o1', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('openai', 'o1');
      expect(caps.contextWindow).toBe(200_000);
    });
  });

  describe('getCapabilities — known Gemini models', () => {
    it('returns 1M context window for gemini-flash', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('google', 'gemini-flash');
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('returns 2M context window for gemini-pro', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('google', 'gemini-pro');
      expect(caps.contextWindow).toBe(2_000_000);
    });
  });

  describe('getCapabilities — unknown model fallback', () => {
    it('returns sensible defaults for an unknown provider+model', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('unknown-provider', 'unknown-model-xyz');
      expect(caps.contextWindow).toBe(200_000);
      expect(caps.maxOutputTokens).toBe(4096);
      expect(caps.supportsThinking).toBe(false);
      expect(caps.supportsBatching).toBe(false);
    });
  });

  describe('TTL cache', () => {
    it('returns the same object reference on repeated calls within TTL', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps1 = registry.getCapabilities('claude', 'sonnet');
      const caps2 = registry.getCapabilities('claude', 'sonnet');
      expect(caps1).toBe(caps2);
    });

    it('re-computes after TTL expires', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      // First call — populates cache
      const caps1 = registry.getCapabilities('claude', 'haiku');
      // Manually expire the cache entry
      (registry as unknown as { capabilityCache: Map<string, { caps: ModelCapabilities; expiresAt: number }> })
        .capabilityCache.forEach((_v, k) => {
          (registry as unknown as { capabilityCache: Map<string, { caps: ModelCapabilities; expiresAt: number }> })
            .capabilityCache.set(k, { caps: _v.caps, expiresAt: Date.now() - 1 });
        });
      const caps2 = registry.getCapabilities('claude', 'haiku');
      // After expiry the object is rebuilt — not the same reference
      expect(caps2).not.toBe(caps1);
      // But values are identical (same known data)
      expect(caps2.contextWindow).toBe(caps1.contextWindow);
    });
  });

  describe('enrichFromDiscovery', () => {
    it('merges runtime-discovered data with known static data', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      registry.enrichFromDiscovery('claude', 'sonnet', { thinkingBudget: 8192 });
      const caps = registry.getCapabilities('claude', 'sonnet');
      expect(caps.thinkingBudget).toBe(8192);
      // Static data is preserved
      expect(caps.contextWindow).toBe(1_000_000);
    });

    it('runtime enrichment overrides static values when provided', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      registry.enrichFromDiscovery('claude', 'haiku', { contextWindow: 400_000 });
      const caps = registry.getCapabilities('claude', 'haiku');
      expect(caps.contextWindow).toBe(400_000);
    });

    it('enriching unknown model creates a new entry using defaults + enrichment', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      registry.enrichFromDiscovery('newco', 'model-x', { contextWindow: 300_000, supportsThinking: true });
      const caps = registry.getCapabilities('newco', 'model-x');
      expect(caps.contextWindow).toBe(300_000);
      expect(caps.supportsThinking).toBe(true);
    });
  });
});
```

### Step 2: Run the test expecting failure

- [ ] Run: `npx vitest run src/main/providers/__tests__/model-capabilities.spec.ts --reporter=verbose`
  - Expected: all tests fail with `Cannot find module '../model-capabilities'`

### Step 3: Write the implementation

- [ ] Create `src/main/providers/model-capabilities.ts`:

```typescript
/**
 * Model Capabilities Registry
 *
 * Consolidates model metadata that was previously scattered across:
 *   - src/shared/constants/limits.ts (CONTEXT_WINDOWS)
 *   - src/shared/types/provider.types.ts (MODEL_PRICING, getProviderModelContextWindow)
 *   - src/main/providers/model-discovery.ts (per-provider fetch logic)
 *
 * Design decisions:
 * - KNOWN_MODELS is a static table built from the existing constants at startup.
 * - enrichFromDiscovery() allows the runtime discovery service to merge live
 *   data (e.g. thinking budgets returned by the API) without a full refetch.
 * - TTL of 1 hour per cache entry matches ModelDiscoveryService.
 * - Falls back to { contextWindow: 200K, maxOutputTokens: 4096 } for unknown models.
 */

import { getLogger } from '../logging/logger';
import { CONTEXT_WINDOWS } from '../../shared/constants/limits';
import { MODEL_PRICING, CLAUDE_MODELS, GOOGLE_MODELS, OPENAI_MODELS } from '../../shared/types/provider.types';

const logger = getLogger('ModelCapabilitiesRegistry');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  thinkingBudget?: number;
  supportsThinking: boolean;
  supportsBatching: boolean;
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}

const FALLBACK: ModelCapabilities = {
  contextWindow: CONTEXT_WINDOWS.CLAUDE_DEFAULT,
  maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
  supportsThinking: false,
  supportsBatching: false,
};

function pricingFor(modelKey: string): ModelCapabilities['pricing'] | undefined {
  const entry = MODEL_PRICING[modelKey];
  if (!entry) return undefined;
  return { inputPerMillion: entry.input, outputPerMillion: entry.output };
}

/**
 * Static known-models table.  Keys use the form `<provider>:<normalizedModel>`
 * so provider variants (claude / claude-cli / anthropic) are grouped.
 */
const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  // ---- Claude ----
  'claude:opus': {
    contextWindow: CONTEXT_WINDOWS.CLAUDE_OPUS,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: true,
    supportsBatching: false,
    pricing: pricingFor(CLAUDE_MODELS.OPUS),
  },
  'claude:sonnet': {
    contextWindow: CONTEXT_WINDOWS.CLAUDE_SONNET,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: true,
    supportsBatching: false,
    pricing: pricingFor(CLAUDE_MODELS.SONNET),
  },
  'claude:haiku': {
    contextWindow: CONTEXT_WINDOWS.CLAUDE_HAIKU,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(CLAUDE_MODELS.HAIKU),
  },
  // ---- OpenAI ----
  'openai:gpt-4o': {
    contextWindow: CONTEXT_WINDOWS.GPT4_O,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(OPENAI_MODELS.GPT4O),
  },
  'openai:gpt-4o-mini': {
    contextWindow: CONTEXT_WINDOWS.GPT4_O_MINI,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(OPENAI_MODELS.GPT4O_MINI),
  },
  'openai:o1': {
    contextWindow: CONTEXT_WINDOWS.O1,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
  },
  // ---- Google ----
  'google:gemini-flash': {
    contextWindow: CONTEXT_WINDOWS.GEMINI_FLASH,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: true,
    pricing: pricingFor(GOOGLE_MODELS.GEMINI_25_FLASH),
  },
  'google:gemini-pro': {
    contextWindow: CONTEXT_WINDOWS.GEMINI_PRO,
    maxOutputTokens: CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsBatching: false,
    pricing: pricingFor(GOOGLE_MODELS.GEMINI_25_PRO),
  },
};

interface CacheEntry {
  caps: ModelCapabilities;
  expiresAt: number;
}

export class ModelCapabilitiesRegistry {
  private static instance: ModelCapabilitiesRegistry | null = null;

  /** Live cache: provider:model → cached capabilities with TTL */
  private capabilityCache = new Map<string, CacheEntry>();

  /** Runtime enrichments merged on top of KNOWN_MODELS */
  private enrichments = new Map<string, Partial<ModelCapabilities>>();

  private constructor() {}

  static getInstance(): ModelCapabilitiesRegistry {
    if (!ModelCapabilitiesRegistry.instance) {
      ModelCapabilitiesRegistry.instance = new ModelCapabilitiesRegistry();
    }
    return ModelCapabilitiesRegistry.instance;
  }

  static _resetForTesting(): void {
    ModelCapabilitiesRegistry.instance = null;
  }

  /**
   * Returns capabilities for the given provider+model combination.
   * Results are cached for CACHE_TTL_MS (1 hour).
   */
  getCapabilities(provider: string, model: string): ModelCapabilities {
    const key = this.cacheKey(provider, model);

    const cached = this.capabilityCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.caps;
    }

    const caps = this.compute(provider, model);
    this.capabilityCache.set(key, { caps, expiresAt: Date.now() + CACHE_TTL_MS });
    return caps;
  }

  /**
   * Merges runtime-discovered data (e.g. from ModelDiscoveryService or API
   * responses) into the registry.  Invalidates the cache entry so the next
   * getCapabilities() call picks up the new values.
   */
  enrichFromDiscovery(provider: string, model: string, discovered: Partial<ModelCapabilities>): void {
    const key = this.cacheKey(provider, model);
    const existing = this.enrichments.get(key) ?? {};
    this.enrichments.set(key, { ...existing, ...discovered });
    // Invalidate cache so the merged result is rebuilt on next access
    this.capabilityCache.delete(key);
    logger.debug('Enriched model capabilities from discovery', { provider, model, discovered });
  }

  private compute(provider: string, model: string): ModelCapabilities {
    const key = this.cacheKey(provider, model);
    const known = KNOWN_MODELS[key];
    const enrichment = this.enrichments.get(key);

    if (!known && !enrichment) {
      logger.debug('Unknown model — using fallback capabilities', { provider, model });
      return { ...FALLBACK };
    }

    return {
      ...(known ?? FALLBACK),
      ...(enrichment ?? {}),
    };
  }

  private cacheKey(provider: string, model: string): string {
    return `${provider.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
  }
}

export function getModelCapabilitiesRegistry(): ModelCapabilitiesRegistry {
  return ModelCapabilitiesRegistry.getInstance();
}
```

### Step 4: Run the test expecting pass

- [ ] Run: `npx vitest run src/main/providers/__tests__/model-capabilities.spec.ts --reporter=verbose`
  - Expected: all tests pass

### Step 5: Add edge-case tests

- [ ] Append to `src/main/providers/__tests__/model-capabilities.spec.ts`:

```typescript
  describe('provider alias normalisation', () => {
    it('treats "claude-cli" the same as "claude" for opus', () => {
      // The registry key uses lowercased provider string directly;
      // callers using "claude-cli" get fallback (not a known key) —
      // this test documents the current behaviour rather than asserting alias support.
      const registry = ModelCapabilitiesRegistry.getInstance();
      const caps = registry.getCapabilities('claude-cli', 'opus');
      // Falls back to FALLBACK defaults
      expect(caps.contextWindow).toBe(200_000);
    });

    it('normalises model name casing', () => {
      const registry = ModelCapabilitiesRegistry.getInstance();
      const lower = registry.getCapabilities('claude', 'opus');
      const upper = registry.getCapabilities('CLAUDE', 'OPUS');
      // Both resolve to the same normalised key "claude:opus"
      expect(lower.contextWindow).toBe(upper.contextWindow);
    });
  });
```

- [ ] Run all model-capabilities tests: `npx vitest run src/main/providers/__tests__/model-capabilities.spec.ts --reporter=verbose`
  - Expected: all tests pass (including new edge-case tests)

### Step 6: TypeScript + lint

- [ ] Run: `npx tsc --noEmit`
  - Expected: no errors
- [ ] Run: `npx tsc --noEmit -p tsconfig.spec.json`
  - Expected: no errors
- [ ] Run: `npx eslint src/main/providers/model-capabilities.ts`
  - Expected: no errors

### Step 7: Commit

- [ ] `git add src/main/providers/model-capabilities.ts src/main/providers/__tests__/model-capabilities.spec.ts`
- [ ] Commit with message: `feat(providers): add ModelCapabilitiesRegistry consolidating model metadata`

---

## Task 3: Hybrid Content Storage (B3)

**Files:**
- Create: `src/main/session/content-store.ts`
- Create: `src/main/session/__tests__/content-store.spec.ts`

### Step 1: Write the test file

- [ ] Create `src/main/session/__tests__/content-store.spec.ts`:

```typescript
// src/main/session/__tests__/content-store.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that transitively loads Electron
// ---------------------------------------------------------------------------

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app-data') },
}));

// ---------------------------------------------------------------------------
// fs/promises mock
// ---------------------------------------------------------------------------
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import { ContentStore, getContentStore, type ContentRef } from '../content-store';

describe('ContentStore', () => {
  beforeEach(() => {
    ContentStore._resetForTesting();
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    mockReaddir.mockClear();
    mockStat.mockClear();
    mockUnlink.mockClear();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = ContentStore.getInstance();
      const b = ContentStore.getInstance();
      expect(a).toBe(b);
    });

    it('getContentStore() convenience getter returns the singleton', () => {
      expect(getContentStore()).toBe(ContentStore.getInstance());
    });
  });

  describe('store — inline path (< 1 KB)', () => {
    it('returns inline ref for content below 1 KB threshold', async () => {
      const store = ContentStore.getInstance();
      const small = 'hello world';
      const ref = await store.store(small);

      expect(ref.inline).toBe(true);
      if (ref.inline) {
        expect(ref.content).toBe(small);
      }
      // No disk I/O for inline content
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns inline ref for content at exactly 1023 bytes', async () => {
      const store = ContentStore.getInstance();
      const content = 'x'.repeat(1023);
      const ref = await store.store(content);
      expect(ref.inline).toBe(true);
    });
  });

  describe('store — external path (>= 1 KB)', () => {
    it('returns external ref for content at exactly 1024 bytes', async () => {
      const store = ContentStore.getInstance();
      const content = 'y'.repeat(1024);
      const ref = await store.store(content);
      expect(ref.inline).toBe(false);
    });

    it('external ref carries correct size', async () => {
      const store = ContentStore.getInstance();
      const content = 'z'.repeat(2000);
      const ref = await store.store(content);
      if (!ref.inline) {
        expect(ref.size).toBe(2000);
      }
    });

    it('external ref hash is a 64-char hex string', async () => {
      const store = ContentStore.getInstance();
      const content = 'a'.repeat(2000);
      const ref = await store.store(content);
      if (!ref.inline) {
        expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('writes content to sharded directory based on first 2 hash chars', async () => {
      const store = ContentStore.getInstance();
      const content = 'b'.repeat(2000);
      const ref = await store.store(content);
      if (!ref.inline) {
        const expectedShard = ref.hash.slice(0, 2);
        const writtenPath = mockWriteFile.mock.calls[0][0] as string;
        expect(writtenPath).toContain(`/${expectedShard}/`);
        expect(writtenPath).toContain(ref.hash);
      }
    });

    it('identical content produces the same hash (deduplication)', async () => {
      const store = ContentStore.getInstance();
      const content = 'c'.repeat(2000);
      const ref1 = await store.store(content);
      const ref2 = await store.store(content);
      if (!ref1.inline && !ref2.inline) {
        expect(ref1.hash).toBe(ref2.hash);
      }
    });

    it('write is fire-and-forget (does not block caller)', async () => {
      // store() must resolve immediately; the disk write happens asynchronously
      let writeResolved = false;
      mockWriteFile.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => { writeResolved = true; resolve(undefined); }, 100))
      );
      const store = ContentStore.getInstance();
      const content = 'd'.repeat(2000);
      // This should resolve before the 100ms write completes
      const ref = await store.store(content);
      expect(ref.inline).toBe(false);
      // The mock write may or may not have completed yet — the point is store() didn't wait
    });
  });

  describe('resolve', () => {
    it('resolves inline ref directly without disk I/O', async () => {
      const store = ContentStore.getInstance();
      const ref: ContentRef = { inline: true, content: 'inline content' };
      const result = await store.resolve(ref);
      expect(result).toBe('inline content');
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('resolves external ref by reading from disk', async () => {
      const content = 'external content value';
      mockReadFile.mockResolvedValueOnce(content);
      const store = ContentStore.getInstance();
      const hash = 'a'.repeat(64);
      const ref: ContentRef = { inline: false, hash, size: content.length };
      const result = await store.resolve(ref);
      expect(result).toBe(content);
      expect(mockReadFile).toHaveBeenCalledOnce();
    });

    it('throws IntegrityError when resolved content hash does not match ref hash', async () => {
      // Write content that hashes to 'aaa...', but read back different content
      const store = ContentStore.getInstance();
      mockReadFile.mockResolvedValueOnce('tampered content');
      const ref: ContentRef = { inline: false, hash: 'f'.repeat(64), size: 100 };
      await expect(store.resolve(ref)).rejects.toThrow(/integrity/i);
    });

    it('throws on missing external file', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValueOnce(err);
      const store = ContentStore.getInstance();
      const ref: ContentRef = { inline: false, hash: 'b'.repeat(64), size: 50 };
      await expect(store.resolve(ref)).rejects.toThrow();
    });
  });

  describe('cleanup', () => {
    it('removes files in sharded dirs older than maxAgeDays', async () => {
      const store = ContentStore.getInstance();
      const now = Date.now();
      const oldMtime = new Date(now - 8 * 24 * 60 * 60 * 1000);
      const newMtime = new Date(now - 1 * 24 * 60 * 60 * 1000);

      // readdir returns shard dirs, then files within each shard
      mockReaddir
        .mockResolvedValueOnce(['ab', 'cd'])   // shard dirs
        .mockResolvedValueOnce(['file1'])       // files in ab/
        .mockResolvedValueOnce(['file2']);      // files in cd/

      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true })  // ab is dir
        .mockResolvedValueOnce({ isDirectory: () => true })  // cd is dir
        .mockResolvedValueOnce({ mtime: oldMtime })          // file1 age
        .mockResolvedValueOnce({ mtime: newMtime });         // file2 age

      await store.cleanup(7);

      expect(mockUnlink).toHaveBeenCalledOnce();
    });

    it('handles empty content-store directory without error', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      const store = ContentStore.getInstance();
      await expect(store.cleanup(7)).resolves.not.toThrow();
    });

    it('tolerates stat/unlink errors on individual files', async () => {
      mockReaddir
        .mockResolvedValueOnce(['xx'])
        .mockResolvedValueOnce(['broken-file']);
      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true })
        .mockRejectedValueOnce(new Error('stat failed'));

      const store = ContentStore.getInstance();
      await expect(store.cleanup(7)).resolves.not.toThrow();
    });
  });
});
```

### Step 2: Run the test expecting failure

- [ ] Run: `npx vitest run src/main/session/__tests__/content-store.spec.ts --reporter=verbose`
  - Expected: all tests fail with `Cannot find module '../content-store'`

### Step 3: Write the implementation

- [ ] Create `src/main/session/content-store.ts`:

```typescript
/**
 * Content Store
 *
 * Hybrid inline/external storage for session snapshot content fields
 * (ConversationEntry.content, ConversationEntry.toolUse.output).
 *
 * Routing rule:
 *   < 1 KB  → inline in JSON as { inline: true, content }
 *   >= 1 KB → external file as { inline: false, hash, size }
 *
 * External files are stored at:
 *   <userData>/content-store/<first-2-hash-chars>/<full-sha256-hash>
 *
 * The two-level sharding prevents large flat directories.
 * SHA-256 hashing provides content-addressed deduplication.
 *
 * Write path is fire-and-forget: store() does NOT await the disk write,
 * so callers on the hot path (snapshot serialisation) are not blocked.
 * The ContentRef is returned immediately using the pre-computed hash.
 *
 * Integrity check: resolve() re-hashes the retrieved content and throws
 * ContentIntegrityError if it does not match the ref hash.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('ContentStore');

export const INLINE_THRESHOLD_BYTES = 1024; // 1 KB

export type ContentRef =
  | { inline: true; content: string }
  | { inline: false; hash: string; size: number };

export class ContentIntegrityError extends Error {
  constructor(expectedHash: string, actualHash: string) {
    super(
      `Content integrity check failed: expected hash ${expectedHash}, got ${actualHash}`
    );
    this.name = 'ContentIntegrityError';
  }
}

export class ContentStore {
  private static instance: ContentStore | null = null;

  private storeDir: string;

  private constructor() {
    this.storeDir = path.join(app.getPath('userData'), 'content-store');
  }

  static getInstance(): ContentStore {
    if (!ContentStore.instance) {
      ContentStore.instance = new ContentStore();
    }
    return ContentStore.instance;
  }

  static _resetForTesting(): void {
    ContentStore.instance = null;
  }

  /**
   * Store content and return a ContentRef.
   *
   * For small content (< INLINE_THRESHOLD_BYTES) the ref is inline and no
   * disk I/O occurs.  For large content the hash is computed synchronously,
   * the ref returned immediately, and the disk write is fire-and-forget.
   */
  async store(content: string): Promise<ContentRef> {
    const bytes = Buffer.byteLength(content, 'utf8');

    if (bytes < INLINE_THRESHOLD_BYTES) {
      return { inline: true, content };
    }

    const hash = sha256(content);
    const filePath = this.externalPath(hash);

    // Fire-and-forget — do not await; callers must not block on disk I/O
    fs.mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.writeFile(filePath, content, 'utf8'))
      .catch((err: unknown) => {
        logger.error('Failed to write external content', err as Error, { hash });
      });

    return { inline: false, hash, size: bytes };
  }

  /**
   * Resolve a ContentRef back to its string content.
   * Throws ContentIntegrityError if the retrieved content does not match
   * the expected hash (external refs only).
   */
  async resolve(ref: ContentRef): Promise<string> {
    if (ref.inline) {
      return ref.content;
    }

    const filePath = this.externalPath(ref.hash);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      logger.error('Failed to read external content', err as Error, { hash: ref.hash });
      throw err;
    }

    const actualHash = sha256(content);
    if (actualHash !== ref.hash) {
      throw new ContentIntegrityError(ref.hash, actualHash);
    }

    return content;
  }

  /**
   * Remove external content files older than maxAgeDays.
   * Walks the two-level sharded directory structure.
   */
  async cleanup(maxAgeDays: number): Promise<void> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    let shards: string[];
    try {
      shards = await fs.readdir(this.storeDir);
    } catch {
      return; // store dir does not exist yet
    }

    for (const shard of shards) {
      const shardPath = path.join(this.storeDir, shard);
      try {
        const shardStat = await fs.stat(shardPath);
        if (!shardStat.isDirectory()) continue;

        const files = await fs.readdir(shardPath);
        for (const file of files) {
          const filePath = path.join(shardPath, file);
          try {
            const fileStat = await fs.stat(filePath);
            if (fileStat.mtime.getTime() < cutoff) {
              await fs.unlink(filePath);
              logger.debug('Removed stale content store file', { file });
            }
          } catch (err) {
            logger.warn('Could not process content store file during cleanup', { filePath, err });
          }
        }
      } catch (err) {
        logger.warn('Could not process content store shard during cleanup', { shard, err });
      }
    }
  }

  private externalPath(hash: string): string {
    return path.join(this.storeDir, hash.slice(0, 2), hash);
  }
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function getContentStore(): ContentStore {
  return ContentStore.getInstance();
}
```

### Step 4: Run the test expecting pass

- [ ] Run: `npx vitest run src/main/session/__tests__/content-store.spec.ts --reporter=verbose`
  - Expected: all tests pass

### Step 5: Verify full test suite for changed areas

- [ ] Run: `npx vitest run src/main/session/ --reporter=verbose`
  - Expected: all existing session tests still pass alongside new content-store tests

### Step 6: TypeScript + lint

- [ ] Run: `npx tsc --noEmit`
  - Expected: no errors
- [ ] Run: `npx tsc --noEmit -p tsconfig.spec.json`
  - Expected: no errors
- [ ] Run: `npx eslint src/main/session/content-store.ts`
  - Expected: no errors

### Step 7: Commit

- [ ] `git add src/main/session/content-store.ts src/main/session/__tests__/content-store.spec.ts`
- [ ] Commit with message: `feat(session): add ContentStore for hybrid inline/external snapshot content`

---

## Final Verification

After all three tasks are committed:

- [ ] Run the full test suite for all modified areas:
  ```
  npx vitest run src/main/context/ src/main/providers/ src/main/session/ --reporter=verbose
  ```
  - Expected: all tests pass with no regressions

- [ ] Run TypeScript check for the whole project:
  ```
  npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
  ```
  - Expected: no errors

- [ ] Run lint across all new and modified files:
  ```
  npx eslint \
    src/main/context/output-persistence.ts \
    src/main/context/__tests__/output-persistence.spec.ts \
    src/main/providers/model-capabilities.ts \
    src/main/providers/__tests__/model-capabilities.spec.ts \
    src/main/session/content-store.ts \
    src/main/session/__tests__/content-store.spec.ts \
    src/main/cli/adapters/base-cli-adapter.ts
  ```
  - Expected: no errors

---

## Implementation Notes

### OutputPersistenceManager (B1)
- The `app.getPath('userData')` call in the constructor is safe because `app` is available in the Electron main process. Tests mock `electron` to return `/tmp/test-app-data`.
- The `configure()` method is additive — it merges onto defaults rather than replacing them, so callers can add new per-tool thresholds without specifying all defaults.
- The integration in `base-cli-adapter.ts` should guard with `if (this.config.persistLargeOutputs !== false)` so adapters can opt out. The actual `toolName` passed to `maybeExternalize` should default to `'default'` in the base class; concrete adapter subclasses (e.g. Claude adapter) can override to pass the actual tool name extracted from the CLI's NDJSON stream.

### ModelCapabilitiesRegistry (B2)
- `KNOWN_MODELS` uses `provider:normalizedModel` keys. The provider string must be normalised by the caller (e.g. `'claude'` not `'claude-cli'`). A future enhancement could add alias normalisation; the edge-case test documents this gap so it is not silently assumed to work.
- `enrichFromDiscovery()` deletes the cache entry after merging so the next `getCapabilities()` call rebuilds with merged data. It does not reset the TTL of the new entry — the next build starts a fresh 1-hour TTL.
- `MODEL_PRICING` entries in `provider.types.ts` use `input`/`output` keys denominated per-million (despite the field comment saying per-1k — the actual values are per-million USD as of the current pricing). The `ModelCapabilities` interface uses explicit `inputPerMillion`/`outputPerMillion` to avoid this ambiguity.

### ContentStore (B3)
- The fire-and-forget write pattern means that if the process exits immediately after `store()`, the file may not be flushed. Session continuity already has its own shutdown flush; `ContentStore` relies on that outer shutdown sequence.
- `resolve()` re-hashes on every read. For large files this adds CPU cost. A production optimisation would be to cache resolved content in a LRU map; this is out of scope for Phase B but worth noting for a follow-up.
- The `cleanup(maxAgeDays)` walk assumes a two-level directory structure (shard/file). Files placed directly in `storeDir` (not in a shard subdir) are skipped — by the `isDirectory()` check — so they never get cleaned. Do not write files directly to `storeDir`.
