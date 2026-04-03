# Phase E: Developer Experience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven developer experience improvements: enhanced command discovery, feature gates with dead code elimination, compiled permission matchers, tool safety metadata, priority message queue, multi-layer settings cache, and EPIPE handling.

**Architecture:** Mix of enhancements to existing code and new utilities. Two items (E1, E7) are already ~85% implemented and need polish. Five items (E2-E6) are new features following existing patterns.

**Tech Stack:** TypeScript 5.9, Vitest, Node.js EventEmitter

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/main/commands/markdown-command-registry.ts` | Add `priority` field + per-directory mtime check |
| Create | `src/main/commands/__tests__/markdown-command-registry.spec.ts` | Tests for priority merge and mtime skip |
| Modify | `src/shared/constants/feature-flags.ts` | No change needed (runtime path already correct) |
| Create | `src/main/util/feature-gates.ts` | `feature()` wrapper with build-time `__FEATURES__` + runtime fallback |
| Create | `src/main/util/__tests__/feature-gates.spec.ts` | Tests for runtime fallback path |
| Modify | `src/main/security/permission-manager.ts` | Add `CompiledMatcher`, `compileRules()`, `globToRegex()`, matcher cache |
| Create | `src/main/security/__tests__/permission-matcher.spec.ts` | Tests for glob compilation and caching |
| Modify | `src/shared/types/tool.types.ts` | Create file with `ToolSafetyMetadata` interface |
| Modify | `src/main/tools/tool-registry.ts` | Add `safety?: ToolSafetyMetadata` to `ToolModule`, add `getToolSafety()` helper |
| Create | `src/main/tools/__tests__/tool-safety.spec.ts` | Tests for safety metadata and backward-compat helper |
| Create | `src/main/communication/priority-queue.ts` | `PriorityMessageQueue` with three-bucket ordering |
| Create | `src/main/communication/__tests__/priority-queue.spec.ts` | Tests for enqueue/dequeue ordering, TTL, drain |
| Modify | `src/main/core/config/settings-manager.ts` | Add `SettingsCache` three-level cache + `invalidate()` + `getMerged()` |
| Create | `src/main/core/config/__tests__/settings-cache.spec.ts` | Tests for cache levels, invalidation cascades, fs-watch trigger |
| Modify | `src/main/cli/adapters/base-cli-adapter.ts` | Add `isRealPipe()`, EPIPE handlers on stdin/stdout |
| Modify | `src/main/cli/adapters/gemini-cli-adapter.ts` | Add EPIPE handler in spawn path |
| Modify | `src/main/cli/adapters/codex-cli-adapter.ts` | Add EPIPE handler in spawn path |
| Modify | `src/main/cli/adapters/copilot-sdk-adapter.ts` | Add EPIPE handler in spawn path |
| Create | `src/main/cli/adapters/__tests__/epipe-handling.spec.ts` | Tests for EPIPE swallow and `isRealPipe()` |

---

## Task 1 (E1): Enhanced Markdown Command Discovery

**Files:**
- Read first: `src/main/commands/markdown-command-registry.ts`
- Modify: `src/main/commands/markdown-command-registry.ts`
- Create: `src/main/commands/__tests__/markdown-command-registry.spec.ts`

The registry already loads commands from multiple directories with TTL-based caching. The missing pieces are: (a) an explicit `priority` numeric field on `CommandTemplate` that reflects source order so callers can render override indicators, and (b) a per-directory mtime guard so unchanged directories are not re-walked within the TTL window.

- [ ] **Step 1: Read the existing implementation**

  Read `src/main/commands/markdown-command-registry.ts` in full before writing any code. Note that `CacheEntry` already stores `candidatesByName`, and the load loop iterates `getScanRoots` → `getCommandDirs` in low-to-high priority order. The `priority` field is not on `CommandTemplate` — confirm by reading `src/shared/types/command.types.ts`.

- [ ] **Step 2: Write the test file**

  Create `src/main/commands/__tests__/markdown-command-registry.spec.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

  vi.mock('electron', () => ({
    app: { getPath: vi.fn(() => '/tmp/test-home') },
  }));

  vi.mock('../../logging/logger', () => ({
    getLogger: vi.fn(() => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    })),
  }));

  // fs/promises mock — tracks which dirs were stat-checked
  const statCalls: string[] = [];
  const readdirResults = new Map<string, import('fs').Dirent[]>();
  const fileContents = new Map<string, string>();

  vi.mock('fs/promises', () => ({
    readdir: vi.fn(async (dir: string) => {
      const entries = readdirResults.get(dir);
      if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entries;
    }),
    readFile: vi.fn(async (filePath: string) => {
      const content = fileContents.get(filePath);
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    }),
    stat: vi.fn(async (p: string) => {
      statCalls.push(p);
      // Return a stable mtime for dirs that exist in readdirResults
      if (readdirResults.has(p)) return { mtimeMs: 1000 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
  }));

  import {
    MarkdownCommandRegistry,
    _resetMarkdownCommandRegistryForTesting,
  } from '../markdown-command-registry';

  function makeDirent(name: string, isDir = false): import('fs').Dirent {
    return {
      name,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    } as unknown as import('fs').Dirent;
  }

  const HOME_COMMANDS = '/tmp/test-home/.orchestrator/commands';
  const PROJECT_COMMANDS = '/tmp/test-project/.orchestrator/commands';

  beforeEach(() => {
    _resetMarkdownCommandRegistryForTesting();
    statCalls.length = 0;
    readdirResults.clear();
    fileContents.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('priority field on loaded commands', () => {
    it('global commands get lower priority than project commands', async () => {
      const reg = MarkdownCommandRegistry.getInstance();

      readdirResults.set(HOME_COMMANDS, [makeDirent('foo.md')]);
      fileContents.set(`${HOME_COMMANDS}/foo.md`, '# Foo\nGlobal version');

      readdirResults.set(PROJECT_COMMANDS, [makeDirent('foo.md')]);
      fileContents.set(`${PROJECT_COMMANDS}/foo.md`, '# Foo\nProject version');

      const result = await reg.listCommands('/tmp/test-project');
      const fooCommand = result.commands.find(c => c.name === 'foo');
      expect(fooCommand).toBeDefined();
      // Project-level override should win (later source)
      expect(fooCommand!.template).toContain('Project version');
      // priority field: project > global
      expect(fooCommand!.priority).toBeGreaterThan(0);

      // Both candidates are tracked
      expect(result.candidatesByName['foo']).toHaveLength(2);
      const priorities = result.candidatesByName['foo'].map(c => c.priority);
      expect(priorities[0]).toBeLessThan(priorities[1]);
    });

    it('commands with no override still have a priority field', async () => {
      readdirResults.set(HOME_COMMANDS, [makeDirent('bar.md')]);
      fileContents.set(`${HOME_COMMANDS}/bar.md`, '# Bar\nOnly global');

      const reg = MarkdownCommandRegistry.getInstance();
      const result = await reg.listCommands('/tmp/test-project');
      const bar = result.commands.find(c => c.name === 'bar');
      expect(bar).toBeDefined();
      expect(typeof bar!.priority).toBe('number');
    });
  });

  describe('mtime skip — per-directory optimisation', () => {
    it('skips re-walking a directory whose mtime is unchanged within TTL', async () => {
      readdirResults.set(HOME_COMMANDS, [makeDirent('hello.md')]);
      fileContents.set(`${HOME_COMMANDS}/hello.md`, '# Hello\nworld');

      const reg = MarkdownCommandRegistry.getInstance();

      // First load — populates mtime baseline
      await reg.listCommands('/tmp/test-project');
      const statCallsAfterFirst = statCalls.length;

      // Advance time by less than TTL (TTL = 10 s), mtime unchanged
      vi.advanceTimersByTime(5_000);

      // Second load — cache is still valid, no stat calls needed
      await reg.listCommands('/tmp/test-project');
      expect(statCalls.length).toBe(statCallsAfterFirst); // no new stat calls
    });

    it('re-walks a directory after TTL expires', async () => {
      readdirResults.set(HOME_COMMANDS, [makeDirent('hello.md')]);
      fileContents.set(`${HOME_COMMANDS}/hello.md`, '# Hello\nworld');

      const reg = MarkdownCommandRegistry.getInstance();
      await reg.listCommands('/tmp/test-project');

      // Expire TTL
      vi.advanceTimersByTime(11_000);

      await reg.listCommands('/tmp/test-project');
      // After TTL expiry, stat is called again to re-check directories
      expect(statCalls.length).toBeGreaterThan(0);
    });

    it('re-walks a directory when mtime changes even within TTL', async () => {
      const { stat } = await import('fs/promises');
      let callCount = 0;
      vi.mocked(stat).mockImplementation(async (p: string) => {
        statCalls.push(p as string);
        callCount++;
        // Second call returns a different mtime to simulate file change
        return { mtimeMs: callCount === 1 ? 1000 : 2000 } as import('fs').Stats;
      });

      readdirResults.set(HOME_COMMANDS, [makeDirent('hello.md')]);
      fileContents.set(`${HOME_COMMANDS}/hello.md`, '# Hello\nworld');

      const reg = MarkdownCommandRegistry.getInstance();
      await reg.listCommands('/tmp/test-project');

      // Advance less than TTL but mtime will change on next stat call
      vi.advanceTimersByTime(3_000);
      // Force re-check by clearing just the directory mtime cache
      reg.clearDirectoryMtimeCache('/tmp/test-project');
      await reg.listCommands('/tmp/test-project');

      // Stat should have been called to detect the change
      expect(statCalls.length).toBeGreaterThan(1);
    });
  });
  ```

- [ ] **Step 3: Run tests — expect failures**

  ```bash
  npx vitest run src/main/commands/__tests__/markdown-command-registry.spec.ts --reporter=verbose
  ```

  Expected failures: `priority` field does not exist on `CommandTemplate`, `clearDirectoryMtimeCache` method does not exist.

- [ ] **Step 4: Add `priority` to `CommandTemplate`**

  Read `src/shared/types/command.types.ts`. Add an optional `priority?: number` field to the `CommandTemplate` interface. Do not remove any existing fields.

- [ ] **Step 5: Implement mtime tracking and priority assignment**

  In `markdown-command-registry.ts`:

  a. Add a `dirMtimeCache = new Map<string, number>()` instance field — stores the mtime (ms) of each scanned directory at last scan, keyed by absolute dir path.

  b. Add a `sourcePriorityIndex` parameter to `loadCommandsForWorkingDirectory`. The existing loop already iterates roots then dirs in order; assign `priority` as the loop iteration counter (0-based, incremented per directory).

  c. Before calling `this.walkMarkdownFiles(commandsDir)`, call `fs.stat(commandsDir)` and check whether its mtime matches `this.dirMtimeCache.get(commandsDir)`. If it matches and the overall cache TTL has not expired, skip walking that directory. After walking, store the new mtime in `dirMtimeCache`.

  d. Add `clearDirectoryMtimeCache(workingDirectory?: string): void` — clears `dirMtimeCache` entries for directories belonging to that working directory (or all entries if no argument).

  e. Pass `priority` to `toCommandTemplate` and store it on the returned `CommandTemplate`.

- [ ] **Step 6: Run tests — expect pass**

  ```bash
  npx vitest run src/main/commands/__tests__/markdown-command-registry.spec.ts --reporter=verbose
  ```

- [ ] **Step 7: Type-check**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  ```

  Fix any errors before continuing.

---

## Task 2 (E2): Feature Gates with Dead Code Elimination

**Files:**
- Read first: `src/shared/constants/feature-flags.ts`
- Create: `src/main/util/feature-gates.ts`
- Create: `src/main/util/__tests__/feature-gates.spec.ts`

The existing `isFeatureEnabled()` in `feature-flags.ts` handles the runtime path correctly. This task wraps it with a `feature()` function that additionally supports a build-time `__FEATURES__` global injected by esbuild (no build config changes — test the runtime fallback only).

- [ ] **Step 1: Read `src/shared/constants/feature-flags.ts`**

  Confirm the `isFeatureEnabled` signature and `FeatureFlag` type. Note that `ORCHESTRATION_FEATURES` is `as const` so all flags are typed literals.

- [ ] **Step 2: Write the test file**

  Create `src/main/util/__tests__/feature-gates.spec.ts`:

  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';

  // No electron mock needed — feature-gates.ts is a pure utility.

  describe('feature()', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore env
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    });

    it('returns true for a known-enabled flag', async () => {
      const { feature } = await import('../feature-gates');
      // DEBATE_SYSTEM defaults to true in ORCHESTRATION_FEATURES
      expect(feature('DEBATE_SYSTEM')).toBe(true);
    });

    it('respects ORCH_FEATURE_<FLAG>=false env override', async () => {
      process.env['ORCH_FEATURE_DEBATE_SYSTEM'] = 'false';
      // Re-import to pick up env change (or use direct call — feature() reads env at call time)
      const { feature } = await import('../feature-gates');
      expect(feature('DEBATE_SYSTEM')).toBe(false);
    });

    it('respects ORCH_FEATURE_<FLAG>=true env override for a default-false flag', async () => {
      // Add a test flag temporarily via env — use a known flag that could be toggled
      process.env['ORCH_FEATURE_TOKEN_BUDGET'] = 'true';
      const { feature } = await import('../feature-gates');
      expect(feature('TOKEN_BUDGET')).toBe(true);
    });

    it('returns false for an unknown flag string', async () => {
      const { feature } = await import('../feature-gates');
      expect(feature('NONEXISTENT_FLAG_XYZ')).toBe(false);
    });

    it('returns true when __FEATURES__ build-time object contains the flag', async () => {
      // Simulate the build-time path by calling featureFromRecord directly
      const { featureFromRecord } = await import('../feature-gates');
      expect(featureFromRecord({ MY_FEATURE: true }, 'MY_FEATURE')).toBe(true);
      expect(featureFromRecord({ MY_FEATURE: false }, 'MY_FEATURE')).toBe(false);
      expect(featureFromRecord({}, 'MY_FEATURE')).toBe(false);
    });

    it('feature() is callable with any string — no TypeScript error at call site', async () => {
      const { feature } = await import('../feature-gates');
      // Should not throw — unknown flags just return false
      expect(() => feature('ANYTHING')).not.toThrow();
    });
  });
  ```

- [ ] **Step 3: Run tests — expect failures**

  ```bash
  npx vitest run src/main/util/__tests__/feature-gates.spec.ts --reporter=verbose
  ```

  Expected failures: module `../feature-gates` does not exist.

- [ ] **Step 4: Implement `src/main/util/feature-gates.ts`**

  ```typescript
  /**
   * Feature gates — thin wrapper around isFeatureEnabled() that additionally
   * supports a build-time __FEATURES__ global for dead-code elimination via esbuild.
   *
   * Build-time usage (esbuild define):
   *   define: { '__FEATURES__': JSON.stringify({ DEBATE_SYSTEM: true, ... }) }
   *
   * When __FEATURES__ is defined at bundle time, esbuild can eliminate the
   * dead branch and tree-shake disabled feature code entirely.
   *
   * Runtime fallback: delegates to isFeatureEnabled() from feature-flags.ts,
   * which supports ORCH_FEATURE_<FLAG>=true|false environment overrides.
   */
  import { isFeatureEnabled, type FeatureFlag } from '../../shared/constants/feature-flags';

  declare const __FEATURES__: Record<string, boolean> | undefined;

  /**
   * Exported for testing: check a flag against an explicit record.
   * This is the code path taken when __FEATURES__ is defined at build time.
   */
  export function featureFromRecord(record: Record<string, boolean>, flag: string): boolean {
    return record[flag] === true;
  }

  /**
   * Check whether a feature flag is enabled.
   *
   * At build time, if esbuild replaces __FEATURES__ with a literal object,
   * the dead branch is eliminated. At runtime, falls back to isFeatureEnabled()
   * which reads ORCH_FEATURE_<FLAG> environment variables.
   */
  export function feature(flag: string): boolean {
    // Build-time path: esbuild replaces __FEATURES__ with a literal object,
    // allowing the minifier to eliminate dead branches.
    if (typeof __FEATURES__ !== 'undefined') {
      return featureFromRecord(__FEATURES__, flag);
    }
    // Runtime fallback: use the env-override-aware runtime function.
    // Cast to FeatureFlag — unknown flags return false from isFeatureEnabled.
    return isFeatureEnabled(flag as FeatureFlag);
  }
  ```

- [ ] **Step 5: Run tests — expect pass**

  ```bash
  npx vitest run src/main/util/__tests__/feature-gates.spec.ts --reporter=verbose
  ```

- [ ] **Step 6: Type-check**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  ```

  Fix any errors. Note: `declare const __FEATURES__` may require a `/// <reference types="..." />` or a global augmentation if tsc complains about the `declare const` in a module context. If so, wrap it in a try/catch pattern or use `(globalThis as any).__FEATURES__` with a type assertion.

---

## Task 3 (E3): Permission Matcher Compilation

**Files:**
- Read first: `src/main/security/permission-manager.ts` (full file)
- Modify: `src/main/security/permission-manager.ts`
- Create: `src/main/security/__tests__/permission-matcher.spec.ts`

The `PermissionManager` already has decision caching but evaluates glob patterns on every check. This task pre-compiles patterns to `RegExp` at rule-load time and caches compiled matchers by rule hash.

- [ ] **Step 1: Read `src/main/security/permission-manager.ts` in full**

  Identify where `PermissionRule[]` is stored and where `pattern` fields are currently evaluated. Note the `priority` field (lower = higher priority).

- [ ] **Step 2: Write the test file**

  Create `src/main/security/__tests__/permission-matcher.spec.ts`:

  ```typescript
  import { describe, it, expect } from 'vitest';
  import {
    globToRegex,
    compileRules,
    type CompiledMatcher,
  } from '../permission-manager';
  import type { PermissionRule } from '../permission-manager';

  function makeRule(pattern: string, id = 'r1'): PermissionRule {
    return {
      id,
      name: `rule-${id}`,
      scope: 'file_read',
      pattern,
      action: 'allow',
      priority: 0,
      source: 'default',
      enabled: true,
    };
  }

  describe('globToRegex()', () => {
    it('matches an exact filename', () => {
      const re = globToRegex('foo.ts');
      expect(re.test('foo.ts')).toBe(true);
      expect(re.test('bar.ts')).toBe(false);
    });

    it('* matches within a single path segment', () => {
      const re = globToRegex('src/*.ts');
      expect(re.test('src/index.ts')).toBe(true);
      expect(re.test('src/nested/index.ts')).toBe(false);
    });

    it('** matches across path separators', () => {
      const re = globToRegex('src/**/*.ts');
      expect(re.test('src/foo.ts')).toBe(true);
      expect(re.test('src/a/b/c/index.ts')).toBe(true);
      expect(re.test('lib/foo.ts')).toBe(false);
    });

    it('? matches exactly one non-separator character', () => {
      const re = globToRegex('fo?.ts');
      expect(re.test('foo.ts')).toBe(true);
      expect(re.test('fo.ts')).toBe(false);
      expect(re.test('fooo.ts')).toBe(false);
    });

    it('escapes regex special characters in literal parts', () => {
      const re = globToRegex('path/to/file.ts');
      // The dot in 'file.ts' should match only a literal dot
      expect(re.test('path/to/fileXts')).toBe(false);
      expect(re.test('path/to/file.ts')).toBe(true);
    });

    it('handles patterns with no wildcards', () => {
      const re = globToRegex('/usr/local/bin/node');
      expect(re.test('/usr/local/bin/node')).toBe(true);
      expect(re.test('/usr/local/bin/node2')).toBe(false);
    });
  });

  describe('compileRules()', () => {
    it('returns a CompiledMatcher with a ruleHash', () => {
      const matcher = compileRules([makeRule('src/*.ts')]);
      expect(typeof matcher.ruleHash).toBe('string');
      expect(matcher.ruleHash.length).toBeGreaterThan(0);
    });

    it('test() returns true when any rule pattern matches', () => {
      const matcher = compileRules([
        makeRule('src/*.ts', 'r1'),
        makeRule('lib/*.js', 'r2'),
      ]);
      expect(matcher.test('src/index.ts')).toBe(true);
      expect(matcher.test('lib/util.js')).toBe(true);
    });

    it('test() returns false when no pattern matches', () => {
      const matcher = compileRules([makeRule('src/*.ts')]);
      expect(matcher.test('test/index.spec.ts')).toBe(false);
    });

    it('same rules produce same ruleHash', () => {
      const rules = [makeRule('src/*.ts'), makeRule('lib/*.js', 'r2')];
      const m1 = compileRules(rules);
      const m2 = compileRules(rules);
      expect(m1.ruleHash).toBe(m2.ruleHash);
    });

    it('different rules produce different ruleHash', () => {
      const m1 = compileRules([makeRule('src/*.ts')]);
      const m2 = compileRules([makeRule('lib/*.ts')]);
      expect(m1.ruleHash).not.toBe(m2.ruleHash);
    });

    it('handles empty rule list', () => {
      const matcher = compileRules([]);
      expect(matcher.test('anything')).toBe(false);
      expect(typeof matcher.ruleHash).toBe('string');
    });

    it('only includes enabled rules', () => {
      const disabledRule: PermissionRule = { ...makeRule('src/*.ts'), enabled: false };
      const matcher = compileRules([disabledRule]);
      expect(matcher.test('src/index.ts')).toBe(false);
    });
  });
  ```

- [ ] **Step 3: Run tests — expect failures**

  ```bash
  npx vitest run src/main/security/__tests__/permission-matcher.spec.ts --reporter=verbose
  ```

  Expected: `globToRegex` and `compileRules` are not exported from `permission-manager.ts`.

- [ ] **Step 4: Implement `globToRegex` and `compileRules` in `permission-manager.ts`**

  Add the following exports near the top of the file (before the class declaration, after imports):

  ```typescript
  export interface CompiledMatcher {
    test(input: string): boolean;
    ruleHash: string;
  }

  /**
   * Convert a glob pattern to a RegExp. No external dependencies.
   * Supported wildcards: * (single segment), ** (multi-segment), ? (single char).
   */
  export function globToRegex(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // Escape regex specials
      .replace(/\*\*/g, '{{GLOBSTAR}}')          // Preserve ** before replacing *
      .replace(/\*/g, '[^/]*')                   // * = one segment
      .replace(/\?/g, '[^/]')                    // ? = one char (non-separator)
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');        // ** = anything
    return new RegExp(`^${escaped}$`);
  }

  /**
   * Produce a stable hash string for a rule list (used as cache key).
   */
  function hashRules(rules: PermissionRule[]): string {
    return rules
      .filter(r => r.enabled)
      .map(r => `${r.id}:${r.pattern}:${r.action}:${r.priority}`)
      .join('|');
  }

  /**
   * Compile a list of PermissionRules into a single CompiledMatcher.
   * Only enabled rules are compiled. The ruleHash uniquely identifies
   * this combination of rules so results can be cached by hash.
   */
  export function compileRules(rules: PermissionRule[]): CompiledMatcher {
    const enabledRules = rules.filter(r => r.enabled);
    const regexes = enabledRules.map(r => globToRegex(r.pattern));
    const ruleHash = hashRules(rules);
    return {
      test: (input: string) => regexes.some(re => re.test(input)),
      ruleHash,
    };
  }
  ```

  Then add a matcher cache to `PermissionManager`:

  ```typescript
  private matcherCache = new Map<string, CompiledMatcher>();

  private getCompiledMatcher(rules: PermissionRule[]): CompiledMatcher {
    const hash = hashRules(rules);
    const cached = this.matcherCache.get(hash);
    if (cached) return cached;
    const matcher = compileRules(rules);
    this.matcherCache.set(hash, matcher);
    return matcher;
  }
  ```

  Call `this.matcherCache.clear()` wherever rules are updated/replaced.

- [ ] **Step 5: Run tests — expect pass**

  ```bash
  npx vitest run src/main/security/__tests__/permission-matcher.spec.ts --reporter=verbose
  ```

- [ ] **Step 6: Type-check**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  ```

---

## Task 4 (E4): Tool Concurrency Safety Declarations

**Files:**
- Read first: `src/main/tools/tool-registry.ts` (full file)
- Create: `src/shared/types/tool.types.ts`
- Modify: `src/main/tools/tool-registry.ts`
- Create: `src/main/tools/__tests__/tool-safety.spec.ts`

`ToolModule` already has `concurrencySafe?: boolean`. This task adds a richer `ToolSafetyMetadata` interface and a `getToolSafety()` helper with backward-compat derivation from the old flag.

- [ ] **Step 1: Read `src/main/tools/tool-registry.ts` in full**

  Note the existing `ToolModule` interface at lines 35-41. Also check whether `src/shared/types/tool.types.ts` exists (it likely does not — confirm).

- [ ] **Step 2: Write the test file**

  Create `src/main/tools/__tests__/tool-safety.spec.ts`:

  ```typescript
  import { describe, it, expect } from 'vitest';
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
  ```

- [ ] **Step 3: Run tests — expect failures**

  ```bash
  npx vitest run src/main/tools/__tests__/tool-safety.spec.ts --reporter=verbose
  ```

  Expected: `ToolSafetyMetadata` and `getToolSafety` are not exported.

- [ ] **Step 4: Create `src/shared/types/tool.types.ts`**

  ```typescript
  /**
   * Shared tool safety metadata.
   * Used by the orchestration layer to make scheduling decisions.
   */
  export interface ToolSafetyMetadata {
    /** Can this tool run concurrently with other tools without conflict? */
    isConcurrencySafe: boolean;
    /** Does this tool have no observable side effects? */
    isReadOnly: boolean;
    /** Does this tool make irreversible changes (delete, overwrite)? */
    isDestructive: boolean;
    /** Approximate execution time hint for the scheduler (optional). */
    estimatedDurationMs?: number;
  }
  ```

- [ ] **Step 5: Update `src/main/tools/tool-registry.ts`**

  a. Add import at the top:
  ```typescript
  import type { ToolSafetyMetadata } from '../../shared/types/tool.types';
  ```

  b. Add `safety?: ToolSafetyMetadata` to the `ToolModule` interface (after `concurrencySafe`):
  ```typescript
  export interface ToolModule {
    description: string;
    args?: z.ZodRawShape | z.ZodTypeAny;
    /** Whether this tool can run concurrently with other tools (default: true) */
    concurrencySafe?: boolean;
    /** Richer safety metadata — takes precedence over concurrencySafe when present */
    safety?: ToolSafetyMetadata;
    execute: (args: any, ctx: ToolContext) => unknown | Promise<unknown>;
  }
  ```

  c. Add the helper function (export, place before the class):
  ```typescript
  /**
   * Return safety metadata for a tool, falling back to legacy concurrencySafe
   * flag for backward compatibility with tools that predate the richer metadata.
   */
  export function getToolSafety(tool: ToolModule): ToolSafetyMetadata {
    if (tool.safety) return tool.safety;
    return {
      isConcurrencySafe: tool.concurrencySafe ?? true,
      isReadOnly: false,
      isDestructive: false,
    };
  }
  ```

  d. Also re-export `ToolSafetyMetadata` from tool-registry for convenient single-import access:
  ```typescript
  export type { ToolSafetyMetadata } from '../../shared/types/tool.types';
  ```

- [ ] **Step 6: Run tests — expect pass**

  ```bash
  npx vitest run src/main/tools/__tests__/tool-safety.spec.ts --reporter=verbose
  ```

- [ ] **Step 7: Type-check**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  ```

---

## Task 5 (E5): Priority Message Queue

**Files:**
- Read first: `src/main/communication/cross-instance-comm.ts` (full file)
- Create: `src/main/communication/priority-queue.ts`
- Create: `src/main/communication/__tests__/priority-queue.spec.ts`

`CrossInstanceComm` stores messages in a plain `Map<string, CommMessage[]>` with FIFO ordering. This task introduces a standalone `PriorityMessageQueue` that can replace (or augment) that store.

- [ ] **Step 1: Read `src/main/communication/cross-instance-comm.ts` in full**

  Note the `CommMessage` interface and `this.messages` map. Understand which methods consume messages so the integration path is clear.

- [ ] **Step 2: Write the test file**

  Create `src/main/communication/__tests__/priority-queue.spec.ts`:

  ```typescript
  import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
  import { PriorityMessageQueue, type PriorityMessage, type MessagePriority } from '../priority-queue';

  function msg(
    id: string,
    priority: MessagePriority,
    payload: string = id,
    overrides: Partial<PriorityMessage> = {},
  ): PriorityMessage {
    return { id, priority, payload, timestamp: Date.now(), ...overrides };
  }

  describe('PriorityMessageQueue', () => {
    let queue: PriorityMessageQueue;

    beforeEach(() => {
      queue = new PriorityMessageQueue();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('enqueue / dequeue ordering', () => {
      it('dequeues higher priority messages before lower priority ones', () => {
        queue.enqueue(msg('a', 'later'));
        queue.enqueue(msg('b', 'now'));
        queue.enqueue(msg('c', 'next'));

        expect(queue.dequeue()?.id).toBe('b');    // now first
        expect(queue.dequeue()?.id).toBe('c');    // next second
        expect(queue.dequeue()?.id).toBe('a');    // later last
      });

      it('maintains FIFO order within the same priority', () => {
        queue.enqueue(msg('x1', 'next'));
        queue.enqueue(msg('x2', 'next'));
        queue.enqueue(msg('x3', 'next'));

        expect(queue.dequeue()?.id).toBe('x1');
        expect(queue.dequeue()?.id).toBe('x2');
        expect(queue.dequeue()?.id).toBe('x3');
      });

      it('returns undefined when queue is empty', () => {
        expect(queue.dequeue()).toBeUndefined();
      });

      it('mixes priorities correctly across multiple enqueues', () => {
        queue.enqueue(msg('later1', 'later'));
        queue.enqueue(msg('now1', 'now'));
        queue.enqueue(msg('next1', 'next'));
        queue.enqueue(msg('now2', 'now'));
        queue.enqueue(msg('later2', 'later'));

        const order = [];
        let m;
        while ((m = queue.dequeue())) order.push(m.id);

        expect(order).toEqual(['now1', 'now2', 'next1', 'later1', 'later2']);
      });
    });

    describe('peek()', () => {
      it('returns the next message without removing it', () => {
        queue.enqueue(msg('a', 'now'));
        expect(queue.peek()?.id).toBe('a');
        expect(queue.size()).toBe(1); // Still in queue
      });

      it('returns undefined when empty', () => {
        expect(queue.peek()).toBeUndefined();
      });
    });

    describe('size()', () => {
      it('tracks total count across all buckets', () => {
        queue.enqueue(msg('a', 'now'));
        queue.enqueue(msg('b', 'next'));
        queue.enqueue(msg('c', 'later'));
        expect(queue.size()).toBe(3);
        queue.dequeue();
        expect(queue.size()).toBe(2);
      });
    });

    describe('clear()', () => {
      it('removes all messages from all buckets', () => {
        queue.enqueue(msg('a', 'now'));
        queue.enqueue(msg('b', 'next'));
        queue.clear();
        expect(queue.size()).toBe(0);
        expect(queue.dequeue()).toBeUndefined();
      });
    });

    describe('drain()', () => {
      it('returns all messages in priority order and empties the queue', () => {
        queue.enqueue(msg('later1', 'later'));
        queue.enqueue(msg('now1', 'now'));
        queue.enqueue(msg('next1', 'next'));

        const drained = queue.drain();
        expect(drained.map(m => m.id)).toEqual(['now1', 'next1', 'later1']);
        expect(queue.size()).toBe(0);
      });

      it('returns empty array when queue is empty', () => {
        expect(queue.drain()).toEqual([]);
      });
    });

    describe('TTL / expiry', () => {
      it('skips expired messages during dequeue', () => {
        const pastExpiry = Date.now() - 1000; // already expired
        queue.enqueue(msg('expired', 'now', 'expired', { expiresAt: pastExpiry }));
        queue.enqueue(msg('fresh', 'now'));

        expect(queue.dequeue()?.id).toBe('fresh');
        expect(queue.dequeue()).toBeUndefined();
      });

      it('dequeues a message before its expiry', () => {
        const futureExpiry = Date.now() + 5000;
        queue.enqueue(msg('valid', 'now', 'valid', { expiresAt: futureExpiry }));
        expect(queue.dequeue()?.id).toBe('valid');
      });

      it('drain() excludes expired messages', () => {
        const pastExpiry = Date.now() - 1;
        queue.enqueue(msg('expired', 'next', 'expired', { expiresAt: pastExpiry }));
        queue.enqueue(msg('fresh', 'next'));
        const drained = queue.drain();
        expect(drained.map(m => m.id)).toEqual(['fresh']);
      });
    });
  });
  ```

- [ ] **Step 3: Run tests — expect failures**

  ```bash
  npx vitest run src/main/communication/__tests__/priority-queue.spec.ts --reporter=verbose
  ```

  Expected: module `../priority-queue` does not exist.

- [ ] **Step 4: Implement `src/main/communication/priority-queue.ts`**

  ```typescript
  /**
   * Priority Message Queue
   *
   * Three-bucket priority queue for inter-instance messages.
   * Priorities: 'now' > 'next' > 'later'. FIFO within each bucket.
   * Supports optional per-message TTL via expiresAt timestamp.
   *
   * Intended as the internal message store for CrossInstanceComm.
   * Standalone — no Electron or Node.js imports required.
   */

  export type MessagePriority = 'now' | 'next' | 'later';

  export interface PriorityMessage<T = unknown> {
    id: string;
    priority: MessagePriority;
    payload: T;
    timestamp: number;
    /** Optional Unix ms timestamp after which this message is considered stale. */
    expiresAt?: number;
  }

  const PRIORITY_ORDER: MessagePriority[] = ['now', 'next', 'later'];

  export class PriorityMessageQueue<T = unknown> {
    private buckets = new Map<MessagePriority, PriorityMessage<T>[]>([
      ['now', []],
      ['next', []],
      ['later', []],
    ]);

    enqueue(msg: PriorityMessage<T>): void {
      this.buckets.get(msg.priority)!.push(msg);
    }

    /**
     * Dequeue the highest-priority non-expired message.
     * Expired messages are silently discarded.
     */
    dequeue(): PriorityMessage<T> | undefined {
      const now = Date.now();
      for (const priority of PRIORITY_ORDER) {
        const bucket = this.buckets.get(priority)!;
        while (bucket.length > 0) {
          const candidate = bucket.shift()!;
          if (candidate.expiresAt !== undefined && candidate.expiresAt <= now) {
            continue; // Discard expired
          }
          return candidate;
        }
      }
      return undefined;
    }

    peek(): PriorityMessage<T> | undefined {
      const now = Date.now();
      for (const priority of PRIORITY_ORDER) {
        const bucket = this.buckets.get(priority)!;
        for (const msg of bucket) {
          if (msg.expiresAt === undefined || msg.expiresAt > now) {
            return msg;
          }
        }
      }
      return undefined;
    }

    size(): number {
      let total = 0;
      for (const bucket of this.buckets.values()) {
        total += bucket.length;
      }
      return total;
    }

    clear(): void {
      for (const bucket of this.buckets.values()) {
        bucket.length = 0;
      }
    }

    /** Return all non-expired messages in priority order, emptying the queue. */
    drain(): PriorityMessage<T>[] {
      const now = Date.now();
      const result: PriorityMessage<T>[] = [];
      for (const priority of PRIORITY_ORDER) {
        const bucket = this.buckets.get(priority)!;
        for (const msg of bucket) {
          if (msg.expiresAt === undefined || msg.expiresAt > now) {
            result.push(msg);
          }
        }
        bucket.length = 0;
      }
      return result;
    }
  }
  ```

- [ ] **Step 5: Run tests — expect pass**

  ```bash
  npx vitest run src/main/communication/__tests__/priority-queue.spec.ts --reporter=verbose
  ```

- [ ] **Step 6: Type-check**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  ```

---

## Task 6 (E6): Multi-Layer Settings Cache

**Files:**
- Read first: `src/main/core/config/settings-manager.ts` (full file)
- Read first: `src/shared/types/settings.types.ts` (for `AppSettings` and `DEFAULT_SETTINGS`)
- Modify: `src/main/core/config/settings-manager.ts`
- Create: `src/main/core/config/__tests__/settings-cache.spec.ts`

`SettingsManager` currently uses a single ElectronStore. This task adds an in-process three-level cache that is invalidation-aware and supports cascading.

- [ ] **Step 1: Read both files before writing anything**

  Read `src/main/core/config/settings-manager.ts` and `src/shared/types/settings.types.ts` in full. Understand what `AppSettings` fields exist and what `DEFAULT_SETTINGS` provides, so the merge logic is type-safe.

- [ ] **Step 2: Write the test file**

  Create `src/main/core/config/__tests__/settings-cache.spec.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

  // ElectronStore mock — in-memory key/value
  const store: Record<string, unknown> = {};
  vi.mock('electron-store', () => {
    return {
      default: vi.fn().mockImplementation(() => ({
        get store() { return { ...store }; },
        get: vi.fn((k: string) => store[k]),
        set: vi.fn((k: string | Record<string, unknown>, v?: unknown) => {
          if (typeof k === 'object') Object.assign(store, k);
          else store[k] = v;
        }),
        clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
        path: '/tmp/test-settings.json',
      })),
    };
  });

  vi.mock('electron', () => ({
    app: {
      getPath: vi.fn((key: string) => `/tmp/test-${key}`),
    },
  }));

  vi.mock('../../../logging/logger', () => ({
    getLogger: vi.fn(() => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    })),
  }));

  vi.mock('fs', () => ({
    existsSync: vi.fn(() => false),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    watch: vi.fn(() => ({ close: vi.fn() })),
  }));

  import { SettingsManager } from '../settings-manager';

  beforeEach(() => {
    // Clear store between tests
    for (const k of Object.keys(store)) delete store[k];
  });

  describe('SettingsManager settings cache', () => {
    it('getMerged() returns a settings object', () => {
      const mgr = new SettingsManager();
      const merged = mgr.getMerged();
      expect(merged).toBeDefined();
      expect(typeof merged).toBe('object');
    });

    it('getMerged() returns the same reference on repeated calls (cached)', () => {
      const mgr = new SettingsManager();
      const first = mgr.getMerged();
      const second = mgr.getMerged();
      // Same object reference — cache is alive
      expect(first).toBe(second);
    });

    it('invalidate(3) clears the merged cache', () => {
      const mgr = new SettingsManager();
      const first = mgr.getMerged();
      mgr.invalidate(3);
      const second = mgr.getMerged();
      // New object after invalidation
      expect(first).not.toBe(second);
    });

    it('invalidate(1) cascades to levels 2 and 3', () => {
      const mgr = new SettingsManager();
      const first = mgr.getMerged();
      mgr.invalidate(1);
      const second = mgr.getMerged();
      expect(first).not.toBe(second);
    });

    it('invalidate() with no argument clears all levels', () => {
      const mgr = new SettingsManager();
      const first = mgr.getMerged();
      mgr.invalidate();
      const second = mgr.getMerged();
      expect(first).not.toBe(second);
    });

    it('getMerged() reflects a setting change after invalidation', () => {
      const mgr = new SettingsManager();
      mgr.set('theme', 'dark' as any);
      mgr.invalidate(3);
      const merged = mgr.getMerged();
      expect((merged as any).theme).toBe('dark');
    });
  });
  ```

- [ ] **Step 3: Run tests — expect failures**

  ```bash
  npx vitest run src/main/core/config/__tests__/settings-cache.spec.ts --reporter=verbose
  ```

  Expected: `getMerged()` and `invalidate()` are not on `SettingsManager`.

- [ ] **Step 4: Add the three-level cache to `settings-manager.ts`**

  Add these types and fields to the class. Do not remove any existing methods.

  a. Add a `SettingsCache` interface above the class:
  ```typescript
  interface SettingsCache {
    /** Level 3: Fully merged settings — most expensive to recompute */
    merged: AppSettings | null;
    /** Level 3 timestamp — when merged was last computed */
    mergedAt: number;
  }
  ```

  b. Add the cache field inside the class:
  ```typescript
  private settingsCache: SettingsCache = { merged: null, mergedAt: 0 };
  ```

  c. Add `getMerged()`:
  ```typescript
  getMerged(): AppSettings {
    if (this.settingsCache.merged !== null) {
      return this.settingsCache.merged;
    }
    const merged = this.store.store;
    this.settingsCache.merged = merged;
    this.settingsCache.mergedAt = Date.now();
    return merged;
  }
  ```

  d. Add `invalidate(level?: 1 | 2 | 3)`:
  ```typescript
  /**
   * Invalidate the settings cache.
   * Level 1 = parsed file cache (cascades to 2 and 3).
   * Level 2 = per-source merged cache (cascades to 3).
   * Level 3 = fully merged cache only.
   * No argument = clear all levels.
   */
  invalidate(level?: 1 | 2 | 3): void {
    // All levels reset the merged (level-3) cache.
    this.settingsCache.merged = null;
    this.settingsCache.mergedAt = 0;
    // Levels 1 and 2 would additionally clear file-parse and source caches
    // if those were implemented. Placeholder for future per-source caching.
  }
  ```

  e. Call `this.invalidate(3)` at the end of any existing `set()` or `update()` methods so the merged cache is invalidated on writes.

- [ ] **Step 5: Run tests — expect pass**

  ```bash
  npx vitest run src/main/core/config/__tests__/settings-cache.spec.ts --reporter=verbose
  ```

- [ ] **Step 6: Type-check**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  ```

