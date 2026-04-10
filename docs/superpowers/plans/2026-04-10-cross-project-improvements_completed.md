# AI Orchestrator — Cross-Project Improvements Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt proven patterns from sibling projects (t3code, claw-code-parity, agent-orchestrator, opencode, openclaw, codex) to improve AI Orchestrator's plugin system, security, observability, orchestration, and code quality.

**Architecture:** 7 phases targeting specific subsystems. Each builds on existing infrastructure rather than creating parallel implementations. Dependency order: foundational (plugin hooks, lifecycle cleanup, feature flags, parity tests) first, then features that build on them (activity detection, observability, MCP, config layering), then optional advanced work (event sourcing).

**Tech Stack:** Angular 21 (zoneless/signals), Electron 40, TypeScript 5.9, Zod 4, better-sqlite3, Vitest

**Revision Notes (v2):** Incorporates feedback from architecture and implementation reviews. Key changes:
- Plugin SDK merged into existing `packages/sdk` (no new package)
- Phase 3 extends existing `McpManager` instead of building from scratch
- Task 4.1 (permission rules) removed — existing `PermissionManager` already covers this
- Task 2.1 enhances existing `InstanceStateMachine` instead of duplicating
- Task 2.4 integrates with existing `HibernationManager` instead of extracting a duplicate
- Parity tests moved to Phase 1; feature flags moved to Phase 2
- Event sourcing demoted to Phase 7 (optional)
- All new classes follow singleton + logger + `_resetForTesting()` patterns

---

## Phase 1: Plugin Hook Expansion + Parity Tests

**Source projects:** openclaw (plugin-first architecture), opencode (15+ hook points), claw-code-parity (deterministic parity tests)

**Rationale:** Expand the existing 6-hook plugin system with new hook points across core subsystems. Add deterministic parity tests that validate orchestration flows before any refactoring.

---

### Task 1.1: Expand Hook Types in Existing SDK

**Files:**
- Modify: `packages/sdk/src/plugins.ts`
- Modify: `src/shared/types/plugin.types.ts`
- Test: `packages/sdk/src/__tests__/sdk-exports.spec.ts`

- [ ] **Step 1: Write the failing test for new hook events**

```typescript
// packages/sdk/src/__tests__/sdk-exports.spec.ts — add to existing file
import { describe, it, expect } from 'vitest';
import type { PluginHookPayloads } from '../plugins';

describe('plugin hook types', () => {
  it('includes all expanded hook events', () => {
    // Type-level test: these must compile without error
    const payloads: Record<keyof PluginHookPayloads, true> = {
      'instance.created': true,
      'instance.removed': true,
      'instance.output': true,
      'instance.stateChanged': true,
      'verification.started': true,
      'verification.completed': true,
      'verification.error': true,
      'orchestration.debate.round': true,
      'orchestration.consensus.vote': true,
      'tool.execute.before': true,
      'tool.execute.after': true,
      'session.created': true,
      'session.resumed': true,
      'session.compacting': true,
      'permission.ask': true,
      'config.loaded': true,
    };
    expect(Object.keys(payloads)).toHaveLength(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sdk/src/__tests__/sdk-exports.spec.ts`
Expected: FAIL — missing keys in PluginHookPayloads

- [ ] **Step 3: Add new hook payload types to SDK**

Add to `packages/sdk/src/plugins.ts`, extending the existing `PluginHookPayloads`:

```typescript
// Add these to the existing PluginHookPayloads interface
export interface PluginHookPayloads {
  // --- existing hooks (keep as-is) ---
  'instance.created': PluginRecord & { id: string; instanceId: string; workingDirectory: string; provider?: string };
  'instance.removed': { instanceId: string };
  'instance.output': { instanceId: string; message: OutputMessage };
  'verification.started': PluginRecord & { id: string; verificationId: string; instanceId: string };
  'verification.completed': PluginRecord & { id: string; verificationId: string; instanceId: string; fromCache?: boolean };
  'verification.error': { request: PluginRecord & { id?: string; instanceId?: string }; error: unknown; verificationId: string; instanceId: string };

  // --- new hooks ---
  'instance.stateChanged': { instanceId: string; previousState: string; newState: string; timestamp: number };
  'orchestration.debate.round': { debateId: string; round: number; totalRounds: number; participantId: string; response: string };
  'orchestration.consensus.vote': { consensusId: string; voterId: string; vote: string; confidence: number };
  'tool.execute.before': { instanceId: string; toolName: string; args: Record<string, unknown>; skip?: boolean };
  'tool.execute.after': { instanceId: string; toolName: string; args: Record<string, unknown>; result: unknown; durationMs: number };
  'session.created': { instanceId: string; sessionId: string };
  'session.resumed': { instanceId: string; sessionId: string };
  'session.compacting': { instanceId: string; messageCount: number; tokenCount: number };
  'permission.ask': { instanceId: string; toolName: string; command?: string; decision?: 'allow' | 'deny' | undefined };
  'config.loaded': { config: Record<string, unknown> };
}
```

- [ ] **Step 4: Mirror the new types in shared/types/plugin.types.ts**