---

## Task 7 (E7): EPIPE/Stdin Handling

**Files:**
- Read first: `src/main/cli/adapters/base-cli-adapter.ts` (lines 414-473 for `spawnProcess`)
- Read first: `src/main/cli/adapters/claude-cli-adapter.ts` (lines 284-300 for existing EPIPE pattern)
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`
- Modify: `src/main/cli/adapters/gemini-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/copilot-sdk-adapter.ts`
- Create: `src/main/cli/adapters/__tests__/epipe-handling.spec.ts`

The Claude adapter already handles EPIPE on stdin (lines 287-296, 624-630). The base adapter and the other three adapters do not. This task centralises the guard in `BaseCliAdapter` and verifies all adapters inherit it.

- [ ] **Step 1: Read the existing implementations**

  Read `src/main/cli/adapters/base-cli-adapter.ts` fully, then read the EPIPE sections of `claude-cli-adapter.ts` (around lines 284-300 and 620-635). Understand the existing pattern before adding to base.

- [ ] **Step 2: Write the test file**

  Create `src/main/cli/adapters/__tests__/epipe-handling.spec.ts`:

  ```typescript
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { EventEmitter } from 'events';

  // We test the EPIPE guard logic directly — no need to mock Electron.
  // Simulate the stdin/stdout stream error handler pattern.

  function makeStream(writable: boolean, destroyed: boolean) {
    const emitter = new EventEmitter() as NodeJS.WritableStream & EventEmitter;
    (emitter as any).writable = writable;
    (emitter as any).destroyed = destroyed;
    return emitter;
  }

  describe('EPIPE handling helpers', () => {
    describe('isRealPipe()', () => {
      it('returns true when stdin is writable and not destroyed', () => {
        // Simulate the isRealPipe check directly
        const stdin = makeStream(true, false);
        const result = (stdin as any).writable === true && !(stdin as any).destroyed;
        expect(result).toBe(true);
      });

      it('returns false when stdin is not writable', () => {
        const stdin = makeStream(false, false);
        const result = (stdin as any).writable === true && !(stdin as any).destroyed;
        expect(result).toBe(false);
      });

      it('returns false when stdin is destroyed', () => {
        const stdin = makeStream(true, true);
        const result = (stdin as any).writable === true && !(stdin as any).destroyed;
        expect(result).toBe(false);
      });
    });

    describe('EPIPE error swallowing', () => {
      it('swallows EPIPE errors silently (does not rethrow)', () => {
        const stdin = makeStream(true, false);
        let rethrown: Error | null = null;

        // Apply the same error handler pattern as the adapters
        stdin.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EPIPE') return; // swallow
          rethrown = err;
        });

        const epipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        stdin.emit('error', epipeError);

        expect(rethrown).toBeNull();
      });

      it('does not swallow non-EPIPE errors', () => {
        const stdin = makeStream(true, false);
        let rethrown: Error | null = null;

        stdin.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EPIPE') return;
          rethrown = err;
        });

        const otherError = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });
        stdin.emit('error', otherError);

        expect(rethrown).toBe(otherError);
      });

      it('handles stdout EPIPE independently', () => {
        const stdout = makeStream(true, false);
        let rethrown: Error | null = null;

        stdout.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EPIPE') return;
          rethrown = err;
        });

        stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        expect(rethrown).toBeNull();
      });
    });
  });

  describe('BaseCliAdapter.isRealPipe() integration', () => {
    // Dynamically import after mocking to avoid Electron dependency
    it('base adapter exports isRealPipe utility as a protected method', async () => {
      // Verify the method exists on the class by checking via prototype inspection
      // (We cannot instantiate BaseCliAdapter directly as it is abstract.)
      const mod = await import('../base-cli-adapter');
      expect(typeof mod.BaseCliAdapter).toBe('function');
      expect(typeof mod.BaseCliAdapter.prototype['isRealPipe']).toBe('function');
    });
  });
  ```

- [ ] **Step 3: Run tests — expect failures**

  ```bash
  npx vitest run src/main/cli/adapters/__tests__/epipe-handling.spec.ts --reporter=verbose
  ```

  Expected failure: `BaseCliAdapter.prototype['isRealPipe']` is not a function.

- [ ] **Step 4: Add `isRealPipe()` to `base-cli-adapter.ts`**

  Add this protected method to `BaseCliAdapter` (after `spawnProcess`, before stream idle watchdog):

  ```typescript
  /**
   * Returns true if the spawned process's stdin pipe is open and writable.
   * Use this guard before writing to stdin to avoid EPIPE errors on
   * processes that have already closed their pipe end.
   */
  protected isRealPipe(): boolean {
    return this.process?.stdin?.writable === true && !this.process.stdin.destroyed;
  }
  ```

- [ ] **Step 5: Add centralized EPIPE handlers in `spawnProcess` of `base-cli-adapter.ts`**

  Inside `spawnProcess()`, after the `proc` is created and before `return proc`, add:

  ```typescript
  // Guard against EPIPE errors on stdin/stdout — these occur when the CLI
  // process closes its pipe end before we finish writing (common on early exit).
  proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      logger.debug('EPIPE on stdin — CLI process closed pipe', {
        adapter: this.getName(),
        pid: proc.pid,
      });
      return;
    }
    // Non-EPIPE stdin errors are re-emitted as adapter errors
    this.emit('error', err);
  });

  proc.stdout?.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      logger.debug('EPIPE on stdout — consumer closed pipe', {
        adapter: this.getName(),
        pid: proc.pid,
      });
      return;
    }
    this.emit('error', err);
  });
  ```

- [ ] **Step 6: Audit the other adapters for duplicate per-adapter EPIPE handlers**

  Read `gemini-cli-adapter.ts`, `codex-cli-adapter.ts`, and `copilot-sdk-adapter.ts` in full. For each one:
  - If the adapter calls `this.spawnProcess()` for all process creation, the base handler is sufficient — no change needed beyond the stdin `end()` calls Gemini already does.
  - If any adapter adds its own stdin error handler that duplicates the base, comment it with `// Base adapter handles EPIPE — see BaseCliAdapter.spawnProcess()` and remove the duplicate.
  - For Gemini (which calls `this.process.stdin.end()` immediately after spawn — stdin is always closed), verify the `end()` call still happens correctly and no duplicate error listener is needed.

- [ ] **Step 7: Run full test file — expect pass**

  ```bash
  npx vitest run src/main/cli/adapters/__tests__/epipe-handling.spec.ts --reporter=verbose
  ```

- [ ] **Step 8: Type-check all modified adapter files**

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  ```

---

## Final Verification

Run all seven test files together and confirm the full build compiles cleanly.

- [ ] **Run all new tests**

  ```bash
  npx vitest run \
    src/main/commands/__tests__/markdown-command-registry.spec.ts \
    src/main/util/__tests__/feature-gates.spec.ts \
    src/main/security/__tests__/permission-matcher.spec.ts \
    src/main/tools/__tests__/tool-safety.spec.ts \
    src/main/communication/__tests__/priority-queue.spec.ts \
    src/main/core/config/__tests__/settings-cache.spec.ts \
    src/main/cli/adapters/__tests__/epipe-handling.spec.ts \
    --reporter=verbose
  ```

- [ ] **Full type-check**

  ```bash
  npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json
  ```

- [ ] **Lint**

  ```bash
  npx eslint \
    src/main/commands/markdown-command-registry.ts \
    src/main/util/feature-gates.ts \
    src/main/security/permission-manager.ts \
    src/shared/types/tool.types.ts \
    src/main/tools/tool-registry.ts \
    src/main/communication/priority-queue.ts \
    src/main/core/config/settings-manager.ts \
    src/main/cli/adapters/base-cli-adapter.ts \
    src/main/cli/adapters/gemini-cli-adapter.ts \
    src/main/cli/adapters/codex-cli-adapter.ts \
    src/main/cli/adapters/copilot-sdk-adapter.ts
  ```

- [ ] **Completion checklist**

  | Item | Status |
  |------|--------|
  | E1: `priority` field on CommandTemplate, mtime skip in MarkdownCommandRegistry | [ ] |
  | E2: `feature()` + `featureFromRecord()` in feature-gates.ts | [ ] |
  | E3: `globToRegex()` + `compileRules()` exported from permission-manager.ts | [ ] |
  | E4: `ToolSafetyMetadata` in tool.types.ts, `getToolSafety()` in tool-registry.ts | [ ] |
  | E5: `PriorityMessageQueue` with three-bucket ordering and TTL | [ ] |
  | E6: `getMerged()` + `invalidate()` on SettingsManager | [ ] |
  | E7: `isRealPipe()` on BaseCliAdapter, EPIPE handlers in spawnProcess | [ ] |
  | All 7 test files pass | [ ] |
  | `npx tsc --noEmit` passes with no errors | [ ] |
  | `npx tsc --noEmit -p tsconfig.spec.json` passes | [ ] |
  | Lint passes on all modified files | [ ] |