Update `src/shared/types/plugin.types.ts` to keep it in sync with the SDK export (both files define the same `PluginHookPayloads`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/sdk/src/__tests__/sdk-exports.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/plugins.ts src/shared/types/plugin.types.ts packages/sdk/src/__tests__/sdk-exports.spec.ts
git commit -m "feat: expand plugin hook types to 16 events (tool, session, permission, orchestration)"
```

---

### Task 1.2: Add Manifest-Based Plugin Loading

**Files:**
- Modify: `src/main/plugins/plugin-manager.ts`
- Test: `src/main/plugins/plugin-manager.spec.ts`

- [ ] **Step 1: Write failing test for manifest-based loading**

```typescript
// Add to plugin-manager.spec.ts
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { OrchestratorPluginManager } from '../plugin-manager';

describe('manifest-based plugin loading', () => {
  const tmpDir = path.join(os.tmpdir(), `plugin-test-${Date.now()}`);
  const pluginDir = path.join(tmpDir, 'test-plugin');

  beforeAll(() => {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin',
      hooks: ['instance.created'],
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), `
      module.exports = (ctx) => ({
        'instance.created': (payload) => {}
      });
    `);
  });

  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('reads plugin.json manifest during scan', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const result = await manager.listPlugins(tmpDir, {} as any);
    const plugin = result.plugins.find(p => p.manifest?.name === 'test-plugin');
    expect(plugin).toBeDefined();
    expect(plugin!.manifest!.version).toBe('1.0.0');
    expect(plugin!.manifest!.hooks).toContain('instance.created');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/plugin-manager.spec.ts`
Expected: FAIL — `manifest` property does not exist

- [ ] **Step 3: Add manifest reading to listPlugins scan**

In `src/main/plugins/plugin-manager.ts`, modify the scan loop within `loadToolsForWorkingDirectory` (the private method that scans plugin directories):

```typescript
// After loading the JS module, check for plugin.json in the same directory
const manifestPath = path.join(path.dirname(filePath), 'plugin.json');
let manifest: PluginManifest | undefined;
if (fs.existsSync(manifestPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest = { name: raw.name, version: raw.version, description: raw.description, hooks: raw.hooks };
  } catch {
    // Invalid manifest — proceed without it
  }
}
// Attach manifest to the returned plugin info
```

Add `PluginManifest` interface to the file:
```typescript
interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  hooks?: string[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/plugin-manager.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/plugin-manager.ts src/main/plugins/plugin-manager.spec.ts
git commit -m "feat: plugin manager reads plugin.json manifests during scan"
```

---

### Task 1.3: Wire New Hook Events into Core Systems

**Files:**
- Modify: `src/main/plugins/plugin-manager.ts` (add public `emit` method with error boundary)
- Modify: `src/main/instance/instance-lifecycle.ts` (emit stateChanged)
- Modify: `src/main/orchestration/debate-coordinator.ts` (emit debate.round)
- Modify: `src/main/orchestration/consensus-coordinator.ts` (emit consensus.vote)
- Modify: `src/main/session/session-continuity.ts` (emit session events)
- Test: `src/main/plugins/__tests__/hook-wiring.spec.ts`

**IMPORTANT:** The existing `emitToPlugins` is private with 4 params: `(workingDirectory, ctx, event, payload)`. External callers can't use it. We need a new public method.

- [ ] **Step 1: Write failing test for public emit method with error boundary**

```typescript
// src/main/plugins/__tests__/hook-wiring.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorPluginManager } from '../plugin-manager';

describe('plugin hook wiring', () => {
  beforeEach(() => {
    OrchestratorPluginManager._resetForTesting();
  });

  it('exposes a public emitHook method', () => {
    const manager = OrchestratorPluginManager.getInstance();
    expect(typeof manager.emitHook).toBe('function');
  });

  it('emitHook wraps errors from misbehaving plugins', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    // Should not throw even if a plugin hook throws
    await expect(
      manager.emitHook('instance.stateChanged', {
        instanceId: 'test-1',
        previousState: 'idle',
        newState: 'busy',
        timestamp: Date.now(),
      })
    ).resolves.not.toThrow();
  });

  it('emitHook times out after 5 seconds', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    // Register a hook that hangs — emitHook should not block forever
    const start = Date.now();
    await manager.emitHook('instance.stateChanged', {
      instanceId: 'test-1',
      previousState: 'idle',
      newState: 'busy',
      timestamp: Date.now(),
    });
    // Should return within timeout, not hang
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/plugins/__tests__/hook-wiring.spec.ts`
Expected: FAIL — `emitHook` does not exist

- [ ] **Step 3: Add public emitHook method with error boundary and timeout**

Add to `OrchestratorPluginManager`:

```typescript
private static readonly HOOK_TIMEOUT_MS = 5_000;
private logger = getLogger('PluginManager');

/**
 * Public method for core subsystems to emit plugin hooks.
 * Wraps each hook call with try/catch and timeout to prevent
 * misbehaving plugins from crashing the host.
 */
async emitHook<K extends PluginHookEvent>(
  event: K,
  payload: PluginHookPayloads[K],
): Promise<void> {
  for (const [pluginPath, hooks] of this.loadedPlugins) {
    const handler = hooks[event];
    if (!handler) continue;
    try {
      const result = handler(payload as any);
      if (result instanceof Promise) {
        await Promise.race([
          result,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Plugin hook timeout: ${pluginPath}:${event}`)), OrchestratorPluginManager.HOOK_TIMEOUT_MS)
          ),
        ]);
      }
    } catch (err) {
      this.logger.warn(`Plugin hook error [${pluginPath}:${event}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/plugins/__tests__/hook-wiring.spec.ts`
Expected: PASS

- [ ] **Step 5: Add emit calls in instance-lifecycle.ts**

In `src/main/instance/instance-lifecycle.ts`, after the existing `InstanceStateMachine.transition()` calls, add:

```typescript
const pluginManager = OrchestratorPluginManager.getInstance();
await pluginManager.emitHook('instance.stateChanged', {
  instanceId: instance.id,
  previousState: oldState,
  newState: newState,
  timestamp: Date.now(),
});
```

- [ ] **Step 6: Add emit calls in debate-coordinator.ts and consensus-coordinator.ts**

In debate coordinator, after each round response:
```typescript
await pluginManager.emitHook('orchestration.debate.round', {
  debateId, round, totalRounds, participantId, response,
});
```

In consensus coordinator, after each vote:
```typescript
await pluginManager.emitHook('orchestration.consensus.vote', {
  consensusId, voterId, vote, confidence,
});
```

- [ ] **Step 7: Add emit calls in session-continuity.ts**

After session creation and resume:
```typescript
await pluginManager.emitHook('session.created', { instanceId, sessionId });
await pluginManager.emitHook('session.resumed', { instanceId, sessionId });
```

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/plugins/ src/main/instance/instance-lifecycle.ts src/main/orchestration/debate-coordinator.ts src/main/orchestration/consensus-coordinator.ts src/main/session/session-continuity.ts
git commit -m "feat: wire 10 new plugin hook events with error boundary and 5s timeout"
```

---

### Task 1.4: Deterministic Orchestration Parity Tests

**Files:**
- Create: `src/main/orchestration/__tests__/parity/mock-adapter.ts`
- Create: `src/main/orchestration/__tests__/parity/verification-parity.spec.ts`
- Create: `src/main/orchestration/__tests__/parity/debate-parity.spec.ts`

- [ ] **Step 1: Create mock CLI adapter for deterministic responses**

```typescript
// src/main/orchestration/__tests__/parity/mock-adapter.ts
import { EventEmitter } from 'events';

export class MockCliAdapter extends EventEmitter {
  private responses: string[];
  private callIndex = 0;

  constructor(responses: string[]) {
    super();
    this.responses = responses;
  }

  async sendInput(input: string): Promise<void> {
    const response = this.responses[this.callIndex++];
    if (response === undefined) {
      throw new Error(`MockCliAdapter: no response for call ${this.callIndex - 1}, input: ${input.slice(0, 100)}`);
    }
    // Simulate streaming output
    this.emit('output', { type: 'assistant', content: response });
  }

  getNextResponse(): string | undefined {
    return this.responses[this.callIndex];
  }

  get callCount(): number {
    return this.callIndex;
  }
}
```

- [ ] **Step 2: Run to verify file creates cleanly**

Run: `npx tsc --noEmit src/main/orchestration/__tests__/parity/mock-adapter.ts`
Expected: No errors

- [ ] **Step 3: Write verification parity tests**

```typescript
// src/main/orchestration/__tests__/parity/verification-parity.spec.ts
import { describe, it, expect } from 'vitest';
import { MockCliAdapter } from './mock-adapter';

describe('verification parity', () => {
  it('scenario: 3-agent unanimous agreement', async () => {
    const adapters = [
      new MockCliAdapter(['The code is safe and follows best practices. Confidence: 9/10.']),
      new MockCliAdapter(['Code analysis shows no vulnerabilities. Confidence: 8/10.']),
      new MockCliAdapter(['Safe to proceed. All checks pass. Confidence: 9/10.']),
    ];

    // All 3 agents agree → consensus should be true
    const responses = adapters.map((a, i) => {
      const content = a.getNextResponse()!;
      return { agentId: `agent-${i}`, response: content };
    });

    expect(responses).toHaveLength(3);
    expect(responses.every(r => r.response.includes('safe') || r.response.includes('Safe'))).toBe(true);
  });

  it('scenario: 3-agent disagreement', async () => {
    const adapters = [
      new MockCliAdapter(['The code is safe.']),
      new MockCliAdapter(['CRITICAL: SQL injection vulnerability found in query builder.']),
      new MockCliAdapter(['Code appears safe, no issues found.']),
    ];

    const responses = adapters.map((a, i) => ({
      agentId: `agent-${i}`,
      response: a.getNextResponse()!,
      flagsIssue: a.getNextResponse()!.includes('CRITICAL'),
    }));

    const dissenting = responses.filter(r => r.flagsIssue);
    expect(dissenting).toHaveLength(1);
    expect(dissenting[0].agentId).toBe('agent-1');
  });

  it('scenario: all agents flag issues', async () => {
    const adapters = [
      new MockCliAdapter(['WARNING: Race condition in concurrent handler.']),
      new MockCliAdapter(['ERROR: Unhandled null reference in parser.']),
      new MockCliAdapter(['CRITICAL: Authentication bypass in middleware.']),
    ];

    const responses = adapters.map(a => a.getNextResponse()!);
    expect(responses.every(r => /WARNING|ERROR|CRITICAL/.test(r))).toBe(true);
  });
});
```

- [ ] **Step 4: Write debate parity tests**

```typescript
// src/main/orchestration/__tests__/parity/debate-parity.spec.ts
import { describe, it, expect } from 'vitest';
import { MockCliAdapter } from './mock-adapter';

describe('debate parity', () => {
  it('scenario: 4-round debate with synthesis', () => {
    // Round 1: Independent responses
    const round1 = [
      { participant: 'agent-A', response: 'We should use microservices for scalability.' },
      { participant: 'agent-B', response: 'A monolith is simpler and sufficient for our scale.' },
    ];

    // Round 2: Critiques
    const round2 = [
      { participant: 'agent-A', response: 'The monolith approach risks coupling. Microservices enable independent deployment.' },
      { participant: 'agent-B', response: 'Microservices add operational complexity. Network latency between services is a real cost.' },
    ];

    // Round 3: Defenses
    const round3 = [
      { participant: 'agent-A', response: 'Valid point on ops complexity. Service mesh handles most concerns. The scaling benefit outweighs.' },
      { participant: 'agent-B', response: 'Acknowledged on coupling risk. Modular monolith with clear boundaries addresses this without the network overhead.' },
    ];

    // Round 4: Synthesis
    const synthesis = 'Recommendation: Start with a modular monolith with clear service boundaries. Plan for extraction to microservices when specific modules need independent scaling. This balances simplicity with future flexibility.';

    // Validate debate structure
    expect(round1).toHaveLength(2);
    expect(round2).toHaveLength(2);
    expect(round3).toHaveLength(2);
    expect(synthesis).toContain('modular monolith');

    // Validate round progression (each round references previous)
    expect(round2[0].response).toContain('monolith'); // References opponent
    expect(round3[0].response).toContain('ops complexity'); // Acknowledges critique
    expect(round3[1].response).toContain('coupling'); // Acknowledges critique
  });
});
```

- [ ] **Step 5: Run parity tests**

Run: `npx vitest run src/main/orchestration/__tests__/parity/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/__tests__/parity/
git commit -m "test: deterministic parity tests for verification and debate flows"
```

---

## Phase 2: Feature Flags + Instance Lifecycle Decomposition

**Source projects:** codex (feature flags), t3code (decider/projector/engine separation)

---

### Task 2.1: Runtime Feature Flag Evaluator

**Files:**
- Modify: `src/shared/constants/feature-flags.ts`
- Create: `src/main/util/feature-flag-evaluator.ts`
- Test: `src/main/util/__tests__/feature-flag-evaluator.spec.ts`

The existing `feature-flags.ts` has `ORCHESTRATION_FEATURES` const and `isFeatureEnabled()` with env var overrides. We extend this with runtime evaluation, percentage rollout, and persistence.

- [ ] **Step 1: Write failing test**

```typescript
// src/main/util/__tests__/feature-flag-evaluator.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlagEvaluator } from '../feature-flag-evaluator';

describe('FeatureFlagEvaluator', () => {
  let evaluator: FeatureFlagEvaluator;

  beforeEach(() => {
    FeatureFlagEvaluator._resetForTesting();
    evaluator = FeatureFlagEvaluator.getInstance();
  });

  it('evaluates flags from runtime overrides', () => {
    evaluator.setFlag('mcp.enabled', true);
    expect(evaluator.isEnabled('mcp.enabled')).toBe(true);
    evaluator.setFlag('mcp.enabled', false);
    expect(evaluator.isEnabled('mcp.enabled')).toBe(false);
  });

  it('falls back to ORCHESTRATION_FEATURES for known flags', () => {
    // DEBATE_SYSTEM is true in the constant
    expect(evaluator.isEnabled('DEBATE_SYSTEM')).toBe(true);
  });

  it('returns false for completely unknown flags', () => {
    expect(evaluator.isEnabled('nonexistent.flag')).toBe(false);
  });

  it('supports percentage rollout with deterministic seed', () => {
    evaluator.setFlag('experimental.feature', { enabled: true, rolloutPercent: 50 });
    const result1 = evaluator.isEnabled('experimental.feature', 'user-1');
    const result2 = evaluator.isEnabled('experimental.feature', 'user-1');
    expect(result1).toBe(result2); // Deterministic
  });

  it('persists flags to disk and reloads', () => {
    evaluator.setFlag('test.persist', true);
    evaluator.save();

    FeatureFlagEvaluator._resetForTesting();
    const reloaded = FeatureFlagEvaluator.getInstance();
    expect(reloaded.isEnabled('test.persist')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/util/__tests__/feature-flag-evaluator.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement FeatureFlagEvaluator**

```typescript
// src/main/util/feature-flag-evaluator.ts
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { ORCHESTRATION_FEATURES, type FeatureFlag } from '@shared/constants/feature-flags';
import { getLogger } from '../logger'; // or wherever the logger lives

const logger = getLogger('FeatureFlagEvaluator');

type FlagValue = boolean | { enabled: boolean; rolloutPercent: number };

export class FeatureFlagEvaluator {
  private static instance: FeatureFlagEvaluator | null = null;
  private flags = new Map<string, FlagValue>();
  private persistPath: string;

  private constructor() {
    this.persistPath = path.join(app.getPath('userData'), 'feature-flags.json');
    this.load();
  }

  static getInstance(): FeatureFlagEvaluator {
    if (!this.instance) this.instance = new FeatureFlagEvaluator();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  isEnabled(flag: string, seed?: string): boolean {
    // 1. Check runtime overrides
    const override = this.flags.get(flag);
    if (override !== undefined) {
      if (typeof override === 'boolean') return override;
      if (!override.enabled) return false;
      if (override.rolloutPercent >= 100) return true;
      if (override.rolloutPercent <= 0) return false;
      // Deterministic hash-based rollout
      const hash = createHash('sha256').update(`${flag}:${seed ?? 'default'}`).digest();
      const bucket = hash.readUInt16BE(0) % 100;
      return bucket < override.rolloutPercent;
    }

    // 2. Check env var: ORCH_FEATURE_<FLAG>=true|false
    const envKey = `ORCH_FEATURE_${flag.replace(/\./g, '_').toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal === 'true') return true;
    if (envVal === 'false') return false;

    // 3. Check compile-time constants
    if (flag in ORCHESTRATION_FEATURES) {
      return ORCHESTRATION_FEATURES[flag as FeatureFlag];
    }

    return false;
  }

  setFlag(flag: string, value: FlagValue): void {
    this.flags.set(flag, value);
  }

  removeFlag(flag: string): void {
    this.flags.delete(flag);
  }

  getAllFlags(): Record<string, FlagValue> {
    return Object.fromEntries(this.flags);
  }

  save(): void {
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(Object.fromEntries(this.flags), null, 2));
    } catch (err) {
      logger.warn(`Failed to save feature flags: ${err}`);
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
          this.flags.set(k, v as FlagValue);
        }
      }
    } catch {
      // Start fresh
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/util/__tests__/feature-flag-evaluator.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/util/feature-flag-evaluator.ts src/main/util/__tests__/feature-flag-evaluator.spec.ts
git commit -m "feat: runtime feature flag evaluator with percentage rollout and persistence"
```

---

### Task 2.2: Extract Instance Spawner from Lifecycle

**Files:**
- Create: `src/main/instance/lifecycle/instance-spawner.ts`
- Modify: `src/main/instance/instance-lifecycle.ts` (delegate to spawner)
- Test: `src/main/instance/lifecycle/__tests__/instance-spawner.spec.ts`

Extracts ~400 lines of CLI process spawning logic from `instance-lifecycle.ts`: adapter creation, environment setup, CLAUDE.md loading, and process launch.

- [ ] **Step 1: Write failing test**

```typescript
// src/main/instance/lifecycle/__tests__/instance-spawner.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstanceSpawner } from '../instance-spawner';

describe('InstanceSpawner', () => {
  it('creates an adapter and launches process', async () => {
    const mockAdapterFactory = vi.fn().mockResolvedValue({
      spawn: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      pid: 12345,
    });

    const spawner = new InstanceSpawner({ createAdapter: mockAdapterFactory });
    const result = await spawner.spawn({
      instanceId: 'test-1',
      workingDirectory: '/tmp/test',
      provider: 'claude-cli',
      model: 'claude-sonnet-4-6',
    });

    expect(mockAdapterFactory).toHaveBeenCalledOnce();
    expect(result.adapter).toBeDefined();
    expect(result.pid).toBe(12345);
  });

  it('loads CLAUDE.md instructions when present', async () => {
    const spawner = new InstanceSpawner({
      createAdapter: vi.fn().mockResolvedValue({ spawn: vi.fn(), on: vi.fn(), pid: 1 }),
      loadInstructions: vi.fn().mockResolvedValue('# Instructions\nBe helpful.'),
    });

    const result = await spawner.spawn({
      instanceId: 'test-2',
      workingDirectory: '/tmp/test',
      provider: 'claude-cli',
    });

    expect(spawner['deps'].loadInstructions).toHaveBeenCalledWith('/tmp/test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/instance-spawner.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement InstanceSpawner**

Extract the adapter creation and process launch logic from `instance-lifecycle.ts` into a focused class:

```typescript
// src/main/instance/lifecycle/instance-spawner.ts
import { getLogger } from '../../logger';

const logger = getLogger('InstanceSpawner');

export interface SpawnerDeps {
  createAdapter: (config: SpawnConfig) => Promise<CliAdapter>;
  loadInstructions?: (workingDirectory: string) => Promise<string | null>;
}

export interface SpawnConfig {
  instanceId: string;
  workingDirectory: string;
  provider: string;
  model?: string;
  sessionId?: string;
  resumeSessionId?: string;
  env?: Record<string, string>;
  yoloMode?: boolean;
}

export interface SpawnResult {
  adapter: CliAdapter;
  pid: number;
  sessionId?: string;
}

interface CliAdapter {
  spawn: (args: unknown) => Promise<void>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  pid: number;
}

export class InstanceSpawner {
  private deps: SpawnerDeps;

  constructor(deps: SpawnerDeps) {
    this.deps = deps;
  }

  async spawn(config: SpawnConfig): Promise<SpawnResult> {
    logger.info(`Spawning instance ${config.instanceId} with provider ${config.provider}`);

    // Load instructions if available
    let instructions: string | null = null;
    if (this.deps.loadInstructions) {
      instructions = await this.deps.loadInstructions(config.workingDirectory);
    }

    // Create the CLI adapter
    const adapter = await this.deps.createAdapter(config);

    // Launch the process
    await adapter.spawn({
      workingDirectory: config.workingDirectory,
      model: config.model,
      sessionId: config.sessionId,
      resumeSessionId: config.resumeSessionId,
      env: config.env,
      yoloMode: config.yoloMode,
      instructions,
    });

    return {
      adapter,
      pid: adapter.pid,
      sessionId: config.sessionId,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/instance-spawner.spec.ts`
Expected: PASS

- [ ] **Step 5: Wire InstanceSpawner into instance-lifecycle.ts**

In `instance-lifecycle.ts`, replace inline adapter creation with delegation:
```typescript
import { InstanceSpawner } from './lifecycle/instance-spawner';
// In constructor:
this.spawner = new InstanceSpawner({
  createAdapter: (config) => this.deps.createAdapter(config),
  loadInstructions: (dir) => this.deps.loadInstructions(dir),
});
// Replace inline spawn logic with: await this.spawner.spawn(config)
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run src/main/instance/`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/lifecycle/ src/main/instance/instance-lifecycle.ts
git commit -m "refactor: extract CLI spawning to lifecycle/instance-spawner.ts"
```

---

### Task 2.3: Extract Session Recovery Module

**Files:**
- Create: `src/main/instance/lifecycle/session-recovery.ts`
- Test: `src/main/instance/lifecycle/__tests__/session-recovery.spec.ts`

Extracts ~300 lines: resume logic, replay continuity, fallback history, recovery recipe integration.

- [ ] **Step 1: Write failing test for two-phase recovery**

```typescript
// src/main/instance/lifecycle/__tests__/session-recovery.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { SessionRecoveryHandler } from '../session-recovery';

describe('SessionRecoveryHandler', () => {
  it('tries native resume first', async () => {
    const nativeResume = vi.fn().mockResolvedValue({ success: true });
    const replayFallback = vi.fn();

    const handler = new SessionRecoveryHandler({
      nativeResume,
      replayFallback,
    });

    await handler.recover('instance-1', 'session-abc');
    expect(nativeResume).toHaveBeenCalledWith('instance-1', 'session-abc');
    expect(replayFallback).not.toHaveBeenCalled();
  });

  it('falls back to replay when native resume fails', async () => {
    const nativeResume = vi.fn().mockResolvedValue({ success: false, error: 'Session not found' });
    const replayFallback = vi.fn().mockResolvedValue({ success: true });

    const handler = new SessionRecoveryHandler({
      nativeResume,
      replayFallback,
    });

    await handler.recover('instance-1', 'session-abc');
    expect(nativeResume).toHaveBeenCalled();
    expect(replayFallback).toHaveBeenCalledWith('instance-1', 'session-abc');
  });

  it('returns failure when both phases fail', async () => {
    const handler = new SessionRecoveryHandler({
      nativeResume: vi.fn().mockResolvedValue({ success: false }),
      replayFallback: vi.fn().mockResolvedValue({ success: false, error: 'No history' }),
    });

    const result = await handler.recover('instance-1', 'session-abc');
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Steps 2-7:** Implement, test, wire into lifecycle, run full suite, commit.

```bash
git commit -m "refactor: extract session recovery to lifecycle/session-recovery.ts"
```

---

## Phase 3: Activity Detection Cascade + OpenTelemetry

**Source projects:** agent-orchestrator (4-step cascade), codex (OpenTelemetry)

---

### Task 3.1: Enhance ActivityStateDetector with 4-Step Cascade

**Files:**
- Modify: `src/main/providers/activity-state-detector.ts`
- Test: `src/main/providers/__tests__/activity-state-detector.spec.ts`

The existing `ActivityStateDetector` already has a 3-step cascade (JSONL log → age decay → process check). We enhance it by adding the 4th step (native CLI signal via session API) and improving the age-based decay thresholds.

- [ ] **Step 1: Write failing test for native signal step**

```typescript
// src/main/providers/__tests__/activity-state-detector.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityStateDetector } from '../activity-state-detector';

describe('ActivityStateDetector enhanced cascade', () => {
  it('checks native CLI signal when JSONL has no actionable state', async () => {
    const detector = new ActivityStateDetector('test-1', '/tmp/work', 'claude-cli');
    // Mock: JSONL returns nothing actionable
    vi.spyOn(detector as any, 'detectFromActivityLog').mockResolvedValue(null);
    // Mock: Native signal returns active
    vi.spyOn(detector as any, 'detectFromNativeSignal').mockResolvedValue({
      state: 'active',
      confidence: 'high',
      source: 'native-cli',
    });

    const result = await detector.detect();
    expect(result.state).toBe('active');
    expect(result.source).toBe('native-cli');
  });

  it('falls back to age decay when native signal unavailable', async () => {
    const detector = new ActivityStateDetector('test-1', '/tmp/work', 'claude-cli');
    vi.spyOn(detector as any, 'detectFromActivityLog').mockResolvedValue(null);
    vi.spyOn(detector as any, 'detectFromNativeSignal').mockResolvedValue(null);
    // Last output 2 minutes ago → should be 'ready'
    vi.spyOn(detector as any, 'detectFromAgeDecay').mockResolvedValue({
      state: 'ready',
      confidence: 'low',
      source: 'age-decay',
    });

    const result = await detector.detect();
    expect(result.state).toBe('ready');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers/__tests__/activity-state-detector.spec.ts`
Expected: FAIL — `detectFromNativeSignal` does not exist

- [ ] **Step 3: Add native signal detection to ActivityStateDetector**

Add a new private method `detectFromNativeSignal()` that queries the CLI adapter's session list/status API:

```typescript
/**
 * Level 2.5: Query the CLI adapter's native status API.
 * Claude CLI: `claude sessions list --json`
 * Codex: reads thread status from native JSONL
 */
private async detectFromNativeSignal(): Promise<ActivityDetectionResult | null> {
  try {
    // Check if adapter exposes a getSessionStatus method
    if (!this.adapter?.getSessionStatus) return null;
    const status = await this.adapter.getSessionStatus(this.instanceId);
    if (!status) return null;
    return {
      state: this.mapNativeStatus(status),
      confidence: 'high',
      source: 'native-cli',
    };
  } catch {
    return null;
  }
}

private mapNativeStatus(status: string): ActivityState {
  switch (status) {
    case 'running': case 'streaming': return 'active';
    case 'waiting': case 'idle': return 'ready';
    case 'blocked': case 'permission': return 'waiting_input';
    default: return 'ready';
  }
}
```

Update `detect()` to insert this between JSONL log and age decay in the cascade.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers/__tests__/activity-state-detector.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/activity-state-detector.ts src/main/providers/__tests__/activity-state-detector.spec.ts
git commit -m "feat: add native CLI signal detection to activity state cascade"
```

---

### Task 3.2: OpenTelemetry Integration

**Files:**
- Create: `src/main/observability/otel-setup.ts`
- Create: `src/main/observability/otel-spans.ts`
- Modify: `src/main/index.ts` (initialize tracer)
- Test: `src/main/observability/__tests__/otel-spans.spec.ts`

- [ ] **Step 1: Install dependencies**

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions
```

- [ ] **Step 2: Write failing test**

```typescript
// src/main/observability/__tests__/otel-spans.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-node';
import { traceVerification, traceDebate, traceInstanceLifecycle } from '../otel-spans';

describe('otel-spans', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(() => exporter.reset());

  it('creates span for verification', async () => {
    await traceVerification('v-1', { query: 'Is this safe?', agentCount: 3 }, async () => {
      // simulate work
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('orchestration.verification');
    expect(spans[0].attributes['verification.id']).toBe('v-1');
    expect(spans[0].attributes['verification.agent_count']).toBe(3);
  });

  it('creates span for debate', async () => {
    await traceDebate('d-1', { topic: 'Architecture', rounds: 4 }, async () => {});
    const spans = exporter.getFinishedSpans();
    expect(spans[0].name).toBe('orchestration.debate');
    expect(spans[0].attributes['debate.rounds']).toBe(4);
  });

  it('creates span for instance lifecycle', async () => {
    await traceInstanceLifecycle('create', 'inst-1', async () => {});
    const spans = exporter.getFinishedSpans();
    expect(spans[0].name).toBe('instance.create');
    expect(spans[0].attributes['instance.id']).toBe('inst-1');
  });
});
```

- [ ] **Steps 3-7:** Implement tracer setup (gated behind `FeatureFlagEvaluator.isEnabled('otel.enabled')`), span helper functions, wire into `index.ts`. Commit.

```bash
git commit -m "feat: OpenTelemetry tracing for orchestration and instance lifecycle"
```

---

## Phase 4: MCP Integration (Extend Existing McpManager)

**Source projects:** codex (bidirectional MCP), opencode (multi-transport + OAuth)

**IMPORTANT:** Extends the existing `McpManager` at `src/main/mcp/mcp-manager.ts` — does NOT create a parallel system. All new work is gated behind `FeatureFlagEvaluator.isEnabled('mcp.sse_transport')` and `mcp.server_mode`.

---

### Task 4.1: Add SSE Transport to McpManager

**Files:**
- Modify: `src/main/mcp/mcp-manager.ts` (add `connectSse` method)
- Create: `src/main/mcp/transports/sse-transport.ts`
- Test: `src/main/mcp/__tests__/sse-transport.spec.ts`

The existing `McpManager` only supports stdio transport. Add SSE transport following the same JSON-RPC protocol.

- [ ] **Step 1: Write failing test for SSE transport**
- [ ] **Steps 2-5:** Implement SSE transport, integrate into McpManager's `connect()` method (switch on `config.transport`), test, commit.

```bash
git commit -m "feat: SSE transport for MCP server connections"
```

---

### Task 4.2: MCP Tool Bridge — Register MCP Tools in ToolRegistry

**Files:**
- Create: `src/main/mcp/mcp-tool-bridge.ts`
- Test: `src/main/mcp/__tests__/mcp-tool-bridge.spec.ts`

Bridges MCP server tools into the existing `ToolRegistry` with qualified names (`mcp__<server>__<tool>`). Handles the JSON Schema → Zod schema gap.

- [ ] **Step 1: Write failing test**

```typescript
// src/main/mcp/__tests__/mcp-tool-bridge.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpToolBridge } from '../mcp-tool-bridge';

describe('McpToolBridge', () => {
  it('registers MCP tools with qualified names', () => {
    const bridge = McpToolBridge.getInstance();
    bridge.registerServerTools('my-db', [
      { name: 'query', description: 'Run a SQL query', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } },
    ]);

    const tools = bridge.getRegisteredTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe('mcp__my-db__query');
    expect(tools[0].description).toContain('Run a SQL query');
  });

  it('routes tool execution through McpManager.callTool', async () => {
    const mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });
    const bridge = McpToolBridge.getInstance();
    bridge.setCallToolFn(mockCallTool);
    bridge.registerServerTools('my-db', [
      { name: 'query', description: 'SQL', inputSchema: { type: 'object' } },
    ]);

    const result = await bridge.executeTool('mcp__my-db__query', { sql: 'SELECT 1' });
    expect(mockCallTool).toHaveBeenCalledWith({ serverId: 'my-db', toolName: 'query', args: { sql: 'SELECT 1' } });
  });
});
```

- [ ] **Steps 2-7:** Implement bridge with JSON-Schema-to-Zod adapter for validation, singleton pattern, logger, `_resetForTesting()`. Wire into McpManager's `tools:updated` event. Commit.

```bash
git commit -m "feat: MCP tool bridge registers server tools with qualified names"
```

---

### Task 4.3: MCP Server Mode — Expose Orchestration as MCP Tools

**Files:**
- Create: `src/main/mcp/mcp-server.ts`
- Create: `src/main/mcp/mcp-server-tools.ts`
- Test: `src/main/mcp/__tests__/mcp-server.spec.ts`

Exposes AI Orchestrator as an MCP server that external agents can invoke.

Exposed tools: `orchestrator.spawn_instance`, `orchestrator.verify`, `orchestrator.debate`, `orchestrator.consensus`, `orchestrator.list_instances`.

- [ ] **Steps 1-7:** Implement, test, commit. Gate behind `mcp.server_mode` feature flag.

```bash
git commit -m "feat: MCP server mode exposes orchestration capabilities as tools"
```

---

### Task 4.4: MCP IPC Handlers and UI

**Files:**
- Create: `src/main/ipc/handlers/mcp-handlers.ts`
- Modify: `src/preload/domains/mcp.preload.ts` (if exists, or add to infrastructure domain)
- Modify: `src/renderer/app/features/mcp/mcp-page.component.ts`
- Create: `src/renderer/app/core/state/mcp.store.ts`
- Modify: `src/shared/types/mcp.types.ts` (move types here per convention)

- [ ] **Steps 1-7:** Wire MCP management through IPC, add Zod schemas per convention in `src/shared/validation/`, implement store and UI page.

```bash
git commit -m "feat: MCP management UI with connect/disconnect/tool-listing"
```

---

## Phase 5: Config Layering

**Source projects:** claw-code-parity (3-level config), codex (TOML layering)

---

### Task 5.1: Three-Level Config Layering

**Files:**
- Create: `src/main/core/config/config-layers.ts`
- Modify: `src/main/core/config/settings-manager.ts`
- Test: `src/main/core/config/__tests__/config-layers.spec.ts`

Implement User > Project > System config precedence. Reads from:
1. System defaults (hardcoded)
2. Project: `<cwd>/.orchestrator/config.json`
3. User: `~/.orchestrator/config.json`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { mergeConfigLayers, discoverConfigFiles } from '../config-layers';

describe('config-layers', () => {
  it('project overrides system', () => {
    const merged = mergeConfigLayers({
      system: { theme: 'light', maxInstances: 10 },
      project: { maxInstances: 5 },
      user: {},
    });
    expect(merged.maxInstances).toBe(5);
    expect(merged.theme).toBe('light');
  });

  it('user overrides project', () => {
    const merged = mergeConfigLayers({
      system: { theme: 'light' },
      project: { theme: 'dark' },
      user: { theme: 'solarized' },
    });
    expect(merged.theme).toBe('solarized');
  });

  it('deep merges nested objects', () => {
    const merged = mergeConfigLayers({
      system: { providers: { claude: { enabled: true, model: 'sonnet' } } },
      project: { providers: { claude: { model: 'opus' } } },
      user: {},
    });
    expect(merged.providers.claude.enabled).toBe(true);
    expect(merged.providers.claude.model).toBe('opus');
  });
});
```

- [ ] **Steps 2-7:** Implement `mergeConfigLayers()` (deep merge with user > project > system), `discoverConfigFiles()` (finds config.json in standard paths), integrate with `SettingsManager`. Commit.

```bash
git commit -m "feat: three-level config layering (system < project < user)"
```

---

## Phase 6: Plugin Manifest Validation (Optional Enhancement)

**Source project:** openclaw (manifest-driven discovery with JSON Schema config)

---

### Task 6.1: Plugin Config Schema Validation

**Files:**
- Modify: `packages/sdk/src/plugins.ts` (add manifest + config schema types)
- Modify: `src/main/plugins/plugin-manager.ts` (validate config on load)
- Test: `src/main/plugins/__tests__/manifest-validation.spec.ts`

- [ ] **Steps 1-7:** Add `PluginManifestSchema` to SDK, validate manifests on load, reject invalid plugins with clear error messages.

```bash
git commit -m "feat: validate plugin manifests and config schemas on load"
```

---

## Phase 7: Event Sourcing for Orchestration (Optional)

**Source project:** t3code (event store + projector + snapshot pattern)

**Rationale:** Only implement if there's a concrete need for orchestration replay/debugging. Uses the existing `better-sqlite3` database connection — no separate DB.

---

### Task 7.1: Orchestration Event Store

**Files:**
- Create: `src/main/orchestration/event-store/orchestration-event-store.ts`
- Create: `src/main/orchestration/event-store/orchestration-events.ts`
- Create: `src/main/orchestration/event-store/orchestration-projector.ts`
- Test: `src/main/orchestration/event-store/__tests__/event-store.spec.ts`

Append-only event table in the existing SQLite database. Projector builds read models from events.

- [ ] **Steps 1-7:** Create events table schema, implement append + replay, projector, test. Gate behind `event_sourcing.enabled` feature flag.

```bash
git commit -m "feat: orchestration event store with SQLite append-only log and projector"
```

### Task 7.2: Wire Coordinators + Replay UI

- [ ] **Steps 1-7:** Add `eventStore.append()` to coordinators, IPC handler for event query, timeline UI in replay page.

```bash
git commit -m "feat: orchestration event replay with coordinator integration and timeline UI"
```

---

## Dependency Graph

```
Phase 1 (Plugin Hooks + Parity Tests)
   │
   ├──→ Phase 2 (Feature Flags + Lifecycle Decomposition)
   │       │
   │       ├──→ Phase 3 (Activity Detection + OpenTelemetry)
   │       │
   │       └──→ Phase 4 (MCP — behind feature flags)
   │
   └──→ Phase 5 (Config Layering — independent)

Phase 6 (Plugin Manifests — optional, after Phase 1)
Phase 7 (Event Sourcing — optional, after Phase 2)
```

**Parallelizable:** Phases 3+5 can run in parallel. Phases 6+7 are optional and independent.

---

## Summary

| Phase | Tasks | New Files | Modified Files | Risk | Commits |
|-------|-------|-----------|----------------|------|---------|
| 1. Plugin Hooks + Parity Tests | 4 | 4 | 7 | Low | 4 |
| 2. Feature Flags + Lifecycle | 3 | 3 | 3 | Medium | 3 |
| 3. Activity Detection + OTel | 2 | 3 | 2 | Low | 2 |
| 4. MCP Integration | 4 | 6 | 4 | High | 4 |
| 5. Config Layering | 1 | 1 | 1 | Low | 1 |
| 6. Plugin Manifests (optional) | 1 | 0 | 2 | Low | 1 |
| 7. Event Sourcing (optional) | 2 | 4 | 3 | Medium | 2 |
| **Total** | **17** | **21** | **22** | — | **17** |
