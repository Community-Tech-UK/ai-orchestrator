# MCP Multi-Provider Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-server MCP page with a unified multi-provider management surface that manages MCP servers across Claude Code, Codex, Gemini, and Copilot (plus an orchestrator-only channel and a shared fan-out layer) with drift detection, health checks, and encrypted secret handling.

**Architecture:** A per-provider adapter reads/writes the native config file for that CLI (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, Copilot's `mcp.json`). A `SharedMcpRegistry` (sqlite) stores canonical shared entries and fans them out to the selected providers; `CliMcpConfigService` is the high-level orchestrator. An `OrchestratorInjectionReader` combines orchestrator + bootstrap + codemem + shared at spawn time for spawned CLI sessions. Secrets are classified, encrypted via Electron `safeStorage` where available, and redacted in IPC DTOs. All changes ship behind migrations 015/016 and three new settings keys.

**Tech Stack:** Electron 40 (Node) + Angular 21 (zoneless, signals) + TypeScript 5.9 + better-sqlite3 + Zod 4 + Vitest + `@iarna/toml` (new dep, comment-preserving) + existing contracts/preload IPC pipeline.

**Reference spec:** `docs/superpowers/specs/2026-04-21-mcp-multi-provider-management-design.md` — §N references below point into this spec.

---

## File Structure

**New shared types** (`src/shared/types/`):
- `mcp-scopes.types.ts` — `McpScope` union + scope helpers
- `mcp-orchestrator.types.ts` — orchestrator-scope records + injection types
- `mcp-shared.types.ts` — shared record + drift + target types
- `mcp-dtos.types.ts` — redacted IPC DTOs

**New contracts schemas** (`packages/contracts/src/schemas/`):
- `mcp-multi-provider.schemas.ts` — Zod schemas for all new IPC payloads

**Main-process additions** (`src/main/mcp/`):
- `secret-storage.ts` — `safeStorage` capability wrapper
- `secret-classifier.ts` — heuristic secret detection
- `redaction-service.ts` — DTO builders that strip/redact secrets
- `write-safety-helper.ts` — atomic write + backups + parent-permission guard
- `orchestrator-mcp-repository.ts` — DB CRUD for orchestrator scope
- `shared-mcp-repository.ts` — DB CRUD for shared scope
- `shared-mcp-coordinator.ts` — fan-out + drift + resolve
- `cli-mcp-config-service.ts` — high-level multi-provider orchestrator
- `fs-watcher-manager.ts` — debounced watchers with self-write suppression
- `orchestrator-injection-reader.ts` — spawn-time combined reader
- `orchestrator-mcp-repository-singleton.ts`, `shared-mcp-repository-singleton.ts`, `cli-mcp-config-service-singleton.ts`, `shared-mcp-coordinator-singleton.ts` — lazy-getter bridges used by IPC handlers
- `adapters/provider-mcp-adapter.types.ts` — shared `ProviderMcpAdapter` interface
- `adapters/claude-mcp-adapter.ts`
- `adapters/codex-mcp-adapter.ts`
- `adapters/codex-toml-editor.ts` — comment-preserving `[mcp_servers.*]` rewriter
- `adapters/gemini-mcp-adapter.ts`
- `adapters/copilot-mcp-adapter.ts`

**IPC** (extends existing `src/main/ipc/handlers/mcp-handlers.ts`):
- 14 new handlers for orchestrator/shared/provider CRUD + drift ops

**Preload** (extends existing `src/preload/preload.ts`):
- 14 new MCP methods added alongside existing `mcpAddServer` etc.
- Regenerated `src/preload/generated/channels.ts` picks up new channel keys automatically via `npm run generate:ipc`.

**Renderer** (`src/renderer/app/`):
- `features/mcp/state/mcp-multi-provider.store.ts` — signals-based store
- `features/mcp/mcp.page.component.ts` — refactored to six-tab host (Orchestrator, Shared, Claude, Codex, Gemini, Copilot)
- `features/mcp/tabs/orc-mcp-orchestrator-tab.component.ts`
- `features/mcp/tabs/orc-mcp-shared-tab.component.ts` (includes inline drift banner)
- `features/mcp/tabs/orc-mcp-provider-tab.component.ts` (parameterized — one component, four uses)
- `features/mcp/components/mcp-server-detail-panel.component.ts`
- `features/mcp/components/mcp-server-edit-form.component.ts` (shared by all three tab types)

**Tests** (colocated `__tests__/` folders next to sources; spec naming per existing convention).

---

# Phase 0 — Foundation

Bring in types, schemas, channels, DB migrations, settings, the secret-storage capability wrapper, and the Phase 0 observation test for Claude's `--mcp-config` merge semantics. **Nothing is wired to the UI yet.**

## Task 0.1: Define MCP scope + transport + orchestrator-injection types

Establishes the shared vocabulary every later task consumes.

**Files:**
- Create: `src/shared/types/mcp-scopes.types.ts`
- Create: `src/shared/types/mcp-orchestrator.types.ts`
- Test: `src/shared/types/__tests__/mcp-scopes.types.spec.ts`

- [ ] **Step 1: Write the failing test for `mcp-scopes.types.ts`**

Create `src/shared/types/__tests__/mcp-scopes.types.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  ALL_MCP_SCOPES,
  PROVIDER_SCOPES,
  WRITABLE_SCOPES_BY_PROVIDER,
  isProviderScope,
  isWritableScope,
  type McpScope,
} from '../mcp-scopes.types';

describe('mcp-scopes.types', () => {
  it('exposes all ten canonical scopes', () => {
    expect([...ALL_MCP_SCOPES].sort()).toEqual([
      'local',
      'managed',
      'orchestrator',
      'orchestrator-bootstrap',
      'orchestrator-codemem',
      'project',
      'shared',
      'system',
      'user',
      'workspace',
    ]);
  });

  it('classifies scopes by provider', () => {
    expect(PROVIDER_SCOPES.claude).toEqual(['user', 'project', 'local']);
    expect(PROVIDER_SCOPES.codex).toEqual(['user']);
    expect(PROVIDER_SCOPES.gemini).toEqual(['user']);
    expect(PROVIDER_SCOPES.copilot).toEqual(['user', 'workspace', 'managed', 'system']);
  });

  it('identifies provider-facing scopes', () => {
    expect(isProviderScope('user')).toBe(true);
    expect(isProviderScope('orchestrator')).toBe(false);
    expect(isProviderScope('shared')).toBe(false);
  });

  it('restricts writable scopes to user-writable per spec §6', () => {
    expect(WRITABLE_SCOPES_BY_PROVIDER.claude).toEqual(['user']);
    expect(WRITABLE_SCOPES_BY_PROVIDER.copilot).toEqual(['user']);
    expect(isWritableScope('claude', 'project')).toBe(false);
    expect(isWritableScope('claude', 'user')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/shared/types/__tests__/mcp-scopes.types.spec.ts`
Expected: FAIL with `Cannot find module '../mcp-scopes.types'`.

- [ ] **Step 3: Implement `mcp-scopes.types.ts`**

Create `src/shared/types/mcp-scopes.types.ts`:

```typescript
/**
 * MCP scope taxonomy — see spec §4 Data Model.
 *
 * Provider scopes are where a given CLI reads MCP from on disk.
 * Orchestrator scopes are Orchestrator-only (never fanned out).
 * Shared is a virtual scope whose entries are mirrored into one or more
 * provider-scope files via SharedMcpCoordinator.
 */

import type { CanonicalCliType } from './settings.types';

export type ProviderMcpScope =
  | 'user'
  | 'project'
  | 'local'
  | 'workspace'
  | 'managed'
  | 'system';

export type OrchestratorMcpScope =
  | 'orchestrator'
  | 'orchestrator-bootstrap'
  | 'orchestrator-codemem';

export type McpScope =
  | ProviderMcpScope
  | OrchestratorMcpScope
  | 'shared';

export const ALL_MCP_SCOPES: readonly McpScope[] = [
  'user',
  'project',
  'local',
  'workspace',
  'managed',
  'system',
  'orchestrator',
  'orchestrator-bootstrap',
  'orchestrator-codemem',
  'shared',
];

/** Which CLI providers this plan manages. */
export type SupportedProvider = Extract<CanonicalCliType, 'claude' | 'codex' | 'gemini' | 'copilot'>;

export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = [
  'claude',
  'codex',
  'gemini',
  'copilot',
];

/** Scopes each provider surfaces in its own tab. */
export const PROVIDER_SCOPES: Record<SupportedProvider, readonly ProviderMcpScope[]> = {
  claude: ['user', 'project', 'local'],
  codex: ['user'],
  gemini: ['user'],
  copilot: ['user', 'workspace', 'managed', 'system'],
};

/** Scopes Orchestrator writes to (spec §6: user-level writes only in v1). */
export const WRITABLE_SCOPES_BY_PROVIDER: Record<SupportedProvider, readonly ProviderMcpScope[]> = {
  claude: ['user'],
  codex: ['user'],
  gemini: ['user'],
  copilot: ['user'],
};

export function isProviderScope(scope: McpScope): scope is ProviderMcpScope {
  return (PROVIDER_SCOPES.claude as readonly McpScope[]).includes(scope)
    || (PROVIDER_SCOPES.copilot as readonly McpScope[]).includes(scope);
}

export function isWritableScope(
  provider: SupportedProvider,
  scope: ProviderMcpScope,
): boolean {
  return (WRITABLE_SCOPES_BY_PROVIDER[provider] as readonly ProviderMcpScope[]).includes(scope);
}
```

- [ ] **Step 4: Write `mcp-orchestrator.types.ts`**

Create `src/shared/types/mcp-orchestrator.types.ts`:

```typescript
/**
 * Orchestrator-scope MCP records. These live only in Orchestrator's own
 * sqlite DB (table `orchestrator_mcp_servers`) and are never persisted to
 * provider config files. They are injected at spawn time via
 * `OrchestratorInjectionReader` — see spec §4 + §12.
 */

import type { OrchestratorMcpScope } from './mcp-scopes.types';
import type { SupportedProvider } from './mcp-scopes.types';

export type McpTransport = 'stdio' | 'sse';

export interface OrchestratorMcpServer {
  /** Opaque ID; stable across edits. */
  id: string;
  name: string;
  description?: string;
  scope: OrchestratorMcpScope;
  transport: McpTransport;
  /** stdio: command + args; sse: url */
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Encrypted base64 payload per key when safeStorage is available. */
  envSecretsEncrypted?: Record<string, string>;
  autoConnect: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Which providers receive this server's config at spawn time (default: all). */
export interface OrchestratorInjectionTargets {
  serverId: string;
  providers: readonly SupportedProvider[];
}

/** Combined spawn-time injection result produced by OrchestratorInjectionReader. */
export interface McpInjectionBundle {
  /** Config file paths to pass via `--mcp-config` (Claude) or write into CODEX_HOME (Codex). */
  configPaths: readonly string[];
  /** Inline JSON config strings the caller may wrap / write. */
  inlineConfigs: readonly string[];
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run src/shared/types/__tests__/mcp-scopes.types.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/mcp-scopes.types.ts src/shared/types/mcp-orchestrator.types.ts src/shared/types/__tests__/mcp-scopes.types.spec.ts
git commit -m "feat(mcp): add scope taxonomy + orchestrator record types"
```

---

## Task 0.2: Define redacted DTOs + shared MCP record types

**Files:**
- Create: `src/shared/types/mcp-shared.types.ts`
- Create: `src/shared/types/mcp-dtos.types.ts`
- Test: `src/shared/types/__tests__/mcp-shared.types.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/types/__tests__/mcp-shared.types.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DRIFT_STATES, type DriftState } from '../mcp-shared.types';

describe('mcp-shared.types', () => {
  it('exposes four drift states matching spec §8', () => {
    expect(DRIFT_STATES).toEqual(['in-sync', 'drifted', 'missing', 'not-installed']);
  });

  it('is a discriminated union of drift states', () => {
    const s: DriftState = 'in-sync';
    expect(DRIFT_STATES.includes(s)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/shared/types/__tests__/mcp-shared.types.spec.ts`
Expected: FAIL with `Cannot find module '../mcp-shared.types'`.

- [ ] **Step 3: Implement `mcp-shared.types.ts`**

Create `src/shared/types/mcp-shared.types.ts`:

```typescript
/**
 * Shared MCP records + drift model. See spec §8.
 *
 * The canonical record lives in sqlite. Fan-out writes a *copy* into each
 * target provider's config file; drift is detected when a target copy diverges.
 */

import type { SupportedProvider } from './mcp-scopes.types';
import type { McpTransport } from './mcp-orchestrator.types';

export const DRIFT_STATES = ['in-sync', 'drifted', 'missing', 'not-installed'] as const;
export type DriftState = typeof DRIFT_STATES[number];

export interface SharedMcpRecord {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envSecretsEncrypted?: Record<string, string>;
  /** Targets this server fans out to. */
  targets: readonly SupportedProvider[];
  createdAt: number;
  updatedAt: number;
}

export interface SharedMcpTargetStatus {
  provider: SupportedProvider;
  state: DriftState;
  /** Non-null iff drifted — canonical string representation of the divergent copy. */
  divergentConfig?: string;
  /** Populated for missing/drifted — last time we could observe this target. */
  lastObservedAt?: number;
}

export interface SharedMcpServerWithStatus {
  record: SharedMcpRecord;
  targets: readonly SharedMcpTargetStatus[];
}
```

- [ ] **Step 4: Implement `mcp-dtos.types.ts` (redacted DTOs for IPC)**

Create `src/shared/types/mcp-dtos.types.ts`:

```typescript
/**
 * Redacted DTOs for IPC. Per spec §10/§13, secrets NEVER leave the main
 * process. All env vars that pass the SecretClassifier heuristic are replaced
 * with the literal sentinel `'•••'` before the object crosses the preload
 * boundary. Renderer code should treat DTOs as read-only views.
 */
import type { McpScope, SupportedProvider } from './mcp-scopes.types';
import type { DriftState } from './mcp-shared.types';
import type { McpTransport } from './mcp-orchestrator.types';

export const REDACTED_SENTINEL = '•••';

export interface RedactedMcpServerDto {
  id: string;
  name: string;
  description?: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Values are either the real (non-secret) value or `REDACTED_SENTINEL`. */
  env?: Record<string, string>;
  autoConnect: boolean;
  /** Absolute path or ID of the config file this entry lives in (read-only scopes). */
  sourceFile?: string;
  /** True for project/local/workspace/managed scopes that Orchestrator never writes to. */
  readOnly: boolean;
  /** For shared servers: which provider targets this server fans out to. */
  sharedTargets?: readonly SupportedProvider[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderTabDto {
  provider: SupportedProvider;
  /** Installed status of the provider's CLI + readable config paths. */
  cliAvailable: boolean;
  /** Grouped by scope in render order: user → project → local → workspace → managed → system. */
  servers: readonly RedactedMcpServerDto[];
}

export interface SharedMcpDto {
  record: Omit<RedactedMcpServerDto, 'scope' | 'readOnly'> & { scope: 'shared'; readOnly: false };
  targets: readonly {
    provider: SupportedProvider;
    state: DriftState;
    /** Canonical diff text; populated iff state === 'drifted'. */
    diff?: string;
    lastObservedAt?: number;
  }[];
}

export interface OrchestratorMcpDto {
  record: Omit<RedactedMcpServerDto, 'scope' | 'readOnly'> & {
    scope: 'orchestrator' | 'orchestrator-bootstrap' | 'orchestrator-codemem';
    readOnly: false;
  };
  /** Per-provider injection opt-in (default: all 4). */
  injectInto: readonly SupportedProvider[];
}

export interface McpMultiProviderStateDto {
  orchestrator: readonly OrchestratorMcpDto[];
  shared: readonly SharedMcpDto[];
  providers: readonly ProviderTabDto[];
  /** Monotonic tick for state-change events. */
  stateVersion: number;
}

/**
 * Shared-server drift status, safe to cross the preload boundary.
 * `SharedMcpCoordinator` returns this shape from `fanOut`/`getDrift`; the
 * renderer consumes it without importing any main-process modules.
 */
export interface SharedDriftStatusDto {
  provider: SupportedProvider;
  state: DriftState;
  /** Canonical-vs-target diff text, populated iff `state === 'drifted'`. */
  diff?: string;
  lastObservedAt: number;
}
```

- [ ] **Step 5: Run test and verify it passes**

Run: `npx vitest run src/shared/types/__tests__/mcp-shared.types.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/mcp-shared.types.ts src/shared/types/mcp-dtos.types.ts src/shared/types/__tests__/mcp-shared.types.spec.ts
git commit -m "feat(mcp): add shared record + redacted DTO types"
```

---

## Task 0.3: Add Zod schemas + 4-way alias sync for new `@contracts/schemas/mcp-multi-provider` subpath

**⚠️ PACKAGING GOTCHA**: Adding a new `@contracts/schemas/<name>` subpath requires updating **four** places. Miss any one and typecheck passes but the packaged DMG crashes at startup. See AGENTS.md "Packaging Gotchas #1".

**Files:**
- Create: `packages/contracts/src/schemas/mcp-multi-provider.schemas.ts`
- Modify: `packages/contracts/src/schemas/index.ts` (export the new module)
- Modify: `tsconfig.json` (add path alias)
- Modify: `tsconfig.electron.json` (add path alias)
- Modify: `src/main/register-aliases.ts` (add runtime resolver entry)
- Modify: `vitest.config.ts` (add test alias)
- Test: `packages/contracts/src/schemas/__tests__/mcp-multi-provider.schemas.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/schemas/__tests__/mcp-multi-provider.schemas.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  OrchestratorMcpServerSchema,
  SharedMcpServerUpsertSchema,
  McpFanOutPayloadSchema,
  McpResolveDriftPayloadSchema,
  McpInjectionTargetsPayloadSchema,
} from '@contracts/schemas/mcp-multi-provider';

describe('mcp-multi-provider schemas', () => {
  it('rejects OrchestratorMcpServer with non-orchestrator scope', () => {
    const result = OrchestratorMcpServerSchema.safeParse({
      id: 'x',
      name: 'x',
      scope: 'user', // invalid
      transport: 'stdio',
      command: 'node',
      autoConnect: false,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts orchestrator-bootstrap scope with inline JSON', () => {
    const result = OrchestratorMcpServerSchema.safeParse({
      id: 'x',
      name: 'x',
      scope: 'orchestrator-bootstrap',
      transport: 'stdio',
      command: 'node',
      autoConnect: true,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result.success).toBe(true);
  });

  it('requires at least one target on SharedMcpServerUpsert', () => {
    const result = SharedMcpServerUpsertSchema.safeParse({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      targets: [],
    });
    expect(result.success).toBe(false);
  });

  it('McpFanOutPayload validates serverId + provider allow-list', () => {
    expect(
      McpFanOutPayloadSchema.safeParse({ serverId: 'x', providers: ['claude'] }).success,
    ).toBe(true);
    expect(
      McpFanOutPayloadSchema.safeParse({ serverId: 'x', providers: ['cursor'] }).success,
    ).toBe(false);
  });

  it('McpResolveDriftPayload requires a resolution action', () => {
    const ok = McpResolveDriftPayloadSchema.safeParse({
      serverId: 'x',
      provider: 'claude',
      action: 'overwrite-target',
    });
    expect(ok.success).toBe(true);
    const bad = McpResolveDriftPayloadSchema.safeParse({
      serverId: 'x',
      provider: 'claude',
      action: 'invalid',
    });
    expect(bad.success).toBe(false);
  });

  it('McpInjectionTargetsPayload accepts empty providers array (opt-out-all)', () => {
    const result = McpInjectionTargetsPayloadSchema.safeParse({
      serverId: 'x',
      providers: [],
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run packages/contracts/src/schemas/__tests__/mcp-multi-provider.schemas.spec.ts`
Expected: FAIL with `Cannot find module '@contracts/schemas/mcp-multi-provider'`.

- [ ] **Step 3: Write the schemas module**

Create `packages/contracts/src/schemas/mcp-multi-provider.schemas.ts`:

```typescript
/**
 * IPC payload schemas for the multi-provider MCP management surface.
 * Spec: docs/superpowers/specs/2026-04-21-mcp-multi-provider-management-design.md
 */
import { z } from 'zod';

const supportedProviderEnum = z.enum(['claude', 'codex', 'gemini', 'copilot']);

const transportEnum = z.enum(['stdio', 'sse']);

const orchestratorScopeEnum = z.enum([
  'orchestrator',
  'orchestrator-bootstrap',
  'orchestrator-codemem',
]);

const providerScopeEnum = z.enum([
  'user',
  'project',
  'local',
  'workspace',
  'managed',
  'system',
]);

const driftStateEnum = z.enum(['in-sync', 'drifted', 'missing', 'not-installed']);

const envRecordSchema = z.record(z.string(), z.string()).optional();

export const OrchestratorMcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  scope: orchestratorScopeEnum,
  transport: transportEnum,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: envRecordSchema,
  envSecretsEncrypted: z.record(z.string(), z.string()).optional(),
  autoConnect: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const SharedMcpServerUpsertSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  transport: transportEnum,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: envRecordSchema,
  targets: z.array(supportedProviderEnum).min(1),
});

export const McpFanOutPayloadSchema = z.object({
  serverId: z.string().min(1),
  providers: z.array(supportedProviderEnum).min(1),
});

export const McpResolveDriftPayloadSchema = z.object({
  serverId: z.string().min(1),
  provider: supportedProviderEnum,
  action: z.enum(['overwrite-target', 'adopt-target', 'untrack-target']),
});

export const McpInjectionTargetsPayloadSchema = z.object({
  serverId: z.string().min(1),
  providers: z.array(supportedProviderEnum),
});

export const McpProviderScopePayloadSchema = z.object({
  provider: supportedProviderEnum,
  scope: providerScopeEnum,
});

export const McpUserUpsertPayloadSchema = z.object({
  provider: supportedProviderEnum,
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  transport: transportEnum,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: envRecordSchema,
});

export const McpDriftQuerySchema = z.object({
  serverId: z.string().min(1),
});

export { driftStateEnum, supportedProviderEnum, orchestratorScopeEnum, providerScopeEnum };
```

- [ ] **Step 4: Export from the schemas barrel**

Edit `packages/contracts/src/schemas/index.ts` — add one line near the other exports:

```typescript
export * from './mcp-multi-provider.schemas';
```

- [ ] **Step 5: Add tsconfig.json path alias**

Edit `tsconfig.json`, in `compilerOptions.paths`, add:

```json
"@contracts/schemas/mcp-multi-provider": ["packages/contracts/src/schemas/mcp-multi-provider.schemas.ts"],
```

(Put it alphabetically adjacent to the other `@contracts/schemas/*` entries.)

- [ ] **Step 6: Add tsconfig.electron.json path alias**

Edit `tsconfig.electron.json`, same addition as Step 5 — inside `compilerOptions.paths`.

- [ ] **Step 7: Add vitest.config.ts alias**

Edit `vitest.config.ts`, in `resolve.alias`, add:

```typescript
'@contracts/schemas/mcp-multi-provider': path.resolve(__dirname, 'packages/contracts/src/schemas/mcp-multi-provider.schemas.ts'),
```

- [ ] **Step 8: Add Node runtime resolver entry (`register-aliases.ts`)**

Edit `src/main/register-aliases.ts`, in the `exactAliases` map, add:

```typescript
'@contracts/schemas/mcp-multi-provider': path.join(baseContracts, 'schemas', 'mcp-multi-provider.schemas'),
```

**CRITICAL**: Missing this step means typecheck passes but the packaged app crashes at startup with `Cannot find module '…/schemas/mcp-multi-provider'`.

- [ ] **Step 9: Run the test and verify it passes**

Run: `npx vitest run packages/contracts/src/schemas/__tests__/mcp-multi-provider.schemas.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 10: Typecheck + lint**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint -- --no-fix`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add packages/contracts/src/schemas/mcp-multi-provider.schemas.ts \
  packages/contracts/src/schemas/index.ts \
  packages/contracts/src/schemas/__tests__/mcp-multi-provider.schemas.spec.ts \
  tsconfig.json tsconfig.electron.json vitest.config.ts \
  src/main/register-aliases.ts
git commit -m "feat(mcp): add multi-provider Zod schemas + 4-way alias sync"
```

---

## Task 0.4: Add new IPC channel keys

**Files:**
- Modify: `packages/contracts/src/channels/workspace.channels.ts`
- Test: `packages/contracts/src/channels/__tests__/workspace.channels.spec.ts` (add cases)

- [ ] **Step 1: Append new channel keys**

Edit `packages/contracts/src/channels/workspace.channels.ts` — extend the existing channels object with these 14 new keys (grouped by responsibility):

```typescript
// Multi-provider MCP management (spec §11)
MCP_GET_MULTI_PROVIDER_STATE: 'mcp:get-multi-provider-state',
MCP_REFRESH_MULTI_PROVIDER_STATE: 'mcp:refresh-multi-provider-state',
MCP_MULTI_PROVIDER_STATE_CHANGED: 'mcp:multi-provider-state-changed',

// Orchestrator-scope CRUD
MCP_ORCHESTRATOR_UPSERT: 'mcp:orchestrator:upsert',
MCP_ORCHESTRATOR_DELETE: 'mcp:orchestrator:delete',
MCP_ORCHESTRATOR_SET_INJECTION_TARGETS: 'mcp:orchestrator:set-injection-targets',

// Shared-scope CRUD + fan-out + drift
MCP_SHARED_UPSERT: 'mcp:shared:upsert',
MCP_SHARED_DELETE: 'mcp:shared:delete',
MCP_SHARED_FAN_OUT: 'mcp:shared:fan-out',
MCP_SHARED_GET_DRIFT: 'mcp:shared:get-drift',
MCP_SHARED_RESOLVE_DRIFT: 'mcp:shared:resolve-drift',

// Per-provider user-scope CRUD (v1: user only is writable)
MCP_PROVIDER_USER_UPSERT: 'mcp:provider:user:upsert',
MCP_PROVIDER_USER_DELETE: 'mcp:provider:user:delete',
MCP_PROVIDER_OPEN_SCOPE_FILE: 'mcp:provider:open-scope-file',
```

- [ ] **Step 2: Re-run any channel-enum tests**

Run: `npx vitest run packages/contracts/src/channels`
Expected: PASS (channel enum sanity tests still green).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/channels/workspace.channels.ts
git commit -m "feat(mcp): add multi-provider MCP channel keys"
```

---

## Task 0.5: Regenerate preload channels

**Files:**
- Modify (via script): `src/preload/generated/channels.ts`

- [ ] **Step 1: Regenerate**

Run: `npm run generate:ipc`
Expected: `src/preload/generated/channels.ts` updated with the 14 new keys.

- [ ] **Step 2: Verify output**

Run: `npx tsc --noEmit`
Expected: no errors.

Grep the generated file for one of the new channel strings:

Run: `grep "mcp:multi-provider-state-changed" src/preload/generated/channels.ts`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add src/preload/generated/channels.ts
git commit -m "chore(ipc): regenerate preload channels for MCP multi-provider"
```

---

## Task 0.6: Add migration 015 `orchestrator_mcp_servers`

**Files:**
- Modify: `src/main/persistence/rlm/rlm-schema.ts` (append to `MIGRATIONS` array)
- Test: `src/main/persistence/rlm/__tests__/rlm-schema.spec.ts` (add migration snapshot)

- [ ] **Step 1: Write the failing test**

Add to `src/main/persistence/rlm/__tests__/rlm-schema.spec.ts`:

```typescript
it('migration 015 creates orchestrator_mcp_servers with expected columns', () => {
  const db = openMemoryDb(); // helper used elsewhere in this spec file
  runMigrations(db, 15);
  const cols = db.prepare(`PRAGMA table_info(orchestrator_mcp_servers)`).all();
  const names = new Set(cols.map((c: any) => c.name));
  expect(names).toEqual(new Set([
    'id', 'name', 'description', 'scope', 'transport',
    'command', 'args_json', 'url', 'env_json', 'env_secrets_encrypted_json',
    'auto_connect', 'inject_into_json', 'created_at', 'updated_at',
  ]));
});

it('migration 015 enforces scope enum', () => {
  const db = openMemoryDb();
  runMigrations(db, 15);
  expect(() =>
    db.prepare(`INSERT INTO orchestrator_mcp_servers (id, name, scope, transport, auto_connect, inject_into_json, created_at, updated_at)
                VALUES ('x','x','user','stdio',0,'[]',1,1)`).run(),
  ).toThrow(/CHECK constraint failed|constraint/);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/persistence/rlm/__tests__/rlm-schema.spec.ts`
Expected: FAIL (table doesn't exist).

- [ ] **Step 3: Append migration 015 to `MIGRATIONS`**

Edit `src/main/persistence/rlm/rlm-schema.ts`, at the end of the `MIGRATIONS` array:

```typescript
{
  version: 15,
  description: 'Add orchestrator_mcp_servers table for Orchestrator-scope MCP records',
  sql: `
    CREATE TABLE orchestrator_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('orchestrator','orchestrator-bootstrap','orchestrator-codemem')),
      transport TEXT NOT NULL CHECK (transport IN ('stdio','sse')),
      command TEXT,
      args_json TEXT,
      url TEXT,
      env_json TEXT,
      env_secrets_encrypted_json TEXT,
      auto_connect INTEGER NOT NULL DEFAULT 0 CHECK (auto_connect IN (0,1)),
      inject_into_json TEXT NOT NULL DEFAULT '["claude","codex","gemini","copilot"]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_orchestrator_mcp_scope ON orchestrator_mcp_servers(scope);
  `,
},
```

- [ ] **Step 4: Run test again**

Run: `npx vitest run src/main/persistence/rlm/__tests__/rlm-schema.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/main/persistence/rlm/rlm-schema.ts src/main/persistence/rlm/__tests__/rlm-schema.spec.ts
git commit -m "feat(mcp): migration 015 — orchestrator_mcp_servers"
```

---

## Task 0.7: Add migration 016 `shared_mcp_servers`

**Files:**
- Modify: `src/main/persistence/rlm/rlm-schema.ts`
- Test: `src/main/persistence/rlm/__tests__/rlm-schema.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to the rlm-schema spec:

```typescript
it('migration 016 creates shared_mcp_servers with targets_json column', () => {
  const db = openMemoryDb();
  runMigrations(db, 16);
  const cols = db.prepare(`PRAGMA table_info(shared_mcp_servers)`).all();
  const names = new Set(cols.map((c: any) => c.name));
  expect(names).toEqual(new Set([
    'id', 'name', 'description', 'transport',
    'command', 'args_json', 'url', 'env_json', 'env_secrets_encrypted_json',
    'targets_json', 'created_at', 'updated_at',
  ]));
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/persistence/rlm/__tests__/rlm-schema.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Append migration 016**

Edit `src/main/persistence/rlm/rlm-schema.ts`:

```typescript
{
  version: 16,
  description: 'Add shared_mcp_servers table for Shared-scope MCP records (fan-out)',
  sql: `
    CREATE TABLE shared_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      transport TEXT NOT NULL CHECK (transport IN ('stdio','sse')),
      command TEXT,
      args_json TEXT,
      url TEXT,
      env_json TEXT,
      env_secrets_encrypted_json TEXT,
      targets_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `,
},
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/persistence/rlm/__tests__/rlm-schema.spec.ts
npx tsc --noEmit
git add src/main/persistence/rlm/rlm-schema.ts src/main/persistence/rlm/__tests__/rlm-schema.spec.ts
git commit -m "feat(mcp): migration 016 — shared_mcp_servers"
```

---

## Task 0.8: Extend AppSettings + SETTINGS_METADATA with three MCP settings

**Context:** Spec §15 adds three user-toggleable settings. AppSettings + SETTINGS_METADATA are the single source of truth for settings UI generation.

**Files:**
- Modify: `src/shared/types/settings.types.ts` — extend `AppSettings` interface + `DEFAULT_SETTINGS`
- Modify: `src/shared/config/settings-metadata.ts` — add three entries to `SETTINGS_METADATA`
- Test: `src/shared/config/__tests__/settings-metadata.spec.ts` (add coverage)

- [ ] **Step 1: Write failing metadata test**

Append to the settings-metadata spec:

```typescript
it('exposes three MCP multi-provider settings with expected defaults', () => {
  const cleanup = SETTINGS_METADATA.find(s => s.key === 'mcpCleanupBackupsOnQuit');
  expect(cleanup?.defaultValue).toBe(true);

  const disable = SETTINGS_METADATA.find(s => s.key === 'mcpDisableProviderBackups');
  expect(disable?.defaultValue).toBe(false);

  const permissive = SETTINGS_METADATA.find(s => s.key === 'mcpAllowWorldWritableParent');
  expect(permissive?.defaultValue).toBe(false);

  // Safety invariants (spec §15)
  expect(cleanup?.category).toBe('mcp');
  expect(disable?.warning).toBeTruthy();
  expect(permissive?.warning).toBeTruthy();
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/shared/config/__tests__/settings-metadata.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `AppSettings` and `DEFAULT_SETTINGS`**

Edit `src/shared/types/settings.types.ts`. Add these three fields to `AppSettings` (alphabetical-within-group):

```typescript
/** Cleanup provider-config `.orc.bak-<ts>` backups when the app quits. */
mcpCleanupBackupsOnQuit: boolean;
/** Disable writing provider-config backups entirely (NOT RECOMMENDED). */
mcpDisableProviderBackups: boolean;
/** Allow writing to a config dir whose parent is world-writable (NOT RECOMMENDED). */
mcpAllowWorldWritableParent: boolean;
```

And add matching entries to `DEFAULT_SETTINGS`:

```typescript
mcpCleanupBackupsOnQuit: true,
mcpDisableProviderBackups: false,
mcpAllowWorldWritableParent: false,
```

- [ ] **Step 4: Extend `SETTINGS_METADATA`**

Edit `src/shared/config/settings-metadata.ts`. Append three entries:

```typescript
{
  key: 'mcpCleanupBackupsOnQuit',
  label: 'Clean up MCP config backups on quit',
  description: 'Removes `.orc.bak-<timestamp>` files we wrote while editing provider MCP configs.',
  category: 'mcp',
  type: 'boolean',
  defaultValue: true,
},
{
  key: 'mcpDisableProviderBackups',
  label: 'Don\'t write provider-config backups before editing',
  description: 'Skips the safety backup step. Corruption-prevention is weaker.',
  category: 'mcp',
  type: 'boolean',
  defaultValue: false,
  warning: 'Not recommended — backups protect against botched edits.',
},
{
  key: 'mcpAllowWorldWritableParent',
  label: 'Allow writing to world-writable config parents',
  description: 'Permits writes to config directories whose parent has loose permissions.',
  category: 'mcp',
  type: 'boolean',
  defaultValue: false,
  warning: 'Not recommended — allows shared-host tampering of config paths.',
},
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/shared/config/__tests__/settings-metadata.spec.ts && npx tsc --noEmit`
Expected: PASS + no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/settings.types.ts src/shared/config/settings-metadata.ts src/shared/config/__tests__/settings-metadata.spec.ts
git commit -m "feat(mcp): add three MCP safety settings (backups + world-writable toggles)"
```

---

## Task 0.9: Scaffold `secret-storage.ts` capability wrapper

**Context:** Spec §13. Secrets must prefer `safeStorage`; fall back to plaintext + quarantine marker + warning. All secret I/O routes through this module.

**Files:**
- Create: `src/main/mcp/secret-storage.ts`
- Test: `src/main/mcp/__tests__/secret-storage.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/mcp/__tests__/secret-storage.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpSecretStorage } from '../secret-storage';

describe('McpSecretStorage', () => {
  beforeEach(() => vi.resetModules());

  it('uses safeStorage when available', () => {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => b.toString('utf8').replace('enc:', ''),
    };
    const storage = new McpSecretStorage({ safeStorage: safeStorage as any });
    const encoded = storage.encryptSecret('hunter2');
    expect(encoded.status).toBe('encrypted');
    expect(encoded.payload).not.toContain('hunter2');
    const decoded = storage.decryptSecret(encoded);
    expect(decoded).toBe('hunter2');
  });

  it('falls back to plaintext + quarantine when safeStorage is unavailable', () => {
    const safeStorage = { isEncryptionAvailable: () => false };
    const storage = new McpSecretStorage({ safeStorage: safeStorage as any });
    const encoded = storage.encryptSecret('hunter2');
    expect(encoded.status).toBe('plaintext-quarantined');
    expect(encoded.payload).toBe('hunter2');
    const decoded = storage.decryptSecret(encoded);
    expect(decoded).toBe('hunter2');
  });

  it('exposes isEncryptionAvailable for UI warning banners', () => {
    const storage = new McpSecretStorage({
      safeStorage: { isEncryptionAvailable: () => false } as any,
    });
    expect(storage.isEncryptionAvailable()).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/secret-storage.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `secret-storage.ts`**

Create `src/main/mcp/secret-storage.ts`:

```typescript
import { getLogger } from '../logging/logger';

const logger = getLogger('McpSecretStorage');

export type EncryptedSecretStatus = 'encrypted' | 'plaintext-quarantined';

export interface EncryptedSecret {
  status: EncryptedSecretStatus;
  payload: string; // base64 when encrypted, utf-8 when plaintext
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString?(plain: string): Buffer;
  decryptString?(buf: Buffer): string;
}

export class McpSecretStorage {
  private readonly safeStorage: SafeStorageLike;

  constructor(deps: { safeStorage: SafeStorageLike }) {
    this.safeStorage = deps.safeStorage;
  }

  isEncryptionAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  encryptSecret(plain: string): EncryptedSecret {
    if (this.safeStorage.isEncryptionAvailable() && this.safeStorage.encryptString) {
      const enc = this.safeStorage.encryptString(plain);
      return { status: 'encrypted', payload: enc.toString('base64') };
    }
    logger.warn('safeStorage not available — storing secret in plaintext (quarantined)');
    return { status: 'plaintext-quarantined', payload: plain };
  }

  decryptSecret(secret: EncryptedSecret): string {
    if (secret.status === 'plaintext-quarantined') {
      return secret.payload;
    }
    if (!this.safeStorage.decryptString) {
      throw new Error('safeStorage.decryptString unavailable; cannot decrypt encrypted secret');
    }
    return this.safeStorage.decryptString(Buffer.from(secret.payload, 'base64'));
  }
}

let instance: McpSecretStorage | null = null;
export function getMcpSecretStorage(): McpSecretStorage {
  if (instance) return instance;
  // Lazy require avoids blowing up in renderer/tests that import this file.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safeStorage } = require('electron');
  instance = new McpSecretStorage({ safeStorage });
  return instance;
}

export function _resetMcpSecretStorageForTesting(): void {
  instance = null;
}
```

- [ ] **Step 4: Run test + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/secret-storage.spec.ts
npx tsc --noEmit
git add src/main/mcp/secret-storage.ts src/main/mcp/__tests__/secret-storage.spec.ts
git commit -m "feat(mcp): secret-storage capability wrapper (safeStorage + quarantine fallback)"
```

---

## Task 0.10: Observation test — Claude `--mcp-config` merge-vs-replace semantics

**Context:** Spec §1/Phase 0 requires empirical confirmation that Claude Code merges multiple `--mcp-config <path>` invocations (vs. last-wins). This governs whether we bundle the Orchestrator config alongside provider configs or skip the provider flag entirely when Orchestrator servers are present.

**Files:**
- Create: `docs/superpowers/observations/2026-04-21-claude-mcp-config-flag.md`
- Create (optional, throwaway): `scripts/observe-claude-mcp-merge.ts`

- [ ] **Step 1: Write observation runbook doc**

Create `docs/superpowers/observations/2026-04-21-claude-mcp-config-flag.md`:

```markdown
# Claude `--mcp-config` Flag Semantics — Observation

## Question
Does `claude --mcp-config A.json --mcp-config B.json` merge A and B, or does B replace A?

## Why it matters
Phase 1 of the MCP multi-provider plan needs this to decide whether:
- Provider config stays untouched + Orchestrator config is appended via an extra `--mcp-config` (merge case), OR
- Orchestrator config must be merged into the provider payload before launch (replace case).

## Procedure
1. Create two files with non-overlapping server IDs:
   - `A.json`: `{ "mcpServers": { "obs-a": { "command": "/bin/echo", "args": ["A"] } } }`
   - `B.json`: `{ "mcpServers": { "obs-b": { "command": "/bin/echo", "args": ["B"] } } }`
2. Launch `claude --print --mcp-config A.json --mcp-config B.json /mcp` (or equivalent command that lists registered servers).
3. Observe output.

## Recording format
At the bottom of this doc, record:
- Claude CLI version (`claude --version`).
- Full stdout of the invocation.
- Classification: `merge` | `replace-last-wins` | `error`.
- Classification: what happens with overlapping server IDs (which wins?).

## Implications (fill in once observed)
- If `merge`: adapter passes both provider + orchestrator paths. Simplest code path.
- If `replace`: adapter merges JSON in-process and passes a single temp `--mcp-config <merged>` path.
- If `error`: adapter writes a single merged temp path regardless.
```

- [ ] **Step 2: Run the observation manually**

Run the Step 1 Procedure on the host Claude CLI. Record the results in the "Implications" section of the doc.

If `merge` is confirmed, no code change is needed; Phase 1 Task 1.8 adapter glue can pass multiple paths. If `replace` or `error`, Phase 1 Task 1.8 must merge JSON in-process before spawn.

- [ ] **Step 3: Commit the observation**

```bash
git add docs/superpowers/observations/2026-04-21-claude-mcp-config-flag.md
git commit -m "docs(mcp): Phase 0 observation — Claude --mcp-config semantics"
```

---

# Phase 1 — Main-Process Core

Goal: read + write provider-config files, persist Orchestrator records in sqlite, expose a spawn-time injection reader, and replace Codex's brittle string-based MCP-server strip with a comment-preserving TOML parse/re-emit.

## Task 1.1: Create `WriteSafetyHelper` (atomic-write + backup + parent-permission guard)

**Context:** Spec §14. Best-effort atomic writes; POSIX rename (atomic on same fs); Windows fallback copyFile+unlink. Parent-permission guard refuses when parent is world-writable unless `mcpAllowWorldWritableParent` is true.

**Files:**
- Create: `src/main/mcp/write-safety-helper.ts`
- Test: `src/main/mcp/__tests__/write-safety-helper.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/mcp/__tests__/write-safety-helper.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WriteSafetyHelper } from '../write-safety-helper';

describe('WriteSafetyHelper', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-wsh-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes atomically via temp+rename', async () => {
    const helper = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true });
    const target = path.join(tmp, 'config.json');
    await helper.writeAtomic(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
  });

  it('writes a backup before overwriting an existing file', async () => {
    const helper = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true });
    const target = path.join(tmp, 'config.json');
    fs.writeFileSync(target, '{"old":true}');
    await helper.writeAtomic(target, '{"new":true}');
    const backups = fs.readdirSync(tmp).filter(f => f.startsWith('config.json.orc.bak-'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(tmp, backups[0]!), 'utf8')).toBe('{"old":true}');
  });

  it('skips backups when writeBackups=false', async () => {
    const helper = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: false });
    const target = path.join(tmp, 'config.json');
    fs.writeFileSync(target, 'old');
    await helper.writeAtomic(target, 'new');
    const backups = fs.readdirSync(tmp).filter(f => f.includes('.orc.bak-'));
    expect(backups.length).toBe(0);
  });

  it('refuses to write when parent is world-writable and flag is off', async () => {
    if (process.platform === 'win32') return; // skip; POSIX only
    const helper = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: false });
    fs.chmodSync(tmp, 0o777);
    const target = path.join(tmp, 'config.json');
    await expect(helper.writeAtomic(target, 'x')).rejects.toThrow(/world-writable/i);
  });

  it('allows world-writable parent when flag is on', async () => {
    if (process.platform === 'win32') return;
    const helper = new WriteSafetyHelper({ allowWorldWritableParent: true, writeBackups: false });
    fs.chmodSync(tmp, 0o777);
    const target = path.join(tmp, 'config.json');
    await helper.writeAtomic(target, 'x');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('cleanupBackups removes `.orc.bak-<ts>` siblings of tracked paths', async () => {
    const helper = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true });
    const target = path.join(tmp, 'config.json');
    fs.writeFileSync(target, 'a');
    await helper.writeAtomic(target, 'b');
    await helper.writeAtomic(target, 'c');
    await helper.cleanupBackups([target]);
    const leftovers = fs.readdirSync(tmp).filter(f => f.includes('.orc.bak-'));
    expect(leftovers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/main/mcp/__tests__/write-safety-helper.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `write-safety-helper.ts`**

Create `src/main/mcp/write-safety-helper.ts`:

```typescript
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';

const logger = getLogger('WriteSafetyHelper');

export interface WriteSafetyOptions {
  /** Allow writing to a directory whose parent is world-writable. */
  allowWorldWritableParent: boolean;
  /** Write `.orc.bak-<ts>` copies before overwriting existing files. */
  writeBackups: boolean;
}

export class WriteSafetyHelper {
  constructor(private readonly opts: WriteSafetyOptions) {}

  async writeAtomic(targetPath: string, contents: string | Buffer): Promise<void> {
    await this.guardParentPermission(targetPath);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });

    if (this.opts.writeBackups && fs.existsSync(targetPath)) {
      const ts = Date.now();
      const backupPath = `${targetPath}.orc.bak-${ts}`;
      await fsp.copyFile(targetPath, backupPath);
    }

    const tmpPath = `${targetPath}.orc.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, contents);
    try {
      await fsp.rename(tmpPath, targetPath);
    } catch (err) {
      if (process.platform === 'win32') {
        await fsp.copyFile(tmpPath, targetPath);
        await fsp.unlink(tmpPath);
      } else {
        throw err;
      }
    }
  }

  async cleanupBackups(trackedPaths: readonly string[]): Promise<void> {
    for (const p of trackedPaths) {
      try {
        const dir = path.dirname(p);
        const base = path.basename(p);
        const entries = await fsp.readdir(dir);
        const matches = entries.filter(e => e.startsWith(`${base}.orc.bak-`));
        for (const m of matches) {
          await fsp.unlink(path.join(dir, m)).catch(() => undefined);
        }
      } catch (err) {
        logger.warn('cleanupBackups skipped', { path: p, error: (err as Error).message });
      }
    }
  }

  private async guardParentPermission(targetPath: string): Promise<void> {
    if (this.opts.allowWorldWritableParent) return;
    if (process.platform === 'win32') return;
    const parent = path.dirname(targetPath);
    try {
      const stat = await fsp.stat(parent);
      // eslint-disable-next-line no-bitwise
      if ((stat.mode & 0o002) !== 0) {
        throw new Error(`refusing write: parent directory ${parent} is world-writable (override in Settings → MCP)`);
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') return; // parent doesn't exist yet — mkdir will create securely
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/write-safety-helper.spec.ts
npx tsc --noEmit
git add src/main/mcp/write-safety-helper.ts src/main/mcp/__tests__/write-safety-helper.spec.ts
git commit -m "feat(mcp): WriteSafetyHelper — atomic + backups + parent-permission guard"
```

---

## Task 1.2: Create `SecretClassifier` — detect which env keys are likely secrets

**Context:** Spec §10. Heuristic classification: key-name regex (TOKEN, KEY, SECRET, PASSWORD, AUTH, BEARER, COOKIE, SESSION) + value-shape (long hex/base64, JWT three-dot). Classifier is conservative: false positives are cheap (redacted in UI), false negatives are dangerous (leak to renderer).

**Files:**
- Create: `src/main/mcp/secret-classifier.ts`
- Test: `src/main/mcp/__tests__/secret-classifier.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/mcp/__tests__/secret-classifier.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SecretClassifier } from '../secret-classifier';

describe('SecretClassifier', () => {
  const c = new SecretClassifier();

  it('flags common secret key-name patterns', () => {
    expect(c.isSecret('GITHUB_TOKEN', 'xyz')).toBe(true);
    expect(c.isSecret('AWS_SECRET_ACCESS_KEY', 'x')).toBe(true);
    expect(c.isSecret('DB_PASSWORD', 'x')).toBe(true);
    expect(c.isSecret('AUTH_BEARER', 'x')).toBe(true);
    expect(c.isSecret('COOKIE_JAR', 'x')).toBe(true);
    expect(c.isSecret('SESSION_KEY', 'x')).toBe(true);
    expect(c.isSecret('API_KEY', 'x')).toBe(true);
  });

  it('flags JWT-shaped values even when key looks innocent', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.Sig';
    expect(c.isSecret('MY_VAR', jwt)).toBe(true);
  });

  it('flags long hex/base64 values as likely secrets', () => {
    expect(c.isSecret('THING', 'a'.repeat(64))).toBe(true);
  });

  it('does not flag ordinary values', () => {
    expect(c.isSecret('HOME', '/Users/foo')).toBe(false);
    expect(c.isSecret('NODE_ENV', 'production')).toBe(false);
    expect(c.isSecret('LOG_LEVEL', 'info')).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/secret-classifier.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `secret-classifier.ts`**

Create `src/main/mcp/secret-classifier.ts`:

```typescript
const SECRET_KEY_PATTERN =
  /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD|AUTH|BEARER|COOKIE|SESSION|CREDENTIAL|PRIVATE)/i;

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class SecretClassifier {
  isSecret(key: string, value: string): boolean {
    if (SECRET_KEY_PATTERN.test(key)) return true;
    if (value.length >= 32 && JWT_PATTERN.test(value)) return true;
    if (value.length >= 48 && /^[A-Fa-f0-9]+$/.test(value)) return true;
    if (value.length >= 48 && /^[A-Za-z0-9+/=_-]+$/.test(value) && /\d/.test(value) && /[a-zA-Z]/.test(value)) {
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/secret-classifier.spec.ts
npx tsc --noEmit
git add src/main/mcp/secret-classifier.ts src/main/mcp/__tests__/secret-classifier.spec.ts
git commit -m "feat(mcp): SecretClassifier heuristic for env-var redaction"
```

---

## Task 1.3: Create `RedactionService` — produce redacted DTOs

**Context:** Spec §10/§13. Takes a raw server record + provider/scope metadata → `RedactedMcpServerDto`. Env values flagged by `SecretClassifier` are replaced with `REDACTED_SENTINEL`.

**Files:**
- Create: `src/main/mcp/redaction-service.ts`
- Test: `src/main/mcp/__tests__/redaction-service.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/__tests__/redaction-service.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RedactionService } from '../redaction-service';
import { SecretClassifier } from '../secret-classifier';
import { REDACTED_SENTINEL } from '../../../shared/types/mcp-dtos.types';

describe('RedactionService', () => {
  const svc = new RedactionService(new SecretClassifier());

  it('redacts secret-shaped env values in the DTO', () => {
    const dto = svc.redact(
      {
        id: 'x', name: 'x',
        transport: 'stdio', command: 'node',
        env: { HOME: '/u', API_KEY: 'abc123', GITHUB_TOKEN: 'xyz' },
        autoConnect: false,
        createdAt: 1, updatedAt: 1,
      },
      { scope: 'user', readOnly: false, sourceFile: '~/.claude.json' },
    );
    expect(dto.env?.HOME).toBe('/u');
    expect(dto.env?.API_KEY).toBe(REDACTED_SENTINEL);
    expect(dto.env?.GITHUB_TOKEN).toBe(REDACTED_SENTINEL);
  });

  it('carries scope + sourceFile + readOnly through', () => {
    const dto = svc.redact(
      { id: 'x', name: 'x', transport: 'stdio', autoConnect: false, createdAt: 1, updatedAt: 1 },
      { scope: 'project', readOnly: true, sourceFile: '.mcp.json' },
    );
    expect(dto.scope).toBe('project');
    expect(dto.readOnly).toBe(true);
    expect(dto.sourceFile).toBe('.mcp.json');
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/redaction-service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `redaction-service.ts`**

Create `src/main/mcp/redaction-service.ts`:

```typescript
import type { McpScope, SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { McpTransport } from '../../shared/types/mcp-orchestrator.types';
import { REDACTED_SENTINEL, type RedactedMcpServerDto } from '../../shared/types/mcp-dtos.types';
import { SecretClassifier } from './secret-classifier';

export interface RawMcpRecord {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  autoConnect: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RedactionContext {
  scope: McpScope;
  readOnly: boolean;
  sourceFile?: string;
  sharedTargets?: readonly SupportedProvider[];
}

export class RedactionService {
  constructor(private readonly classifier: SecretClassifier) {}

  redact(raw: RawMcpRecord, ctx: RedactionContext): RedactedMcpServerDto {
    const env = raw.env
      ? Object.fromEntries(
          Object.entries(raw.env).map(([k, v]) => [
            k,
            this.classifier.isSecret(k, v) ? REDACTED_SENTINEL : v,
          ]),
        )
      : undefined;

    return {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      scope: ctx.scope,
      transport: raw.transport,
      command: raw.command,
      args: raw.args,
      url: raw.url,
      env,
      autoConnect: raw.autoConnect,
      sourceFile: ctx.sourceFile,
      readOnly: ctx.readOnly,
      sharedTargets: ctx.sharedTargets,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/redaction-service.spec.ts
npx tsc --noEmit
git add src/main/mcp/redaction-service.ts src/main/mcp/__tests__/redaction-service.spec.ts
git commit -m "feat(mcp): RedactionService for renderer-safe DTOs"
```

---

## Task 1.4: Provider adapter interface + Claude adapter (read-only + user-scope writes)

**Context:** Spec §2/§5. Each provider adapter knows how to read/write its own config files. Claude Code uses JSON: `~/.claude.json` (user), `.mcp.json` (project checked-in), `~/.claude.json` per-project override (local), system managed paths. v1: only user scope is writable.

**Files:**
- Create: `src/main/mcp/adapters/provider-mcp-adapter.types.ts` — shared interface
- Create: `src/main/mcp/adapters/claude-mcp-adapter.ts`
- Test: `src/main/mcp/adapters/__tests__/claude-mcp-adapter.spec.ts`

- [ ] **Step 1: Write the shared interface**

Create `src/main/mcp/adapters/provider-mcp-adapter.types.ts`:

```typescript
import type {
  ProviderMcpScope,
  SupportedProvider,
} from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';

export interface ProviderScopeSnapshot {
  scope: ProviderMcpScope;
  /** Absolute path to the file we read. */
  sourceFile: string;
  servers: readonly RawMcpRecord[];
}

export interface ProviderMcpAdapter {
  readonly provider: SupportedProvider;

  /** Probe installed state + return per-scope file paths (may not exist yet). */
  discoverScopes(opts: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }>;

  /** Parse a scope file into records. Must not throw on ENOENT — returns []. */
  readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot>;

  /**
   * Upsert/delete a single server in the user-scope config file. Other scopes
   * throw in v1 (read-only). Must route writes through WriteSafetyHelper.
   */
  writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void>;
}
```

- [ ] **Step 2: Write the failing Claude adapter test**

Create `src/main/mcp/adapters/__tests__/claude-mcp-adapter.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ClaudeMcpAdapter } from '../claude-mcp-adapter';
import { WriteSafetyHelper } from '../../write-safety-helper';

describe('ClaudeMcpAdapter', () => {
  let home: string;
  let cwd: string;
  let adapter: ClaudeMcpAdapter;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-claude-cwd-'));
    adapter = new ClaudeMcpAdapter({
      home,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('readScope(user) returns [] when file absent', async () => {
    const snap = await adapter.readScope('user', path.join(home, '.claude.json'));
    expect(snap.servers).toEqual([]);
  });

  it('readScope(user) parses mcpServers map', async () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['x'] } } }),
    );
    const snap = await adapter.readScope('user', path.join(home, '.claude.json'));
    expect(snap.servers.length).toBe(1);
    expect(snap.servers[0]!.name).toBe('fs');
  });

  it('readScope(project) reads .mcp.json when present', async () => {
    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'x' } } }),
    );
    const snap = await adapter.readScope('project', path.join(cwd, '.mcp.json'));
    expect(snap.servers[0]!.name).toBe('gh');
  });

  it('writeUserServer upsert modifies only mcpServers + preserves other keys', async () => {
    const target = path.join(home, '.claude.json');
    fs.writeFileSync(target, JSON.stringify({ theme: 'dark', mcpServers: {} }));
    await adapter.writeUserServer({
      kind: 'upsert',
      record: {
        id: 'fs', name: 'fs',
        transport: 'stdio', command: 'npx', args: ['a'],
        autoConnect: true, createdAt: 1, updatedAt: 1,
      },
      sourceFile: target,
    });
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.fs.command).toBe('npx');
  });

  it('writeUserServer delete removes the named entry', async () => {
    const target = path.join(home, '.claude.json');
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { fs: { command: 'x' }, gh: { command: 'y' } } }));
    await adapter.writeUserServer({ kind: 'delete', serverId: 'fs', sourceFile: target });
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.mcpServers.fs).toBeUndefined();
    expect(parsed.mcpServers.gh).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run and see it fail**

Run: `npx vitest run src/main/mcp/adapters/__tests__/claude-mcp-adapter.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `claude-mcp-adapter.ts`**

Create `src/main/mcp/adapters/claude-mcp-adapter.ts`:

```typescript
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ProviderMcpAdapter,
  ProviderScopeSnapshot,
} from './provider-mcp-adapter.types';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import type { WriteSafetyHelper } from '../write-safety-helper';

export class ClaudeMcpAdapter implements ProviderMcpAdapter {
  readonly provider: SupportedProvider = 'claude';

  constructor(
    private readonly deps: {
      home: string;
      writeSafety: WriteSafetyHelper;
    },
  ) {}

  async discoverScopes(opts: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }> {
    return {
      cliAvailable: true, // Surface-level probe only in v1; deeper probe deferred.
      scopeFiles: {
        user: path.join(this.deps.home, '.claude.json'),
        project: path.join(opts.cwd, '.mcp.json'),
        local: path.join(opts.cwd, '.claude/settings.local.json'),
      },
    };
  }

  async readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot> {
    const servers = await this.parseConfig(filePath);
    return { scope, sourceFile: filePath, servers };
  }

  async writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void> {
    const current = await this.readJson(op.sourceFile);
    const mcpServers = { ...(current.mcpServers ?? {}) };

    if (op.kind === 'upsert') {
      mcpServers[op.record.name] = this.serializeRecord(op.record);
    } else {
      delete mcpServers[op.serverId];
    }

    const next = { ...current, mcpServers };
    await this.deps.writeSafety.writeAtomic(op.sourceFile, JSON.stringify(next, null, 2));
  }

  private async parseConfig(filePath: string): Promise<RawMcpRecord[]> {
    if (!fs.existsSync(filePath)) return [];
    const parsed = await this.readJson(filePath);
    const raw = parsed.mcpServers ?? {};
    const now = Date.now();
    return Object.entries(raw).map(([name, entry]: [string, any]) => ({
      id: `claude-user:${name}`,
      name,
      description: entry.description,
      transport: entry.transport === 'sse' ? 'sse' : 'stdio',
      command: entry.command,
      args: entry.args,
      url: entry.url,
      env: entry.env,
      autoConnect: entry.autoConnect !== false,
      createdAt: now,
      updatedAt: now,
    }));
  }

  private async readJson(filePath: string): Promise<any> {
    if (!fs.existsSync(filePath)) return {};
    const raw = await fsp.readFile(filePath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  }

  private serializeRecord(r: RawMcpRecord): Record<string, unknown> {
    const out: Record<string, unknown> = { command: r.command };
    if (r.args) out.args = r.args;
    if (r.env) out.env = r.env;
    if (r.url) out.url = r.url;
    if (r.transport === 'sse') out.transport = 'sse';
    if (r.description) out.description = r.description;
    if (r.autoConnect === false) out.autoConnect = false;
    return out;
  }
}
```

- [ ] **Step 5: Run test + typecheck + commit**

```bash
npx vitest run src/main/mcp/adapters/__tests__/claude-mcp-adapter.spec.ts
npx tsc --noEmit
git add src/main/mcp/adapters/provider-mcp-adapter.types.ts \
  src/main/mcp/adapters/claude-mcp-adapter.ts \
  src/main/mcp/adapters/__tests__/claude-mcp-adapter.spec.ts
git commit -m "feat(mcp): Claude provider adapter (read + user-scope write)"
```

---

## Task 1.5: Codex adapter + comment-preserving TOML parse/emit

**Context:** Spec §5. `~/.codex/config.toml` may contain comments users care about. `@iarna/toml` round-trips with some comment preservation; if it doesn't, fall back to a comment-aware line-by-line rewriter that only touches the `[mcp_servers.*]` blocks. Also introduces runtime dep `@iarna/toml`.

**Files:**
- Modify: `package.json` (add dep `@iarna/toml`)
- Create: `src/main/mcp/adapters/codex-mcp-adapter.ts`
- Create: `src/main/mcp/adapters/codex-toml-editor.ts` — isolated block-rewriter used by adapter
- Test: `src/main/mcp/adapters/__tests__/codex-mcp-adapter.spec.ts`
- Test: `src/main/mcp/adapters/__tests__/codex-toml-editor.spec.ts`

- [ ] **Step 1: Install dep**

Run: `npm install @iarna/toml@^2.2.5`
Expected: `package.json` + `package-lock.json` updated; no version conflicts.

- [ ] **Step 2: Write failing editor test**

Create `src/main/mcp/adapters/__tests__/codex-toml-editor.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CodexTomlEditor } from '../codex-toml-editor';

describe('CodexTomlEditor', () => {
  const editor = new CodexTomlEditor();

  it('strips all [mcp_servers.*] blocks but preserves leading comments', () => {
    const input = `
# user comment we care about
model = "gpt-5"

[mcp_servers.a]
command = "x"

[mcp_servers.b]
command = "y"

[profiles.default]
approval = "never"
`;
    const out = editor.stripMcpServers(input);
    expect(out).toContain('# user comment we care about');
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain('[profiles.default]');
    expect(out).not.toContain('[mcp_servers.');
  });

  it('upserts a named server without disturbing unrelated keys or comments', () => {
    const input = `
# important
model = "gpt-5"

[profiles.default]
approval = "never"
`;
    const out = editor.upsertMcpServer(input, 'gh', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    expect(out).toContain('# important');
    expect(out).toContain('[profiles.default]');
    expect(out).toMatch(/\[mcp_servers\.gh\]/);
    expect(out).toContain('command = "npx"');
  });

  it('deletes a named server while leaving siblings intact', () => {
    const input = `
[mcp_servers.a]
command = "a"

[mcp_servers.b]
command = "b"
`;
    const out = editor.deleteMcpServer(input, 'a');
    expect(out).not.toMatch(/\[mcp_servers\.a\]/);
    expect(out).toMatch(/\[mcp_servers\.b\]/);
  });
});
```

- [ ] **Step 3: Run and see it fail**

Run: `npx vitest run src/main/mcp/adapters/__tests__/codex-toml-editor.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `codex-toml-editor.ts`**

Create `src/main/mcp/adapters/codex-toml-editor.ts`:

```typescript
/**
 * Comment-preserving editor for `~/.codex/config.toml` MCP-server sections.
 *
 * Strategy: line-based scan. We only touch `[mcp_servers.<name>]` blocks and
 * their bodies (up to the next `[section]` header or EOF). Everything else —
 * including comments — is passed through untouched.
 *
 * For the upsert path we serialize the record via @iarna/toml (a single
 * `[mcp_servers.<name>]` block) and append/replace; this is sufficient for
 * v1 where we don't preserve per-block comments inside MCP blocks (only
 * preserve comments outside them).
 */
import * as toml from '@iarna/toml';

export interface CodexTomlServer {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse';
  description?: string;
}

export class CodexTomlEditor {
  stripMcpServers(input: string): string {
    const lines = input.split('\n');
    const out: string[] = [];
    let skipping = false;
    for (const line of lines) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        skipping = header[1]!.startsWith('mcp_servers.');
      }
      if (!skipping) out.push(line);
    }
    return out.join('\n');
  }

  deleteMcpServer(input: string, name: string): string {
    const lines = input.split('\n');
    const out: string[] = [];
    let skipping = false;
    const target = `mcp_servers.${name}`;
    for (const line of lines) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        skipping = header[1] === target;
      }
      if (!skipping) out.push(line);
    }
    return out.join('\n');
  }

  upsertMcpServer(input: string, name: string, entry: CodexTomlServer): string {
    const stripped = this.deleteMcpServer(input, name);
    const block = toml.stringify({ mcp_servers: { [name]: entry } as any });
    const trimmedInput = stripped.replace(/\n+$/, '');
    return `${trimmedInput}\n\n${block.trimEnd()}\n`;
  }

  parseMcpServers(input: string): Record<string, CodexTomlServer> {
    try {
      const parsed = toml.parse(input) as any;
      return (parsed.mcp_servers ?? {}) as Record<string, CodexTomlServer>;
    } catch {
      return {};
    }
  }
}
```

- [ ] **Step 5: Run editor test, confirm pass**

Run: `npx vitest run src/main/mcp/adapters/__tests__/codex-toml-editor.spec.ts`
Expected: PASS.

- [ ] **Step 6: Write failing adapter test**

Create `src/main/mcp/adapters/__tests__/codex-mcp-adapter.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodexMcpAdapter } from '../codex-mcp-adapter';
import { WriteSafetyHelper } from '../../write-safety-helper';

describe('CodexMcpAdapter', () => {
  let codexHome: string;
  let adapter: CodexMcpAdapter;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-codex-home-'));
    adapter = new CodexMcpAdapter({
      codexHome,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
  });
  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it('readScope(user) parses [mcp_servers.*] from config.toml', async () => {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      `# preserved\nmodel = "gpt-5"\n\n[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y"]\n`,
    );
    const snap = await adapter.readScope('user', path.join(codexHome, 'config.toml'));
    expect(snap.servers.length).toBe(1);
    expect(snap.servers[0]!.name).toBe('fs');
    expect(snap.servers[0]!.command).toBe('npx');
  });

  it('writeUserServer upsert preserves comments + unrelated keys', async () => {
    const configPath = path.join(codexHome, 'config.toml');
    fs.writeFileSync(configPath, `# hello\nmodel = "gpt-5"\n`);
    await adapter.writeUserServer({
      kind: 'upsert',
      record: {
        id: 'gh', name: 'gh',
        transport: 'stdio', command: 'npx', args: ['-y'],
        autoConnect: true, createdAt: 1, updatedAt: 1,
      },
      sourceFile: configPath,
    });
    const out = fs.readFileSync(configPath, 'utf8');
    expect(out).toContain('# hello');
    expect(out).toContain('model = "gpt-5"');
    expect(out).toMatch(/\[mcp_servers\.gh\]/);
  });
});
```

- [ ] **Step 7: Run and see it fail**

Run: `npx vitest run src/main/mcp/adapters/__tests__/codex-mcp-adapter.spec.ts`
Expected: FAIL.

- [ ] **Step 8: Implement `codex-mcp-adapter.ts`**

Create `src/main/mcp/adapters/codex-mcp-adapter.ts`:

```typescript
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ProviderMcpAdapter,
  ProviderScopeSnapshot,
} from './provider-mcp-adapter.types';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import type { WriteSafetyHelper } from '../write-safety-helper';
import { CodexTomlEditor, type CodexTomlServer } from './codex-toml-editor';

export class CodexMcpAdapter implements ProviderMcpAdapter {
  readonly provider: SupportedProvider = 'codex';
  private readonly editor = new CodexTomlEditor();

  constructor(
    private readonly deps: {
      codexHome: string;
      writeSafety: WriteSafetyHelper;
    },
  ) {}

  async discoverScopes(_opts: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }> {
    return {
      cliAvailable: true,
      scopeFiles: { user: path.join(this.deps.codexHome, 'config.toml') },
    };
  }

  async readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot> {
    if (!fs.existsSync(filePath)) return { scope, sourceFile: filePath, servers: [] };
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = this.editor.parseMcpServers(raw);
    const now = Date.now();
    const servers: RawMcpRecord[] = Object.entries(parsed).map(([name, entry]) => ({
      id: `codex-user:${name}`,
      name,
      transport: (entry.transport === 'sse' ? 'sse' : 'stdio'),
      command: entry.command,
      args: entry.args,
      url: entry.url,
      env: entry.env,
      description: entry.description,
      autoConnect: true,
      createdAt: now,
      updatedAt: now,
    }));
    return { scope, sourceFile: filePath, servers };
  }

  async writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void> {
    const existing = fs.existsSync(op.sourceFile) ? await fsp.readFile(op.sourceFile, 'utf8') : '';
    let next: string;
    if (op.kind === 'upsert') {
      const entry: CodexTomlServer = {
        command: op.record.command,
        args: op.record.args,
        env: op.record.env,
        url: op.record.url,
        description: op.record.description,
      };
      if (op.record.transport === 'sse') entry.transport = 'sse';
      next = this.editor.upsertMcpServer(existing, op.record.name, entry);
    } else {
      next = this.editor.deleteMcpServer(existing, op.serverId);
    }
    await this.deps.writeSafety.writeAtomic(op.sourceFile, next);
  }
}
```

- [ ] **Step 9: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/adapters/__tests__/codex-toml-editor.spec.ts src/main/mcp/adapters/__tests__/codex-mcp-adapter.spec.ts
npx tsc --noEmit
git add package.json package-lock.json \
  src/main/mcp/adapters/codex-toml-editor.ts \
  src/main/mcp/adapters/codex-mcp-adapter.ts \
  src/main/mcp/adapters/__tests__/codex-toml-editor.spec.ts \
  src/main/mcp/adapters/__tests__/codex-mcp-adapter.spec.ts
git commit -m "feat(mcp): Codex adapter with comment-preserving TOML editor"
```

---

## Task 1.6: Gemini adapter

**Context:** Gemini CLI reads `~/.gemini/settings.json` (user) + `<cwd>/.gemini/settings.json` (project). JSON with top-level `mcpServers` map matching Claude's shape.

**Files:**
- Create: `src/main/mcp/adapters/gemini-mcp-adapter.ts`
- Test: `src/main/mcp/adapters/__tests__/gemini-mcp-adapter.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/adapters/__tests__/gemini-mcp-adapter.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GeminiMcpAdapter } from '../gemini-mcp-adapter';
import { WriteSafetyHelper } from '../../write-safety-helper';

describe('GeminiMcpAdapter', () => {
  let home: string;
  let cwd: string;
  let adapter: GeminiMcpAdapter;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-gemini-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-gemini-cwd-'));
    adapter = new GeminiMcpAdapter({
      home,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('discoverScopes exposes user and project scope paths', async () => {
    const res = await adapter.discoverScopes({ cwd });
    expect(res.scopeFiles.user).toBe(path.join(home, '.gemini', 'settings.json'));
    expect(res.scopeFiles.project).toBe(path.join(cwd, '.gemini', 'settings.json'));
  });

  it('writeUserServer creates the settings file when missing', async () => {
    const target = path.join(home, '.gemini', 'settings.json');
    await adapter.writeUserServer({
      kind: 'upsert',
      record: {
        id: 'fs', name: 'fs', transport: 'stdio', command: 'npx', args: ['x'],
        autoConnect: true, createdAt: 1, updatedAt: 1,
      },
      sourceFile: target,
    });
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.mcpServers.fs.command).toBe('npx');
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/adapters/__tests__/gemini-mcp-adapter.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `gemini-mcp-adapter.ts`**

Create `src/main/mcp/adapters/gemini-mcp-adapter.ts`:

```typescript
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ProviderMcpAdapter,
  ProviderScopeSnapshot,
} from './provider-mcp-adapter.types';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import type { WriteSafetyHelper } from '../write-safety-helper';

export class GeminiMcpAdapter implements ProviderMcpAdapter {
  readonly provider: SupportedProvider = 'gemini';

  constructor(
    private readonly deps: {
      home: string;
      writeSafety: WriteSafetyHelper;
    },
  ) {}

  async discoverScopes(opts: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }> {
    return {
      cliAvailable: true,
      scopeFiles: {
        user: path.join(this.deps.home, '.gemini', 'settings.json'),
        project: path.join(opts.cwd, '.gemini', 'settings.json'),
      },
    };
  }

  async readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot> {
    if (!fs.existsSync(filePath)) return { scope, sourceFile: filePath, servers: [] };
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    const raw = parsed.mcpServers ?? {};
    const now = Date.now();
    const servers: RawMcpRecord[] = Object.entries(raw).map(([name, entry]: [string, any]) => ({
      id: `gemini-${scope}:${name}`,
      name,
      transport: entry.transport === 'sse' ? 'sse' : 'stdio',
      command: entry.command,
      args: entry.args,
      url: entry.url,
      env: entry.env,
      description: entry.description,
      autoConnect: entry.autoConnect !== false,
      createdAt: now,
      updatedAt: now,
    }));
    return { scope, sourceFile: filePath, servers };
  }

  async writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void> {
    const exists = fs.existsSync(op.sourceFile);
    const current = exists ? JSON.parse(await fsp.readFile(op.sourceFile, 'utf8')) : {};
    const mcpServers = { ...(current.mcpServers ?? {}) };
    if (op.kind === 'upsert') {
      mcpServers[op.record.name] = this.serialize(op.record);
    } else {
      delete mcpServers[op.serverId];
    }
    const next = { ...current, mcpServers };
    await this.deps.writeSafety.writeAtomic(op.sourceFile, JSON.stringify(next, null, 2));
  }

  private serialize(r: RawMcpRecord): Record<string, unknown> {
    const out: Record<string, unknown> = { command: r.command };
    if (r.args) out.args = r.args;
    if (r.env) out.env = r.env;
    if (r.url) out.url = r.url;
    if (r.transport === 'sse') out.transport = 'sse';
    if (r.description) out.description = r.description;
    if (r.autoConnect === false) out.autoConnect = false;
    return out;
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/adapters/__tests__/gemini-mcp-adapter.spec.ts
npx tsc --noEmit
git add src/main/mcp/adapters/gemini-mcp-adapter.ts src/main/mcp/adapters/__tests__/gemini-mcp-adapter.spec.ts
git commit -m "feat(mcp): Gemini provider adapter"
```

---

## Task 1.7: Copilot adapter

**Context:** GitHub Copilot CLI reads user-scope MCP config from `~/.copilot/mcp-config.json` (shape mirrors Claude). Project scope: `.github/copilot/mcp-config.json`. v1 writes only user.

**Files:**
- Create: `src/main/mcp/adapters/copilot-mcp-adapter.ts`
- Test: `src/main/mcp/adapters/__tests__/copilot-mcp-adapter.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/adapters/__tests__/copilot-mcp-adapter.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CopilotMcpAdapter } from '../copilot-mcp-adapter';
import { WriteSafetyHelper } from '../../write-safety-helper';

describe('CopilotMcpAdapter', () => {
  let home: string;
  let cwd: string;
  let adapter: CopilotMcpAdapter;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-cop-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-cop-cwd-'));
    adapter = new CopilotMcpAdapter({
      home,
      writeSafety: new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true }),
    });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('discoverScopes reports user + project paths', async () => {
    const res = await adapter.discoverScopes({ cwd });
    expect(res.scopeFiles.user).toBe(path.join(home, '.copilot', 'mcp-config.json'));
    expect(res.scopeFiles.project).toBe(path.join(cwd, '.github', 'copilot', 'mcp-config.json'));
  });

  it('readScope returns empty when file missing', async () => {
    const snap = await adapter.readScope('user', path.join(home, '.copilot', 'mcp-config.json'));
    expect(snap.servers).toEqual([]);
  });

  it('writeUserServer creates + mutates user-scope file', async () => {
    const target = path.join(home, '.copilot', 'mcp-config.json');
    await adapter.writeUserServer({
      kind: 'upsert',
      record: { id: 'x', name: 'x', transport: 'stdio', command: 'node', autoConnect: true, createdAt: 1, updatedAt: 1 },
      sourceFile: target,
    });
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.mcpServers.x.command).toBe('node');
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/adapters/__tests__/copilot-mcp-adapter.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `copilot-mcp-adapter.ts`**

Create `src/main/mcp/adapters/copilot-mcp-adapter.ts`:

```typescript
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ProviderMcpAdapter,
  ProviderScopeSnapshot,
} from './provider-mcp-adapter.types';
import type { ProviderMcpScope, SupportedProvider } from '../../../shared/types/mcp-scopes.types';
import type { RawMcpRecord } from '../redaction-service';
import type { WriteSafetyHelper } from '../write-safety-helper';

export class CopilotMcpAdapter implements ProviderMcpAdapter {
  readonly provider: SupportedProvider = 'copilot';

  constructor(private readonly deps: { home: string; writeSafety: WriteSafetyHelper }) {}

  async discoverScopes(opts: { cwd: string }): Promise<{
    cliAvailable: boolean;
    scopeFiles: Partial<Record<ProviderMcpScope, string>>;
  }> {
    return {
      cliAvailable: true,
      scopeFiles: {
        user: path.join(this.deps.home, '.copilot', 'mcp-config.json'),
        project: path.join(opts.cwd, '.github', 'copilot', 'mcp-config.json'),
      },
    };
  }

  async readScope(scope: ProviderMcpScope, filePath: string): Promise<ProviderScopeSnapshot> {
    if (!fs.existsSync(filePath)) return { scope, sourceFile: filePath, servers: [] };
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    const raw = parsed.mcpServers ?? {};
    const now = Date.now();
    const servers: RawMcpRecord[] = Object.entries(raw).map(([name, entry]: [string, any]) => ({
      id: `copilot-${scope}:${name}`,
      name,
      transport: entry.transport === 'sse' ? 'sse' : 'stdio',
      command: entry.command,
      args: entry.args,
      url: entry.url,
      env: entry.env,
      description: entry.description,
      autoConnect: entry.autoConnect !== false,
      createdAt: now,
      updatedAt: now,
    }));
    return { scope, sourceFile: filePath, servers };
  }

  async writeUserServer(op:
    | { kind: 'upsert'; record: RawMcpRecord; sourceFile: string }
    | { kind: 'delete'; serverId: string; sourceFile: string }
  ): Promise<void> {
    const exists = fs.existsSync(op.sourceFile);
    const current = exists ? JSON.parse(await fsp.readFile(op.sourceFile, 'utf8')) : {};
    const mcpServers = { ...(current.mcpServers ?? {}) };
    if (op.kind === 'upsert') {
      mcpServers[op.record.name] = this.serialize(op.record);
    } else {
      delete mcpServers[op.serverId];
    }
    await this.deps.writeSafety.writeAtomic(op.sourceFile, JSON.stringify({ ...current, mcpServers }, null, 2));
  }

  private serialize(r: RawMcpRecord): Record<string, unknown> {
    const out: Record<string, unknown> = { command: r.command };
    if (r.args) out.args = r.args;
    if (r.env) out.env = r.env;
    if (r.url) out.url = r.url;
    if (r.transport === 'sse') out.transport = 'sse';
    if (r.description) out.description = r.description;
    if (r.autoConnect === false) out.autoConnect = false;
    return out;
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/adapters/__tests__/copilot-mcp-adapter.spec.ts
npx tsc --noEmit
git add src/main/mcp/adapters/copilot-mcp-adapter.ts src/main/mcp/adapters/__tests__/copilot-mcp-adapter.spec.ts
git commit -m "feat(mcp): Copilot provider adapter"
```

---

## Task 1.8: `OrchestratorMcpRepository` — sqlite CRUD for Orchestrator-scope servers

**Context:** Spec §4. Owns DB reads/writes for `orchestrator_mcp_servers`. Uses the `McpSecretStorage` wrapper for env-secret columns.

**Files:**
- Create: `src/main/mcp/orchestrator-mcp-repository.ts`
- Test: `src/main/mcp/__tests__/orchestrator-mcp-repository.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/__tests__/orchestrator-mcp-repository.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDb, runMigrations } from '../../persistence/rlm/__tests__/helpers';
import { OrchestratorMcpRepository } from '../orchestrator-mcp-repository';
import { McpSecretStorage } from '../secret-storage';

describe('OrchestratorMcpRepository', () => {
  let db: ReturnType<typeof openMemoryDb>;
  let repo: OrchestratorMcpRepository;

  beforeEach(() => {
    db = openMemoryDb();
    runMigrations(db); // all migrations incl. 015
    const storage = new McpSecretStorage({
      safeStorage: { isEncryptionAvailable: () => false } as any,
    });
    repo = new OrchestratorMcpRepository(db, storage);
  });

  it('upsert + findAll round-trips a record', () => {
    const now = Date.now();
    repo.upsert({
      id: 'o1', name: 'codemem', scope: 'orchestrator-codemem',
      transport: 'stdio', command: 'node', args: ['x.js'],
      autoConnect: true, injectInto: ['claude', 'codex', 'gemini', 'copilot'],
      createdAt: now, updatedAt: now,
    });
    const all = repo.findAll();
    expect(all.length).toBe(1);
    expect(all[0]!.name).toBe('codemem');
    expect(all[0]!.injectInto).toEqual(['claude', 'codex', 'gemini', 'copilot']);
  });

  it('setInjectionTargets updates inject_into only', () => {
    const now = Date.now();
    repo.upsert({
      id: 'o1', name: 'codemem', scope: 'orchestrator-codemem',
      transport: 'stdio', command: 'node',
      autoConnect: true, injectInto: ['claude'],
      createdAt: now, updatedAt: now,
    });
    repo.setInjectionTargets('o1', ['claude', 'gemini']);
    expect(repo.findAll()[0]!.injectInto).toEqual(['claude', 'gemini']);
  });

  it('delete removes by id', () => {
    const now = Date.now();
    repo.upsert({
      id: 'o1', name: 'x', scope: 'orchestrator',
      transport: 'stdio', command: 'x',
      autoConnect: false, injectInto: ['claude'],
      createdAt: now, updatedAt: now,
    });
    repo.delete('o1');
    expect(repo.findAll()).toEqual([]);
  });

  it('stores env secrets via McpSecretStorage (quarantined in this test)', () => {
    const now = Date.now();
    repo.upsert({
      id: 'o1', name: 'x', scope: 'orchestrator',
      transport: 'stdio', command: 'x',
      env: { HOME: '/u', GITHUB_TOKEN: 'secret-value' },
      autoConnect: false, injectInto: ['claude'],
      createdAt: now, updatedAt: now,
    });
    const stored = repo.findAll()[0]!;
    // Plaintext values available (quarantined fallback for this test).
    expect(stored.env?.HOME).toBe('/u');
    expect(stored.env?.GITHUB_TOKEN).toBe('secret-value');
  });
});
```

- [ ] **Step 2: Verify the `openMemoryDb`/`runMigrations` helpers exist**

If `src/main/persistence/rlm/__tests__/helpers.ts` already exports these, proceed. Otherwise add them as a minimal test helper (create the file). The helper wraps `new Database(':memory:')` and runs `MIGRATIONS`.

Run: `grep -n "openMemoryDb\|runMigrations" src/main/persistence/rlm/__tests__/*.ts`
Expected: both names referenced.

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/main/mcp/__tests__/orchestrator-mcp-repository.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement `orchestrator-mcp-repository.ts`**

Create `src/main/mcp/orchestrator-mcp-repository.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { McpSecretStorage, EncryptedSecret } from './secret-storage';
import type { OrchestratorMcpScope } from '../../shared/types/mcp-scopes.types';
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { McpTransport } from '../../shared/types/mcp-orchestrator.types';

export interface OrchestratorMcpRecord {
  id: string;
  name: string;
  description?: string;
  scope: OrchestratorMcpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  autoConnect: boolean;
  injectInto: readonly SupportedProvider[];
  createdAt: number;
  updatedAt: number;
}

export class OrchestratorMcpRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: McpSecretStorage,
  ) {}

  upsert(rec: OrchestratorMcpRecord): void {
    const { encryptedEnvJson, plainEnvJson } = this.splitEnv(rec.env);
    this.db
      .prepare(
        `INSERT INTO orchestrator_mcp_servers
          (id, name, description, scope, transport, command, args_json, url, env_json, env_secrets_encrypted_json, auto_connect, inject_into_json, created_at, updated_at)
        VALUES (@id, @name, @description, @scope, @transport, @command, @args_json, @url, @env_json, @enc_env_json, @auto_connect, @inject_into_json, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          scope = excluded.scope,
          transport = excluded.transport,
          command = excluded.command,
          args_json = excluded.args_json,
          url = excluded.url,
          env_json = excluded.env_json,
          env_secrets_encrypted_json = excluded.env_secrets_encrypted_json,
          auto_connect = excluded.auto_connect,
          inject_into_json = excluded.inject_into_json,
          updated_at = excluded.updated_at`,
      )
      .run({
        id: rec.id,
        name: rec.name,
        description: rec.description ?? null,
        scope: rec.scope,
        transport: rec.transport,
        command: rec.command ?? null,
        args_json: rec.args ? JSON.stringify(rec.args) : null,
        url: rec.url ?? null,
        env_json: plainEnvJson,
        enc_env_json: encryptedEnvJson,
        auto_connect: rec.autoConnect ? 1 : 0,
        inject_into_json: JSON.stringify(rec.injectInto),
        created_at: rec.createdAt,
        updated_at: rec.updatedAt,
      });
  }

  findAll(): readonly OrchestratorMcpRecord[] {
    const rows = this.db.prepare(`SELECT * FROM orchestrator_mcp_servers`).all() as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM orchestrator_mcp_servers WHERE id = ?`).run(id);
  }

  setInjectionTargets(id: string, providers: readonly SupportedProvider[]): void {
    this.db
      .prepare(`UPDATE orchestrator_mcp_servers SET inject_into_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(providers), Date.now(), id);
  }

  private splitEnv(env?: Record<string, string>): {
    plainEnvJson: string | null;
    encryptedEnvJson: string | null;
  } {
    if (!env) return { plainEnvJson: null, encryptedEnvJson: null };
    const plain: Record<string, string> = {};
    const enc: Record<string, EncryptedSecret> = {};
    for (const [k, v] of Object.entries(env)) {
      if (this.shouldEncrypt(k, v)) {
        enc[k] = this.secrets.encryptSecret(v);
      } else {
        plain[k] = v;
      }
    }
    return {
      plainEnvJson: Object.keys(plain).length ? JSON.stringify(plain) : null,
      encryptedEnvJson: Object.keys(enc).length ? JSON.stringify(enc) : null,
    };
  }

  private shouldEncrypt(key: string, value: string): boolean {
    // Repository does not own classification policy; the service layer calling
    // upsert() should have already decided which values belong to `env` vs not.
    // Here we only encrypt values that *look* secret-y; conservative is fine.
    return /(TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER)/i.test(key) && value.length > 0;
  }

  private rowToRecord(row: any): OrchestratorMcpRecord {
    const plainEnv: Record<string, string> = row.env_json ? JSON.parse(row.env_json) : {};
    const encEnv: Record<string, EncryptedSecret> = row.env_secrets_encrypted_json
      ? JSON.parse(row.env_secrets_encrypted_json)
      : {};
    const env: Record<string, string> = { ...plainEnv };
    for (const [k, v] of Object.entries(encEnv)) {
      try {
        env[k] = this.secrets.decryptSecret(v);
      } catch {
        env[k] = '•••';
      }
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      scope: row.scope,
      transport: row.transport,
      command: row.command ?? undefined,
      args: row.args_json ? JSON.parse(row.args_json) : undefined,
      url: row.url ?? undefined,
      env: Object.keys(env).length ? env : undefined,
      autoConnect: row.auto_connect === 1,
      injectInto: JSON.parse(row.inject_into_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
```

- [ ] **Step 5: Run test + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/orchestrator-mcp-repository.spec.ts
npx tsc --noEmit
git add src/main/mcp/orchestrator-mcp-repository.ts src/main/mcp/__tests__/orchestrator-mcp-repository.spec.ts
git commit -m "feat(mcp): OrchestratorMcpRepository (sqlite CRUD)"
```

---

## Task 1.9: `SharedMcpRepository` — sqlite CRUD for Shared-scope servers

**Files:**
- Create: `src/main/mcp/shared-mcp-repository.ts`
- Test: `src/main/mcp/__tests__/shared-mcp-repository.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/__tests__/shared-mcp-repository.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDb, runMigrations } from '../../persistence/rlm/__tests__/helpers';
import { SharedMcpRepository } from '../shared-mcp-repository';
import { McpSecretStorage } from '../secret-storage';

describe('SharedMcpRepository', () => {
  let db: ReturnType<typeof openMemoryDb>;
  let repo: SharedMcpRepository;

  beforeEach(() => {
    db = openMemoryDb();
    runMigrations(db); // incl. 016
    const storage = new McpSecretStorage({
      safeStorage: { isEncryptionAvailable: () => false } as any,
    });
    repo = new SharedMcpRepository(db, storage);
  });

  it('upsert + findAll round-trips with targets_json', () => {
    const now = Date.now();
    repo.upsert({
      id: 's1', name: 'filesystem', transport: 'stdio',
      command: 'npx', args: ['-y', '@mcp/server-fs'],
      targets: ['claude', 'codex'],
      createdAt: now, updatedAt: now,
    });
    const all = repo.findAll();
    expect(all.length).toBe(1);
    expect(all[0]!.targets).toEqual(['claude', 'codex']);
  });

  it('delete removes by id', () => {
    const now = Date.now();
    repo.upsert({ id: 's1', name: 'x', transport: 'stdio', command: 'x', targets: ['claude'], createdAt: now, updatedAt: now });
    repo.delete('s1');
    expect(repo.findAll()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/shared-mcp-repository.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `shared-mcp-repository.ts`**

Create `src/main/mcp/shared-mcp-repository.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { McpSecretStorage, EncryptedSecret } from './secret-storage';
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { McpTransport } from '../../shared/types/mcp-orchestrator.types';

export interface SharedMcpRecord {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  targets: readonly SupportedProvider[];
  createdAt: number;
  updatedAt: number;
}

export class SharedMcpRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly secrets: McpSecretStorage,
  ) {}

  upsert(rec: SharedMcpRecord): void {
    const { plainEnvJson, encryptedEnvJson } = this.splitEnv(rec.env);
    this.db
      .prepare(
        `INSERT INTO shared_mcp_servers
          (id, name, description, transport, command, args_json, url, env_json, env_secrets_encrypted_json, targets_json, created_at, updated_at)
        VALUES (@id, @name, @description, @transport, @command, @args_json, @url, @env_json, @enc_env_json, @targets_json, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          transport = excluded.transport,
          command = excluded.command,
          args_json = excluded.args_json,
          url = excluded.url,
          env_json = excluded.env_json,
          env_secrets_encrypted_json = excluded.env_secrets_encrypted_json,
          targets_json = excluded.targets_json,
          updated_at = excluded.updated_at`,
      )
      .run({
        id: rec.id,
        name: rec.name,
        description: rec.description ?? null,
        transport: rec.transport,
        command: rec.command ?? null,
        args_json: rec.args ? JSON.stringify(rec.args) : null,
        url: rec.url ?? null,
        env_json: plainEnvJson,
        enc_env_json: encryptedEnvJson,
        targets_json: JSON.stringify(rec.targets),
        created_at: rec.createdAt,
        updated_at: rec.updatedAt,
      });
  }

  findAll(): readonly SharedMcpRecord[] {
    const rows = this.db.prepare(`SELECT * FROM shared_mcp_servers`).all() as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  findById(id: string): SharedMcpRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM shared_mcp_servers WHERE id = ?`).get(id) as any;
    return row ? this.rowToRecord(row) : undefined;
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM shared_mcp_servers WHERE id = ?`).run(id);
  }

  private splitEnv(env?: Record<string, string>): {
    plainEnvJson: string | null;
    encryptedEnvJson: string | null;
  } {
    if (!env) return { plainEnvJson: null, encryptedEnvJson: null };
    const plain: Record<string, string> = {};
    const enc: Record<string, EncryptedSecret> = {};
    for (const [k, v] of Object.entries(env)) {
      if (/(TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER)/i.test(k)) {
        enc[k] = this.secrets.encryptSecret(v);
      } else {
        plain[k] = v;
      }
    }
    return {
      plainEnvJson: Object.keys(plain).length ? JSON.stringify(plain) : null,
      encryptedEnvJson: Object.keys(enc).length ? JSON.stringify(enc) : null,
    };
  }

  private rowToRecord(row: any): SharedMcpRecord {
    const plainEnv: Record<string, string> = row.env_json ? JSON.parse(row.env_json) : {};
    const encEnv: Record<string, EncryptedSecret> = row.env_secrets_encrypted_json
      ? JSON.parse(row.env_secrets_encrypted_json)
      : {};
    const env: Record<string, string> = { ...plainEnv };
    for (const [k, v] of Object.entries(encEnv)) {
      try { env[k] = this.secrets.decryptSecret(v); } catch { env[k] = '•••'; }
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      transport: row.transport,
      command: row.command ?? undefined,
      args: row.args_json ? JSON.parse(row.args_json) : undefined,
      url: row.url ?? undefined,
      env: Object.keys(env).length ? env : undefined,
      targets: JSON.parse(row.targets_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/shared-mcp-repository.spec.ts
npx tsc --noEmit
git add src/main/mcp/shared-mcp-repository.ts src/main/mcp/__tests__/shared-mcp-repository.spec.ts
git commit -m "feat(mcp): SharedMcpRepository (sqlite CRUD)"
```

---

## Task 1.10: `OrchestratorInjectionReader` — spawn-time injection bundle builder

**Context:** Spec §4 / §12. Pure read-side service. Given a provider + cwd, returns an `McpInjectionBundle` combining:
- Codemem MCP config (from `src/main/codemem/mcp-config.ts` — already exists)
- Any Orchestrator-scope records whose `inject_into` includes the provider
- The bootstrap file from `config/mcp-servers.json`

**Files:**
- Create: `src/main/mcp/orchestrator-injection-reader.ts`
- Test: `src/main/mcp/__tests__/orchestrator-injection-reader.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/__tests__/orchestrator-injection-reader.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorInjectionReader } from '../orchestrator-injection-reader';

describe('OrchestratorInjectionReader', () => {
  let reader: OrchestratorInjectionReader;

  const fakeRepo = {
    findAll: () => ([
      {
        id: 'o1', name: 'codemem', scope: 'orchestrator-codemem' as const,
        transport: 'stdio' as const, command: 'node', args: ['codemem.js'],
        autoConnect: true, injectInto: ['claude', 'codex'] as const,
        createdAt: 1, updatedAt: 1,
      },
      {
        id: 'o2', name: 'bootstrap', scope: 'orchestrator-bootstrap' as const,
        transport: 'stdio' as const, command: 'node', args: ['b.js'],
        autoConnect: true, injectInto: ['gemini'] as const,
        createdAt: 1, updatedAt: 1,
      },
    ]),
  } as any;

  beforeEach(() => {
    reader = new OrchestratorInjectionReader({
      repo: fakeRepo,
      bootstrapPath: '/path/to/mcp-servers.json',
    });
  });

  it('filters by target provider', () => {
    const claude = reader.buildBundle('claude');
    expect(claude.inlineConfigs.length).toBe(1);
    expect(claude.inlineConfigs[0]).toContain('codemem');

    const gemini = reader.buildBundle('gemini');
    expect(gemini.inlineConfigs.length).toBe(1);
    expect(gemini.inlineConfigs[0]).toContain('bootstrap');
  });

  it('includes bootstrap path in configPaths when present', () => {
    const b = reader.buildBundle('claude');
    expect(b.configPaths).toContain('/path/to/mcp-servers.json');
  });

  it('omits bootstrap path when not configured', () => {
    const r = new OrchestratorInjectionReader({ repo: fakeRepo, bootstrapPath: null });
    expect(r.buildBundle('claude').configPaths).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/orchestrator-injection-reader.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `orchestrator-injection-reader.ts`**

Create `src/main/mcp/orchestrator-injection-reader.ts`:

```typescript
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { McpInjectionBundle } from '../../shared/types/mcp-orchestrator.types';
import type { OrchestratorMcpRepository, OrchestratorMcpRecord } from './orchestrator-mcp-repository';

export class OrchestratorInjectionReader {
  constructor(
    private readonly deps: {
      repo: Pick<OrchestratorMcpRepository, 'findAll'>;
      /** Absolute path to config/mcp-servers.json, or null if packaged app had none. */
      bootstrapPath: string | null;
    },
  ) {}

  buildBundle(provider: SupportedProvider): McpInjectionBundle {
    const records = this.deps.repo.findAll().filter(r => r.injectInto.includes(provider));
    const inline = records.map(r => this.serializeInline(r));
    const configPaths: string[] = this.deps.bootstrapPath ? [this.deps.bootstrapPath] : [];
    return { configPaths, inlineConfigs: inline };
  }

  private serializeInline(r: OrchestratorMcpRecord): string {
    const server: Record<string, unknown> = { command: r.command };
    if (r.args) server.args = r.args;
    if (r.env) server.env = r.env;
    if (r.url) server.url = r.url;
    if (r.transport === 'sse') server.transport = 'sse';
    return JSON.stringify({ mcpServers: { [r.name]: server } });
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/orchestrator-injection-reader.spec.ts
npx tsc --noEmit
git add src/main/mcp/orchestrator-injection-reader.ts src/main/mcp/__tests__/orchestrator-injection-reader.spec.ts
git commit -m "feat(mcp): OrchestratorInjectionReader for spawn-time config fan-in"
```

---

## Task 1.11: Replace Codex `prepareCleanCodexHome` string-strip with `CodexTomlEditor.stripMcpServers`

**Context:** Spec §5. Existing `stripMcpServers()` in `src/main/cli/adapters/codex-cli-adapter.ts` is a fragile regex. Replace with the new editor's comment-preserving version.

**Files:**
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts` (method `stripMcpServers` around line 2882 region)
- Modify: `src/main/cli/adapters/__tests__/codex-cli-adapter.spec.ts` (add regression test)

- [ ] **Step 1: Add regression test**

Append to `src/main/cli/adapters/__tests__/codex-cli-adapter.spec.ts`:

```typescript
it('prepareCleanCodexHome preserves user comments in stripped config.toml', async () => {
  // Use the real adapter's private stripMcpServers via the CodexTomlEditor.
  const { CodexTomlEditor } = await import('../../mcp/adapters/codex-toml-editor');
  const editor = new CodexTomlEditor();
  const input = `# IMPORTANT — keep me\nmodel = "gpt-5"\n\n[mcp_servers.x]\ncommand = "x"\n`;
  expect(editor.stripMcpServers(input)).toContain('# IMPORTANT — keep me');
});
```

- [ ] **Step 2: Edit `codex-cli-adapter.ts`**

Locate `stripMcpServers(contents: string)` (the private method around line 2882 — use `grep -n stripMcpServers src/main/cli/adapters/codex-cli-adapter.ts`). Replace its body with:

```typescript
private stripMcpServers(contents: string): string {
  // Delegates to the shared comment-preserving editor.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CodexTomlEditor } = require('../../mcp/adapters/codex-toml-editor');
  return new CodexTomlEditor().stripMcpServers(contents);
}
```

(Import at top of file instead of require if you prefer; the lazy require is used here to match the existing pattern in `codex-cli-adapter.ts` for main-only deps.)

- [ ] **Step 3: Run the relevant Codex adapter tests**

Run: `npx vitest run src/main/cli/adapters/__tests__/codex-cli-adapter.spec.ts`
Expected: all PASS (including the new comment-preservation assertion).

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/main/cli/adapters/codex-cli-adapter.ts src/main/cli/adapters/__tests__/codex-cli-adapter.spec.ts
git commit -m "refactor(codex): swap regex-based stripMcpServers for comment-preserving TOML editor"
```

---

## Task 1.12: Wire `OrchestratorInjectionReader` into `InstanceLifecycleManager.buildMcpConfigPaths`

**Context:** Existing `buildMcpConfigPaths()` in `src/main/instance/instance-lifecycle.ts` (around line 295) currently returns the hardcoded `MCP_CONFIG_PATH` + codemem inline JSON. Migrate it to delegate to the injection reader so Orchestrator-scope servers are picked up at spawn time.

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` (method `buildMcpConfigPaths` around line 295–335)
- Modify: `src/main/index.ts` (construct reader + repository once during init)
- Test: `src/main/instance/__tests__/instance-lifecycle.spec.ts`

- [ ] **Step 1: Write failing test**

Append to `src/main/instance/__tests__/instance-lifecycle.spec.ts` (or create the file if missing and import existing setup):

```typescript
it('buildMcpConfigPaths includes orchestrator-scope inline configs for the target provider', async () => {
  const lifecycle = new InstanceLifecycleManager({
    /* ...existing deps... */
    injectionReader: {
      buildBundle: (provider: string) => ({
        configPaths: ['/tmp/bootstrap.json'],
        inlineConfigs: [`{"mcpServers":{"${provider}-server":{"command":"x"}}}`],
      }),
    } as any,
  });
  const { paths, inline } = await (lifecycle as any).buildMcpConfigPaths('claude');
  expect(paths).toContain('/tmp/bootstrap.json');
  expect(inline.join(' ')).toContain('claude-server');
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/instance/__tests__/instance-lifecycle.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Edit `instance-lifecycle.ts`**

Inject the reader through the constructor. In the constructor options type, add:

```typescript
injectionReader: OrchestratorInjectionReader;
```

Replace the body of `buildMcpConfigPaths(provider: SupportedProvider)` (the existing inline-JSON + bootstrap composition) with:

```typescript
private buildMcpConfigPaths(provider: SupportedProvider): { paths: string[]; inline: string[] } {
  const bundle = this.deps.injectionReader.buildBundle(provider);
  return {
    paths: [...bundle.configPaths],
    inline: [...bundle.inlineConfigs],
  };
}
```

Preserve the codemem-JSON inline config by ensuring the `OrchestratorMcpRepository` seed (Task 2.x) writes a row with `scope = 'orchestrator-codemem'` — remove the ad-hoc `buildCodememMcpConfig()` call from this path.

- [ ] **Step 4: Construct reader in `src/main/index.ts`**

Near the block that builds `InstanceLifecycleManager`, add:

```typescript
const orchestratorMcpRepo = new OrchestratorMcpRepository(rlmDb, getMcpSecretStorage());
const injectionReader = new OrchestratorInjectionReader({
  repo: orchestratorMcpRepo,
  bootstrapPath: getBootstrapMcpConfigPath(), // existing helper resolving MCP_CONFIG_PATH
});
```

Pass `injectionReader` into the `InstanceLifecycleManager` constructor options.

- [ ] **Step 5: Run test + typecheck + commit**

```bash
npx vitest run src/main/instance/__tests__/instance-lifecycle.spec.ts
npx tsc --noEmit
git add src/main/instance/instance-lifecycle.ts src/main/instance/__tests__/instance-lifecycle.spec.ts src/main/index.ts
git commit -m "feat(mcp): wire OrchestratorInjectionReader into instance-lifecycle"
```

---

# Phase 2 — Service Orchestration + IPC + Renderer Store

Goal: glue the main-process building blocks into a `McpMultiProviderService` with IPC surface, wire fs watchers for drift detection, and expose state to the renderer via a signals-based store.

## Task 2.1: `CliMcpConfigService` — per-provider orchestrator

**Context:** Spec §11. Single-entry main-process service that owns provider adapters + repositories + injection reader. Renderer IPC handlers talk only to this service.

**Files:**
- Create: `src/main/mcp/cli-mcp-config-service.ts`
- Test: `src/main/mcp/__tests__/cli-mcp-config-service.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/__tests__/cli-mcp-config-service.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CliMcpConfigService } from '../cli-mcp-config-service';
import { openMemoryDb, runMigrations } from '../../persistence/rlm/__tests__/helpers';
import { McpSecretStorage } from '../secret-storage';
import { WriteSafetyHelper } from '../write-safety-helper';
import { SecretClassifier } from '../secret-classifier';
import { RedactionService } from '../redaction-service';
import { ClaudeMcpAdapter } from '../adapters/claude-mcp-adapter';
import { GeminiMcpAdapter } from '../adapters/gemini-mcp-adapter';
import { CodexMcpAdapter } from '../adapters/codex-mcp-adapter';
import { CopilotMcpAdapter } from '../adapters/copilot-mcp-adapter';
import { OrchestratorMcpRepository } from '../orchestrator-mcp-repository';
import { SharedMcpRepository } from '../shared-mcp-repository';

describe('CliMcpConfigService', () => {
  let home: string;
  let svc: CliMcpConfigService;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-svc-'));
    const db = openMemoryDb();
    runMigrations(db);
    const secrets = new McpSecretStorage({ safeStorage: { isEncryptionAvailable: () => false } as any });
    const writeSafety = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true });
    svc = new CliMcpConfigService({
      adapters: {
        claude: new ClaudeMcpAdapter({ home, writeSafety }),
        codex: new CodexMcpAdapter({ codexHome: path.join(home, '.codex'), writeSafety }),
        gemini: new GeminiMcpAdapter({ home, writeSafety }),
        copilot: new CopilotMcpAdapter({ home, writeSafety }),
      },
      orchestratorRepo: new OrchestratorMcpRepository(db, secrets),
      sharedRepo: new SharedMcpRepository(db, secrets),
      redaction: new RedactionService(new SecretClassifier()),
      cwdProvider: () => home,
    });
  });

  it('getMultiProviderState returns a DTO with four provider tabs + empty orchestrator/shared arrays', async () => {
    const state = await svc.getMultiProviderState();
    expect(state.providers.map(p => p.provider).sort()).toEqual(
      ['claude', 'codex', 'copilot', 'gemini'],
    );
    expect(state.orchestrator).toEqual([]);
    expect(state.shared).toEqual([]);
    expect(state.stateVersion).toBeTypeOf('number');
  });

  it('upsertProviderUser writes to the correct provider adapter', async () => {
    await svc.upsertProviderUser('claude', {
      name: 'fs', transport: 'stdio', command: 'npx', args: ['-y'],
    });
    const state = await svc.getMultiProviderState();
    const claudeTab = state.providers.find(p => p.provider === 'claude')!;
    expect(claudeTab.servers.some(s => s.name === 'fs' && s.scope === 'user')).toBe(true);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/cli-mcp-config-service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `cli-mcp-config-service.ts`**

Create `src/main/mcp/cli-mcp-config-service.ts`:

```typescript
import type {
  SupportedProvider,
  ProviderMcpScope,
} from '../../shared/types/mcp-scopes.types';
import type {
  McpMultiProviderStateDto,
  ProviderTabDto,
  OrchestratorMcpDto,
  SharedMcpDto,
} from '../../shared/types/mcp-dtos.types';
import type { ProviderMcpAdapter } from './adapters/provider-mcp-adapter.types';
import type { OrchestratorMcpRepository } from './orchestrator-mcp-repository';
import type { SharedMcpRepository } from './shared-mcp-repository';
import type { RedactionService } from './redaction-service';

export interface UpsertProviderUserInput {
  id?: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export class CliMcpConfigService {
  private stateVersion = 0;

  constructor(
    private readonly deps: {
      adapters: Record<SupportedProvider, ProviderMcpAdapter>;
      orchestratorRepo: OrchestratorMcpRepository;
      sharedRepo: SharedMcpRepository;
      redaction: RedactionService;
      cwdProvider: () => string;
    },
  ) {}

  async getMultiProviderState(): Promise<McpMultiProviderStateDto> {
    const cwd = this.deps.cwdProvider();
    const providers: ProviderTabDto[] = [];
    for (const p of ['claude', 'codex', 'gemini', 'copilot'] as const) {
      providers.push(await this.readProviderTab(p, cwd));
    }
    const orchestrator = this.deps.orchestratorRepo.findAll().map(r => this.toOrchestratorDto(r));
    const shared = this.deps.sharedRepo.findAll().map(r => this.toSharedDto(r));
    return {
      providers,
      orchestrator,
      shared,
      stateVersion: this.stateVersion,
    };
  }

  async upsertProviderUser(provider: SupportedProvider, input: UpsertProviderUserInput): Promise<void> {
    const adapter = this.deps.adapters[provider];
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    const sourceFile = discovery.scopeFiles.user!;
    const now = Date.now();
    await adapter.writeUserServer({
      kind: 'upsert',
      sourceFile,
      record: {
        id: input.id ?? `${provider}-user:${input.name}`,
        name: input.name,
        description: input.description,
        transport: input.transport,
        command: input.command,
        args: input.args,
        url: input.url,
        env: input.env,
        autoConnect: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    this.stateVersion += 1;
  }

  async deleteProviderUser(provider: SupportedProvider, serverId: string): Promise<void> {
    const adapter = this.deps.adapters[provider];
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    const sourceFile = discovery.scopeFiles.user!;
    await adapter.writeUserServer({ kind: 'delete', serverId, sourceFile });
    this.stateVersion += 1;
  }

  async openScopeFile(provider: SupportedProvider, scope: ProviderMcpScope): Promise<string | undefined> {
    const adapter = this.deps.adapters[provider];
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    return discovery.scopeFiles[scope];
  }

  bumpStateVersion(): number {
    this.stateVersion += 1;
    return this.stateVersion;
  }

  private async readProviderTab(provider: SupportedProvider, cwd: string): Promise<ProviderTabDto> {
    const adapter = this.deps.adapters[provider];
    const discovery = await adapter.discoverScopes({ cwd });
    const dtos: ProviderTabDto['servers'] = [];
    for (const [scope, filePath] of Object.entries(discovery.scopeFiles) as [ProviderMcpScope, string][]) {
      const snap = await adapter.readScope(scope, filePath);
      for (const raw of snap.servers) {
        dtos.push(this.deps.redaction.redact(raw, {
          scope,
          readOnly: scope !== 'user',
          sourceFile: snap.sourceFile,
        }));
      }
    }
    return { provider, cliAvailable: discovery.cliAvailable, servers: dtos };
  }

  private toOrchestratorDto(r: any): OrchestratorMcpDto {
    const redacted = this.deps.redaction.redact(r, { scope: r.scope, readOnly: false });
    return {
      record: { ...redacted, scope: r.scope, readOnly: false },
      injectInto: r.injectInto,
    };
  }

  private toSharedDto(r: any): SharedMcpDto {
    const redacted = this.deps.redaction.redact(r, { scope: 'shared' as any, readOnly: false, sharedTargets: r.targets });
    // targets[] drift states are populated by SharedMcpCoordinator (Task 2.3).
    return {
      record: { ...redacted, scope: 'shared', readOnly: false },
      targets: r.targets.map((p: any) => ({ provider: p, state: 'in-sync' as const })),
    };
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/cli-mcp-config-service.spec.ts
npx tsc --noEmit
git add src/main/mcp/cli-mcp-config-service.ts src/main/mcp/__tests__/cli-mcp-config-service.spec.ts
git commit -m "feat(mcp): CliMcpConfigService — per-provider orchestrator"
```

---

## Task 2.2: `SharedMcpCoordinator` — fan-out writes + drift detection

**Context:** Spec §8/§9. Owns the fan-out algorithm: given a shared record + target list, serialize canonical JSON, compare against each target's current entry, write where divergent, return per-target drift statuses.

**Files:**
- Create: `src/main/mcp/shared-mcp-coordinator.ts`
- Test: `src/main/mcp/__tests__/shared-mcp-coordinator.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/__tests__/shared-mcp-coordinator.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SharedMcpCoordinator } from '../shared-mcp-coordinator';
import { SharedMcpRepository } from '../shared-mcp-repository';
import { ClaudeMcpAdapter } from '../adapters/claude-mcp-adapter';
import { GeminiMcpAdapter } from '../adapters/gemini-mcp-adapter';
import { CodexMcpAdapter } from '../adapters/codex-mcp-adapter';
import { CopilotMcpAdapter } from '../adapters/copilot-mcp-adapter';
import { WriteSafetyHelper } from '../write-safety-helper';
import { McpSecretStorage } from '../secret-storage';
import { openMemoryDb, runMigrations } from '../../persistence/rlm/__tests__/helpers';

describe('SharedMcpCoordinator', () => {
  let home: string;
  let coord: SharedMcpCoordinator;
  let repo: SharedMcpRepository;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-shared-'));
    const db = openMemoryDb();
    runMigrations(db);
    const secrets = new McpSecretStorage({ safeStorage: { isEncryptionAvailable: () => false } as any });
    repo = new SharedMcpRepository(db, secrets);
    const writeSafety = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true });
    coord = new SharedMcpCoordinator({
      repo,
      adapters: {
        claude: new ClaudeMcpAdapter({ home, writeSafety }),
        codex: new CodexMcpAdapter({ codexHome: path.join(home, '.codex'), writeSafety }),
        gemini: new GeminiMcpAdapter({ home, writeSafety }),
        copilot: new CopilotMcpAdapter({ home, writeSafety }),
      },
      cwdProvider: () => home,
    });
  });

  it('fanOut writes to each listed target + reports in-sync', async () => {
    const now = Date.now();
    repo.upsert({
      id: 's1', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y'],
      targets: ['claude', 'gemini'],
      createdAt: now, updatedAt: now,
    });
    const result = await coord.fanOut('s1');
    expect(result.map(r => r.state).every(s => s === 'in-sync')).toBe(true);
    // Files should exist:
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.gemini', 'settings.json'))).toBe(true);
  });

  it('getDrift reports drifted when a provider has a divergent entry', async () => {
    const now = Date.now();
    repo.upsert({
      id: 's1', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y'],
      targets: ['claude'],
      createdAt: now, updatedAt: now,
    });
    await coord.fanOut('s1');
    // Hand-edit the file to simulate drift:
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { fs: { command: 'DIFFERENT' } } }));
    const drift = await coord.getDrift('s1');
    expect(drift.find(d => d.provider === 'claude')?.state).toBe('drifted');
  });

  it('getDrift reports missing when target entry is absent', async () => {
    const now = Date.now();
    repo.upsert({
      id: 's2', name: 'gh', transport: 'stdio', command: 'x',
      targets: ['claude'],
      createdAt: now, updatedAt: now,
    });
    const drift = await coord.getDrift('s2');
    expect(drift.find(d => d.provider === 'claude')?.state).toBe('missing');
  });

  it('resolveDrift overwrite-target rewrites target to match canonical', async () => {
    const now = Date.now();
    repo.upsert({ id: 's1', name: 'fs', transport: 'stdio', command: 'npx', targets: ['claude'], createdAt: now, updatedAt: now });
    await coord.fanOut('s1');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { fs: { command: 'DIFFERENT' } } }));
    await coord.resolveDrift('s1', 'claude', 'overwrite-target');
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(parsed.mcpServers.fs.command).toBe('npx');
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/shared-mcp-coordinator.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `shared-mcp-coordinator.ts`**

Create `src/main/mcp/shared-mcp-coordinator.ts`:

```typescript
import type { SupportedProvider } from '../../shared/types/mcp-scopes.types';
import type { DriftState } from '../../shared/types/mcp-shared.types';
import type { ProviderMcpAdapter } from './adapters/provider-mcp-adapter.types';
import type { SharedMcpRepository, SharedMcpRecord } from './shared-mcp-repository';
import type { RawMcpRecord } from './redaction-service';

export interface SharedDriftStatus {
  provider: SupportedProvider;
  state: DriftState;
  diff?: string;
  lastObservedAt: number;
}

export type DriftResolution = 'overwrite-target' | 'adopt-target' | 'untrack-target';

export class SharedMcpCoordinator {
  constructor(
    private readonly deps: {
      repo: SharedMcpRepository;
      adapters: Record<SupportedProvider, ProviderMcpAdapter>;
      cwdProvider: () => string;
    },
  ) {}

  async fanOut(serverId: string, providers?: readonly SupportedProvider[]): Promise<SharedDriftStatus[]> {
    const rec = this.deps.repo.findById(serverId);
    if (!rec) throw new Error(`Shared server not found: ${serverId}`);
    const targets = providers ?? rec.targets;
    const results: SharedDriftStatus[] = [];
    for (const p of targets) {
      await this.writeToProvider(p, rec);
      results.push({ provider: p, state: 'in-sync', lastObservedAt: Date.now() });
    }
    return results;
  }

  async getDrift(serverId: string): Promise<SharedDriftStatus[]> {
    const rec = this.deps.repo.findById(serverId);
    if (!rec) throw new Error(`Shared server not found: ${serverId}`);
    const results: SharedDriftStatus[] = [];
    for (const p of rec.targets) {
      const status = await this.compareTarget(p, rec);
      results.push(status);
    }
    return results;
  }

  async resolveDrift(
    serverId: string,
    provider: SupportedProvider,
    action: DriftResolution,
  ): Promise<void> {
    const rec = this.deps.repo.findById(serverId);
    if (!rec) throw new Error(`Shared server not found: ${serverId}`);

    if (action === 'overwrite-target') {
      await this.writeToProvider(provider, rec);
      return;
    }
    if (action === 'adopt-target') {
      // Read target's current entry + replace the shared record.
      const adapter = this.deps.adapters[provider];
      const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
      const snap = await adapter.readScope('user', discovery.scopeFiles.user!);
      const found = snap.servers.find(s => s.name === rec.name);
      if (!found) return;
      this.deps.repo.upsert({
        ...rec,
        transport: found.transport,
        command: found.command,
        args: found.args,
        url: found.url,
        env: found.env,
        updatedAt: Date.now(),
      });
      return;
    }
    if (action === 'untrack-target') {
      const remaining = rec.targets.filter(t => t !== provider);
      this.deps.repo.upsert({ ...rec, targets: remaining, updatedAt: Date.now() });
      return;
    }
  }

  private async writeToProvider(provider: SupportedProvider, rec: SharedMcpRecord): Promise<void> {
    const adapter = this.deps.adapters[provider];
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    const sourceFile = discovery.scopeFiles.user!;
    const raw: RawMcpRecord = {
      id: `${provider}-user:${rec.name}`,
      name: rec.name,
      description: rec.description,
      transport: rec.transport,
      command: rec.command,
      args: rec.args,
      url: rec.url,
      env: rec.env,
      autoConnect: true,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
    await adapter.writeUserServer({ kind: 'upsert', record: raw, sourceFile });
  }

  private async compareTarget(
    provider: SupportedProvider,
    rec: SharedMcpRecord,
  ): Promise<SharedDriftStatus> {
    const adapter = this.deps.adapters[provider];
    const discovery = await adapter.discoverScopes({ cwd: this.deps.cwdProvider() });
    const sourceFile = discovery.scopeFiles.user!;
    const snap = await adapter.readScope('user', sourceFile);
    const found = snap.servers.find(s => s.name === rec.name);
    if (!found) {
      return { provider, state: 'missing', lastObservedAt: Date.now() };
    }
    const canonical = this.canonicalize({
      command: rec.command, args: rec.args, url: rec.url, env: rec.env, transport: rec.transport,
    });
    const targetJson = this.canonicalize({
      command: found.command, args: found.args, url: found.url, env: found.env, transport: found.transport,
    });
    if (canonical === targetJson) {
      return { provider, state: 'in-sync', lastObservedAt: Date.now() };
    }
    return { provider, state: 'drifted', diff: `canonical:\n${canonical}\n---\ntarget:\n${targetJson}`, lastObservedAt: Date.now() };
  }

  private canonicalize(o: Record<string, unknown>): string {
    const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
    const normalized: Record<string, unknown> = {};
    for (const k of keys) normalized[k] = o[k];
    return JSON.stringify(normalized);
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/shared-mcp-coordinator.spec.ts
npx tsc --noEmit
git add src/main/mcp/shared-mcp-coordinator.ts src/main/mcp/__tests__/shared-mcp-coordinator.spec.ts
git commit -m "feat(mcp): SharedMcpCoordinator for fan-out + drift detection"
```

---

## Task 2.3: `FsWatcherManager` — debounced provider-config watching with self-write suppression

**Context:** Spec §9. Watches each provider's known config files; debounces changes into state-refresh events; suppresses events for files we just wrote ourselves (via self-write token passed from `CliMcpConfigService`).

**Files:**
- Create: `src/main/mcp/fs-watcher-manager.ts`
- Test: `src/main/mcp/__tests__/fs-watcher-manager.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/mcp/__tests__/fs-watcher-manager.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FsWatcherManager } from '../fs-watcher-manager';

describe('FsWatcherManager', () => {
  let dir: string;
  let mgr: FsWatcherManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-fsw-'));
  });
  afterEach(async () => {
    await mgr?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits once after a burst of writes (debounced)', async () => {
    const cb = vi.fn();
    mgr = new FsWatcherManager({ debounceMs: 50 });
    mgr.on('change', cb);
    const target = path.join(dir, 'a.json');
    fs.writeFileSync(target, '0');
    await mgr.watch([target]);
    fs.writeFileSync(target, '1');
    fs.writeFileSync(target, '2');
    fs.writeFileSync(target, '3');
    await new Promise(r => setTimeout(r, 150));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('suppresses events emitted during a begin/endSelfWrite window', async () => {
    const cb = vi.fn();
    mgr = new FsWatcherManager({ debounceMs: 50 });
    mgr.on('change', cb);
    const target = path.join(dir, 'b.json');
    fs.writeFileSync(target, '0');
    await mgr.watch([target]);
    mgr.beginSelfWrite(target);
    fs.writeFileSync(target, '1');
    await new Promise(r => setTimeout(r, 120));
    mgr.endSelfWrite(target);
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/mcp/__tests__/fs-watcher-manager.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `fs-watcher-manager.ts`**

Create `src/main/mcp/fs-watcher-manager.ts`:

```typescript
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

export interface FsWatcherOptions {
  debounceMs: number;
}

export class FsWatcherManager extends EventEmitter {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly selfWrite = new Set<string>();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: FsWatcherOptions) {
    super();
  }

  async watch(paths: readonly string[]): Promise<void> {
    for (const p of paths) {
      if (this.watchers.has(p)) continue;
      try {
        const w = fs.watch(p, () => this.queueChange(p));
        this.watchers.set(p, w);
      } catch {
        // file may not exist yet — consumer can call watch() again later
      }
    }
  }

  beginSelfWrite(filePath: string): void {
    this.selfWrite.add(filePath);
  }

  endSelfWrite(filePath: string): void {
    this.selfWrite.delete(filePath);
  }

  async stop(): Promise<void> {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private queueChange(filePath: string): void {
    if (this.selfWrite.has(filePath)) return;
    const existing = this.pending.get(filePath);
    if (existing) clearTimeout(existing);
    this.pending.set(
      filePath,
      setTimeout(() => {
        this.pending.delete(filePath);
        if (this.selfWrite.has(filePath)) return;
        this.emit('change', filePath);
      }, this.opts.debounceMs),
    );
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/mcp/__tests__/fs-watcher-manager.spec.ts
npx tsc --noEmit
git add src/main/mcp/fs-watcher-manager.ts src/main/mcp/__tests__/fs-watcher-manager.spec.ts
git commit -m "feat(mcp): FsWatcherManager with debounce + self-write suppression"
```

---

## Task 2.4: Add IPC handlers for multi-provider MCP operations

**Context:** Spec §11. Attach 14 new handlers to the existing `mcp-handlers.ts` module. Each handler validates its payload with the Zod schemas from Task 0.3 and delegates to `CliMcpConfigService` / `SharedMcpCoordinator`.

**Files:**
- Modify: `src/main/ipc/handlers/mcp-handlers.ts`
- Test: `src/main/ipc/handlers/__tests__/mcp-handlers.spec.ts`

- [ ] **Step 1: Write failing test for one representative handler**

Append to the mcp-handlers spec (create it if missing):

```typescript
it('MCP_PROVIDER_USER_UPSERT rejects invalid provider', async () => {
  const res = await invokeHandler('MCP_PROVIDER_USER_UPSERT', {
    provider: 'cursor', // not supported in v1
    name: 'x',
    transport: 'stdio',
  });
  expect(res.success).toBe(false);
  expect(res.error?.code).toBe('MCP_PROVIDER_USER_UPSERT_FAILED');
});

it('MCP_GET_MULTI_PROVIDER_STATE returns DTO', async () => {
  const res = await invokeHandler('MCP_GET_MULTI_PROVIDER_STATE', undefined);
  expect(res.success).toBe(true);
  expect(Array.isArray(res.data.providers)).toBe(true);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/main/ipc/handlers/__tests__/mcp-handlers.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Register new handlers**

Edit `src/main/ipc/handlers/mcp-handlers.ts`. Extend the exported `registerMcpHandlers(deps)` function. Add imports:

```typescript
import { getCliMcpConfigService } from '../../mcp/cli-mcp-config-service-singleton';
import { getSharedMcpCoordinator } from '../../mcp/shared-mcp-coordinator-singleton';
import { getOrchestratorMcpRepository } from '../../mcp/orchestrator-mcp-repository-singleton';
import { getSharedMcpRepository } from '../../mcp/shared-mcp-repository-singleton';
import {
  OrchestratorMcpServerSchema,
  SharedMcpServerUpsertSchema,
  McpFanOutPayloadSchema,
  McpResolveDriftPayloadSchema,
  McpInjectionTargetsPayloadSchema,
  McpProviderScopePayloadSchema,
  McpUserUpsertPayloadSchema,
  McpDriftQuerySchema,
} from '@contracts/schemas/mcp-multi-provider';
```

Append these handlers just before the closing brace of `registerMcpHandlers`:

```typescript
ipcMain.handle(IPC_CHANNELS.MCP_GET_MULTI_PROVIDER_STATE, async (): Promise<IpcResponse> => {
  try {
    const data = await getCliMcpConfigService().getMultiProviderState();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: { code: 'MCP_GET_MULTI_PROVIDER_STATE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_REFRESH_MULTI_PROVIDER_STATE, async (): Promise<IpcResponse> => {
  try {
    getCliMcpConfigService().bumpStateVersion();
    const data = await getCliMcpConfigService().getMultiProviderState();
    deps.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED, data);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: { code: 'MCP_REFRESH_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_ORCHESTRATOR_UPSERT, async (_e, payload) => {
  try {
    const v = validateIpcPayload(OrchestratorMcpServerSchema, payload, 'MCP_ORCHESTRATOR_UPSERT');
    getOrchestratorMcpRepository().upsert({ ...v, injectInto: ['claude', 'codex', 'gemini', 'copilot'] } as any);
    getCliMcpConfigService().bumpStateVersion();
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_ORCHESTRATOR_UPSERT_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_ORCHESTRATOR_DELETE, async (_e, payload: unknown) => {
  try {
    const v = validateIpcPayload(McpDriftQuerySchema, payload, 'MCP_ORCHESTRATOR_DELETE');
    getOrchestratorMcpRepository().delete(v.serverId);
    getCliMcpConfigService().bumpStateVersion();
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_ORCHESTRATOR_DELETE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_ORCHESTRATOR_SET_INJECTION_TARGETS, async (_e, payload) => {
  try {
    const v = validateIpcPayload(McpInjectionTargetsPayloadSchema, payload, 'MCP_ORCHESTRATOR_SET_INJECTION_TARGETS');
    getOrchestratorMcpRepository().setInjectionTargets(v.serverId, v.providers);
    getCliMcpConfigService().bumpStateVersion();
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_ORCHESTRATOR_SET_INJECTION_TARGETS_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_SHARED_UPSERT, async (_e, payload) => {
  try {
    const v = validateIpcPayload(SharedMcpServerUpsertSchema, payload, 'MCP_SHARED_UPSERT');
    const now = Date.now();
    getSharedMcpRepository().upsert({
      id: v.id ?? `shared:${v.name}`,
      name: v.name,
      description: v.description,
      transport: v.transport,
      command: v.command,
      args: v.args,
      url: v.url,
      env: v.env,
      targets: v.targets,
      createdAt: now,
      updatedAt: now,
    });
    getCliMcpConfigService().bumpStateVersion();
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_SHARED_UPSERT_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_SHARED_DELETE, async (_e, payload) => {
  try {
    const v = validateIpcPayload(McpDriftQuerySchema, payload, 'MCP_SHARED_DELETE');
    getSharedMcpRepository().delete(v.serverId);
    getCliMcpConfigService().bumpStateVersion();
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_SHARED_DELETE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_SHARED_FAN_OUT, async (_e, payload) => {
  try {
    const v = validateIpcPayload(McpFanOutPayloadSchema, payload, 'MCP_SHARED_FAN_OUT');
    const data = await getSharedMcpCoordinator().fanOut(v.serverId, v.providers);
    getCliMcpConfigService().bumpStateVersion();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: { code: 'MCP_SHARED_FAN_OUT_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_SHARED_GET_DRIFT, async (_e, payload) => {
  try {
    const v = validateIpcPayload(McpDriftQuerySchema, payload, 'MCP_SHARED_GET_DRIFT');
    const data = await getSharedMcpCoordinator().getDrift(v.serverId);
    return { success: true, data };
  } catch (error) {
    return { success: false, error: { code: 'MCP_SHARED_GET_DRIFT_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_SHARED_RESOLVE_DRIFT, async (_e, payload) => {
  try {
    const v = validateIpcPayload(McpResolveDriftPayloadSchema, payload, 'MCP_SHARED_RESOLVE_DRIFT');
    await getSharedMcpCoordinator().resolveDrift(v.serverId, v.provider, v.action);
    getCliMcpConfigService().bumpStateVersion();
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_SHARED_RESOLVE_DRIFT_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_PROVIDER_USER_UPSERT, async (_e, payload) => {
  try {
    const v = validateIpcPayload(McpUserUpsertPayloadSchema, payload, 'MCP_PROVIDER_USER_UPSERT');
    await getCliMcpConfigService().upsertProviderUser(v.provider, v);
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_PROVIDER_USER_UPSERT_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_PROVIDER_USER_DELETE, async (_e, payload) => {
  try {
    const v = validateIpcPayload(
      z.object({ provider: z.enum(['claude', 'codex', 'gemini', 'copilot']), serverId: z.string().min(1) }),
      payload,
      'MCP_PROVIDER_USER_DELETE',
    );
    await getCliMcpConfigService().deleteProviderUser(v.provider, v.serverId);
    return { success: true };
  } catch (error) {
    return { success: false, error: { code: 'MCP_PROVIDER_USER_DELETE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});

ipcMain.handle(IPC_CHANNELS.MCP_PROVIDER_OPEN_SCOPE_FILE, async (_e, payload) => {
  try {
    const v = validateIpcPayload(McpProviderScopePayloadSchema, payload, 'MCP_PROVIDER_OPEN_SCOPE_FILE');
    const filePath = await getCliMcpConfigService().openScopeFile(v.provider, v.scope);
    return { success: true, data: { filePath } };
  } catch (error) {
    return { success: false, error: { code: 'MCP_PROVIDER_OPEN_SCOPE_FILE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
  }
});
```

(`z` must be imported from `zod` at the top of the file if not already.)

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/ipc/handlers/__tests__/mcp-handlers.spec.ts
npx tsc --noEmit
git add src/main/ipc/handlers/mcp-handlers.ts src/main/ipc/handlers/__tests__/mcp-handlers.spec.ts
git commit -m "feat(mcp): IPC handlers for multi-provider management"
```

---

## Task 2.5: Singleton bridge modules for new services

**Context:** The IPC handlers call `getCliMcpConfigService()` / `getSharedMcpCoordinator()` / `getOrchestratorMcpRepository()` / `getSharedMcpRepository()`. Create these tiny singleton modules so the handlers aren't constructing services themselves.

**Files:**
- Create: `src/main/mcp/cli-mcp-config-service-singleton.ts`
- Create: `src/main/mcp/shared-mcp-coordinator-singleton.ts`
- Create: `src/main/mcp/orchestrator-mcp-repository-singleton.ts`
- Create: `src/main/mcp/shared-mcp-repository-singleton.ts`

- [ ] **Step 1: Implement the four singletons**

Each file follows the pattern at `src/main/mcp/secret-storage.ts` Step 3 (lazy `getInstance()` + `_resetForTesting()`). Example:

```typescript
// cli-mcp-config-service-singleton.ts
import { CliMcpConfigService } from './cli-mcp-config-service';

let instance: CliMcpConfigService | null = null;
export function setCliMcpConfigService(svc: CliMcpConfigService): void { instance = svc; }
export function getCliMcpConfigService(): CliMcpConfigService {
  if (!instance) throw new Error('CliMcpConfigService not initialized — call setCliMcpConfigService() from src/main/index.ts');
  return instance;
}
export function _resetCliMcpConfigServiceForTesting(): void { instance = null; }
```

Repeat for the other three, with matching `setXxx`/`getXxx`/`_resetXxxForTesting` triples.

- [ ] **Step 2: Initialize them in `src/main/index.ts`**

In the init sequence (after `new RlmDatabase(...)` is available), add:

```typescript
const secrets = getMcpSecretStorage();
const orchestratorRepo = new OrchestratorMcpRepository(rlmDb, secrets);
const sharedRepo = new SharedMcpRepository(rlmDb, secrets);
const writeSafety = new WriteSafetyHelper({
  allowWorldWritableParent: settings.mcpAllowWorldWritableParent,
  writeBackups: !settings.mcpDisableProviderBackups,
});
const adapters = {
  claude: new ClaudeMcpAdapter({ home: os.homedir(), writeSafety }),
  codex: new CodexMcpAdapter({ codexHome: path.join(os.homedir(), '.codex'), writeSafety }),
  gemini: new GeminiMcpAdapter({ home: os.homedir(), writeSafety }),
  copilot: new CopilotMcpAdapter({ home: os.homedir(), writeSafety }),
};
const redaction = new RedactionService(new SecretClassifier());
const cliService = new CliMcpConfigService({
  adapters, orchestratorRepo, sharedRepo, redaction,
  cwdProvider: () => process.cwd(),
});
const coordinator = new SharedMcpCoordinator({
  repo: sharedRepo, adapters,
  cwdProvider: () => process.cwd(),
});

setOrchestratorMcpRepository(orchestratorRepo);
setSharedMcpRepository(sharedRepo);
setCliMcpConfigService(cliService);
setSharedMcpCoordinator(coordinator);
```

- [ ] **Step 3: Register cleanup on app quit**

Append to the existing app-quit cleanup block:

```typescript
if (settings.mcpCleanupBackupsOnQuit) {
  const paths = await collectAllProviderScopeFilePaths(cliService);
  await writeSafety.cleanupBackups(paths);
}
```

(`collectAllProviderScopeFilePaths` = helper you add inline: iterates adapters + calls `discoverScopes({cwd})` + flattens `scopeFiles` values.)

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/main/mcp/*-singleton.ts src/main/index.ts
git commit -m "feat(mcp): singleton bridges + wiring in index.ts"
```

---

## Task 2.6: Preload surface additions

**Context:** The renderer calls each new IPC handler via `window.electronAPI.mcpXxx(...)`. Extend preload exports.

**Files:**
- Modify: `src/preload/preload.ts`
- Modify: `src/shared/types/ipc.types.ts` (add `ElectronAPI` method signatures)

- [ ] **Step 1: Add preload methods**

In `src/preload/preload.ts`, near the existing MCP bindings, add:

```typescript
mcpGetMultiProviderState: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_MULTI_PROVIDER_STATE),
mcpRefreshMultiProviderState: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_REFRESH_MULTI_PROVIDER_STATE),
mcpOrchestratorUpsert: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_ORCHESTRATOR_UPSERT, payload),
mcpOrchestratorDelete: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_ORCHESTRATOR_DELETE, payload),
mcpOrchestratorSetInjectionTargets: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_ORCHESTRATOR_SET_INJECTION_TARGETS, payload),
mcpSharedUpsert: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SHARED_UPSERT, payload),
mcpSharedDelete: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SHARED_DELETE, payload),
mcpSharedFanOut: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SHARED_FAN_OUT, payload),
mcpSharedGetDrift: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SHARED_GET_DRIFT, payload),
mcpSharedResolveDrift: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SHARED_RESOLVE_DRIFT, payload),
mcpProviderUserUpsert: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_PROVIDER_USER_UPSERT, payload),
mcpProviderUserDelete: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_PROVIDER_USER_DELETE, payload),
mcpProviderOpenScopeFile: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_PROVIDER_OPEN_SCOPE_FILE, payload),
onMcpMultiProviderStateChanged: (handler: (data: unknown) => void) => {
  const wrap = (_: any, data: unknown) => handler(data);
  ipcRenderer.on(IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED, wrap);
  return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED, wrap);
},
```

- [ ] **Step 2: Update `ElectronAPI` interface**

Edit `src/shared/types/ipc.types.ts` — extend the `ElectronAPI` interface with matching method signatures. Example (keep shape consistent with other MCP methods already there):

```typescript
mcpGetMultiProviderState(): Promise<IpcResponse<McpMultiProviderStateDto>>;
mcpRefreshMultiProviderState(): Promise<IpcResponse<McpMultiProviderStateDto>>;
mcpOrchestratorUpsert(payload: unknown): Promise<IpcResponse>;
mcpOrchestratorDelete(payload: unknown): Promise<IpcResponse>;
mcpOrchestratorSetInjectionTargets(payload: unknown): Promise<IpcResponse>;
mcpSharedUpsert(payload: unknown): Promise<IpcResponse>;
mcpSharedDelete(payload: unknown): Promise<IpcResponse>;
mcpSharedFanOut(payload: unknown): Promise<IpcResponse<readonly SharedDriftStatus[]>>;
mcpSharedGetDrift(payload: unknown): Promise<IpcResponse<readonly SharedDriftStatus[]>>;
mcpSharedResolveDrift(payload: unknown): Promise<IpcResponse>;
mcpProviderUserUpsert(payload: unknown): Promise<IpcResponse>;
mcpProviderUserDelete(payload: unknown): Promise<IpcResponse>;
mcpProviderOpenScopeFile(payload: unknown): Promise<IpcResponse<{ filePath?: string }>>;
onMcpMultiProviderStateChanged(handler: (data: McpMultiProviderStateDto) => void): () => void;
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/preload/preload.ts src/shared/types/ipc.types.ts
git commit -m "feat(mcp): preload bindings for multi-provider MCP"
```

---

## Task 2.7: Extend `McpIpcService` renderer-side facade

**Files:**
- Modify: `src/renderer/app/core/services/ipc/mcp-ipc.service.ts`
- Test: `src/renderer/app/core/services/ipc/__tests__/mcp-ipc.service.spec.ts`

- [ ] **Step 1: Write failing test**

Append to the mcp-ipc spec (or create it):

```typescript
it('getMultiProviderState delegates to electronAPI', async () => {
  const mockState = { providers: [], orchestrator: [], shared: [], stateVersion: 0 };
  (window as any).electronAPI = {
    mcpGetMultiProviderState: vi.fn().mockResolvedValue({ success: true, data: mockState }),
  };
  const svc = TestBed.inject(McpIpcService);
  const res = await svc.getMultiProviderState();
  expect(res.success).toBe(true);
  expect(res.data).toEqual(mockState);
});
```

- [ ] **Step 2: Implement methods**

Append to `src/renderer/app/core/services/ipc/mcp-ipc.service.ts`:

```typescript
async getMultiProviderState() {
  if (!this.api) return this.noApi<McpMultiProviderStateDto>();
  return this.api.mcpGetMultiProviderState();
}
async refreshMultiProviderState() {
  if (!this.api) return this.noApi<McpMultiProviderStateDto>();
  return this.api.mcpRefreshMultiProviderState();
}
async orchestratorUpsert(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpOrchestratorUpsert(payload);
}
async orchestratorDelete(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpOrchestratorDelete(payload);
}
async orchestratorSetInjectionTargets(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpOrchestratorSetInjectionTargets(payload);
}
async sharedUpsert(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpSharedUpsert(payload);
}
async sharedDelete(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpSharedDelete(payload);
}
async sharedFanOut(payload: unknown) {
  if (!this.api) return this.noApi<readonly SharedDriftStatus[]>();
  return this.api.mcpSharedFanOut(payload);
}
async sharedGetDrift(payload: unknown) {
  if (!this.api) return this.noApi<readonly SharedDriftStatus[]>();
  return this.api.mcpSharedGetDrift(payload);
}
async sharedResolveDrift(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpSharedResolveDrift(payload);
}
async providerUserUpsert(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpProviderUserUpsert(payload);
}
async providerUserDelete(payload: unknown) {
  if (!this.api) return this.noApi();
  return this.api.mcpProviderUserDelete(payload);
}
async providerOpenScopeFile(payload: unknown) {
  if (!this.api) return this.noApi<{ filePath?: string }>();
  return this.api.mcpProviderOpenScopeFile(payload);
}
onMultiProviderStateChanged(cb: (data: McpMultiProviderStateDto) => void): () => void {
  if (!this.api) return () => undefined;
  return this.api.onMcpMultiProviderStateChanged((data) => this.ngZone.run(() => cb(data)));
}

// --- helper (add once near other private methods) ---
private noApi<T = unknown>(): IpcResponse<T> {
  return { success: false, error: { code: 'ELECTRON_API_UNAVAILABLE', message: 'electronAPI not present (browser mode?)', timestamp: Date.now() } };
}
```

- [ ] **Step 3: Run test + typecheck + commit**

```bash
npx vitest run src/renderer/app/core/services/ipc/__tests__/mcp-ipc.service.spec.ts
npx tsc --noEmit
git add src/renderer/app/core/services/ipc/mcp-ipc.service.ts src/renderer/app/core/services/ipc/__tests__/mcp-ipc.service.spec.ts
git commit -m "feat(mcp): renderer McpIpcService — multi-provider facade"
```

---

## Task 2.8: `McpMultiProviderStore` — signals-based renderer store

**Context:** Injectable Angular service exposing `state = signal<McpMultiProviderStateDto>()`, plus derived computed signals per tab.

**Files:**
- Create: `src/renderer/app/features/mcp/state/mcp-multi-provider.store.ts`
- Test: `src/renderer/app/features/mcp/state/__tests__/mcp-multi-provider.store.spec.ts`

- [ ] **Step 1: Write failing test**

Create `src/renderer/app/features/mcp/state/__tests__/mcp-multi-provider.store.spec.ts`:

```typescript
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpMultiProviderStore } from '../mcp-multi-provider.store';
import { McpIpcService } from '../../../../core/services/ipc/mcp-ipc.service';

describe('McpMultiProviderStore', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: McpIpcService,
          useValue: {
            getMultiProviderState: vi.fn().mockResolvedValue({
              success: true,
              data: {
                providers: [
                  { provider: 'claude', cliAvailable: true, servers: [{ id: 'u:fs', scope: 'user', name: 'fs' }] },
                ],
                orchestrator: [],
                shared: [],
                stateVersion: 0,
              },
            }),
            onMultiProviderStateChanged: vi.fn().mockReturnValue(() => undefined),
          },
        },
      ],
    });
  });

  it('refresh() populates state', async () => {
    const store = TestBed.inject(McpMultiProviderStore);
    await store.refresh();
    expect(store.state().providers.length).toBe(1);
  });

  it('exposes tab-scoped computed signals', async () => {
    const store = TestBed.inject(McpMultiProviderStore);
    await store.refresh();
    expect(store.providerTab('claude')()!.servers.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/state/__tests__/mcp-multi-provider.store.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the store**

Create `src/renderer/app/features/mcp/state/mcp-multi-provider.store.ts`:

```typescript
import { Injectable, computed, inject, signal } from '@angular/core';
import { McpIpcService } from '../../../core/services/ipc/mcp-ipc.service';
import type { McpMultiProviderStateDto, ProviderTabDto, OrchestratorMcpDto, SharedMcpDto } from '../../../../../shared/types/mcp-dtos.types';
import type { SupportedProvider } from '../../../../../shared/types/mcp-scopes.types';

const EMPTY: McpMultiProviderStateDto = {
  providers: [], orchestrator: [], shared: [], stateVersion: 0,
};

@Injectable({ providedIn: 'root' })
export class McpMultiProviderStore {
  private readonly ipc = inject(McpIpcService);
  private readonly _state = signal<McpMultiProviderStateDto>(EMPTY);
  readonly state = this._state.asReadonly();
  readonly orchestrator = computed<readonly OrchestratorMcpDto[]>(() => this._state().orchestrator);
  readonly shared = computed<readonly SharedMcpDto[]>(() => this._state().shared);

  constructor() {
    this.ipc.onMultiProviderStateChanged((data) => this._state.set(data));
  }

  async refresh(): Promise<void> {
    const res = await this.ipc.getMultiProviderState();
    if (res.success && res.data) this._state.set(res.data);
  }

  async manualRefresh(): Promise<void> {
    const res = await this.ipc.refreshMultiProviderState();
    if (res.success && res.data) this._state.set(res.data);
  }

  providerTab(provider: SupportedProvider) {
    return computed<ProviderTabDto | undefined>(
      () => this._state().providers.find(p => p.provider === provider),
    );
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/state/__tests__/mcp-multi-provider.store.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/state/mcp-multi-provider.store.ts src/renderer/app/features/mcp/state/__tests__/mcp-multi-provider.store.spec.ts
git commit -m "feat(mcp): renderer multi-provider signals store"
```

---

## Task 2.9: End-to-end integration test — fan-out + drift detection

**Context:** One cross-module test proving the full Shared-tab flow: upsert via `CliMcpConfigService`, call fan-out, verify all four providers received the config, hand-edit one, verify `getDrift` flags it, call `resolveDrift` and verify re-sync.

**Files:**
- Create: `src/main/mcp/__tests__/multi-provider-integration.spec.ts`

- [ ] **Step 1: Write the integration test**

Create `src/main/mcp/__tests__/multi-provider-integration.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openMemoryDb, runMigrations } from '../../persistence/rlm/__tests__/helpers';
import { McpSecretStorage } from '../secret-storage';
import { WriteSafetyHelper } from '../write-safety-helper';
import { SecretClassifier } from '../secret-classifier';
import { RedactionService } from '../redaction-service';
import { ClaudeMcpAdapter } from '../adapters/claude-mcp-adapter';
import { GeminiMcpAdapter } from '../adapters/gemini-mcp-adapter';
import { CodexMcpAdapter } from '../adapters/codex-mcp-adapter';
import { CopilotMcpAdapter } from '../adapters/copilot-mcp-adapter';
import { OrchestratorMcpRepository } from '../orchestrator-mcp-repository';
import { SharedMcpRepository } from '../shared-mcp-repository';
import { CliMcpConfigService } from '../cli-mcp-config-service';
import { SharedMcpCoordinator } from '../shared-mcp-coordinator';

describe('MCP multi-provider integration', () => {
  let home: string;
  let svc: CliMcpConfigService;
  let coord: SharedMcpCoordinator;
  let sharedRepo: SharedMcpRepository;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-int-'));
    const db = openMemoryDb();
    runMigrations(db);
    const secrets = new McpSecretStorage({ safeStorage: { isEncryptionAvailable: () => false } as any });
    const writeSafety = new WriteSafetyHelper({ allowWorldWritableParent: false, writeBackups: true });
    const adapters = {
      claude: new ClaudeMcpAdapter({ home, writeSafety }),
      codex: new CodexMcpAdapter({ codexHome: path.join(home, '.codex'), writeSafety }),
      gemini: new GeminiMcpAdapter({ home, writeSafety }),
      copilot: new CopilotMcpAdapter({ home, writeSafety }),
    };
    const orch = new OrchestratorMcpRepository(db, secrets);
    sharedRepo = new SharedMcpRepository(db, secrets);
    svc = new CliMcpConfigService({
      adapters, orchestratorRepo: orch, sharedRepo, redaction: new RedactionService(new SecretClassifier()),
      cwdProvider: () => home,
    });
    coord = new SharedMcpCoordinator({ repo: sharedRepo, adapters, cwdProvider: () => home });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('fan-out → drift → resolve round trip across all 4 providers', async () => {
    const now = Date.now();
    sharedRepo.upsert({
      id: 's1', name: 'filesystem', transport: 'stdio',
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'],
      targets: ['claude', 'codex', 'gemini', 'copilot'],
      createdAt: now, updatedAt: now,
    });
    const result = await coord.fanOut('s1');
    expect(result.map(r => r.state)).toEqual(['in-sync', 'in-sync', 'in-sync', 'in-sync']);

    // Hand-edit codex config.toml to simulate drift
    const codexCfg = path.join(home, '.codex', 'config.toml');
    fs.writeFileSync(codexCfg, fs.readFileSync(codexCfg, 'utf8').replace('npx', 'DIFFERENT'));
    const drift = await coord.getDrift('s1');
    const codexStatus = drift.find(d => d.provider === 'codex');
    expect(codexStatus?.state).toBe('drifted');

    await coord.resolveDrift('s1', 'codex', 'overwrite-target');
    const after = await coord.getDrift('s1');
    expect(after.find(d => d.provider === 'codex')?.state).toBe('in-sync');

    // State DTO reflects reality
    const state = await svc.getMultiProviderState();
    expect(state.providers.map(p => p.provider).sort()).toEqual(['claude', 'codex', 'copilot', 'gemini']);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/main/mcp/__tests__/multi-provider-integration.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/mcp/__tests__/multi-provider-integration.spec.ts
git commit -m "test(mcp): end-to-end fan-out + drift integration"
```

---

# Phase 3 — Renderer UI

Goal: build the tabbed MCP page per spec §4 mockups — Orchestrator, Shared, Claude, Codex, Gemini, Copilot tabs — with sidebar + detail pattern, drift banner, read-only project/local sections, and "(shared)" affordance.

## Task 3.1: Restructure existing `McpPageComponent` as tab host

**Context:** The current MCP page is a single-list component. Replace with a host that holds the six-tab strip + a dynamic content outlet. Preserve current IPC plumbing (`McpIpcService` event subscriptions).

**Files:**
- Modify: `src/renderer/app/features/mcp/mcp.page.component.ts`
- Modify: `src/renderer/app/features/mcp/mcp.page.component.html`
- Modify: `src/renderer/app/features/mcp/mcp.page.component.scss`
- Test: `src/renderer/app/features/mcp/__tests__/mcp.page.component.spec.ts`

- [ ] **Step 1: Write failing test**

Append a test case:

```typescript
it('renders six tabs in fixed order', () => {
  const fixture = TestBed.createComponent(McpPageComponent);
  fixture.detectChanges();
  const labels = fixture.nativeElement.querySelectorAll('[data-test="mcp-tab"]');
  expect(Array.from(labels).map((e: any) => e.textContent.trim())).toEqual([
    'Orchestrator', 'Shared', 'Claude', 'Codex', 'Gemini', 'Copilot',
  ]);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/__tests__/mcp.page.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Refactor to tab host**

Replace the component template with a six-tab strip + content outlet:

```html
<div class="mcp-page">
  <div class="tabs" role="tablist">
    @for (t of tabs; track t.id) {
      <button
        data-test="mcp-tab"
        role="tab"
        [class.active]="t.id === activeTab()"
        (click)="activeTab.set(t.id)">
        {{ t.label }}
      </button>
    }
  </div>
  <div class="content">
    @switch (activeTab()) {
      @case ('orchestrator') { <orc-mcp-orchestrator-tab /> }
      @case ('shared')       { <orc-mcp-shared-tab /> }
      @case ('claude')       { <orc-mcp-provider-tab provider="claude" /> }
      @case ('codex')        { <orc-mcp-provider-tab provider="codex" /> }
      @case ('gemini')       { <orc-mcp-provider-tab provider="gemini" /> }
      @case ('copilot')      { <orc-mcp-provider-tab provider="copilot" /> }
    }
  </div>
</div>
```

Component class:

```typescript
readonly tabs = [
  { id: 'orchestrator', label: 'Orchestrator' },
  { id: 'shared',       label: 'Shared' },
  { id: 'claude',       label: 'Claude' },
  { id: 'codex',        label: 'Codex' },
  { id: 'gemini',       label: 'Gemini' },
  { id: 'copilot',      label: 'Copilot' },
] as const;
readonly activeTab = signal<(typeof this.tabs)[number]['id']>('orchestrator');
```

Stub-import the three child components (create them empty-but-compiling in their own tasks below).

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/__tests__/mcp.page.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/mcp.page.component.*
git commit -m "feat(mcp-ui): restructure McpPage as six-tab host"
```

---

## Task 3.2: Build `<orc-mcp-server-detail-panel>` shared detail component

**Context:** Reused by all three tab types — renders command/args/env (env values pre-redacted) + action buttons (Test/Edit/Remove).

**Files:**
- Create: `src/renderer/app/features/mcp/components/mcp-server-detail-panel.component.ts` (+ .html, .scss)
- Test: `.../__tests__/mcp-server-detail-panel.component.spec.ts`

- [ ] **Step 1: Write failing test**

Create the spec:

```typescript
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { McpServerDetailPanelComponent } from '../mcp-server-detail-panel.component';

describe('McpServerDetailPanelComponent', () => {
  it('displays redacted env values with the sentinel character', () => {
    const fx = TestBed.createComponent(McpServerDetailPanelComponent);
    fx.componentRef.setInput('server', {
      id: 'x', name: 'x', scope: 'user', transport: 'stdio', command: 'npx',
      env: { HOME: '/u', API_KEY: '•••' },
      autoConnect: true, readOnly: false, createdAt: 1, updatedAt: 1,
    });
    fx.detectChanges();
    const text = fx.nativeElement.textContent;
    expect(text).toContain('/u');
    expect(text).toContain('•••');
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/components/__tests__/mcp-server-detail-panel.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the panel**

Create `mcp-server-detail-panel.component.ts`:

```typescript
import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { RedactedMcpServerDto } from '../../../../../shared/types/mcp-dtos.types';

@Component({
  selector: 'orc-mcp-server-detail-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mcp-server-detail-panel.component.html',
  styleUrl: './mcp-server-detail-panel.component.scss',
})
export class McpServerDetailPanelComponent {
  readonly server = input.required<RedactedMcpServerDto>();
  readonly edit = output<void>();
  readonly remove = output<void>();
  readonly test = output<void>();
}
```

Template: render a key/value grid for scope/transport/command/args/env/source-file, plus three buttons (hidden when `server().readOnly`).

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/components/__tests__/mcp-server-detail-panel.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/components/mcp-server-detail-panel.component.* \
  src/renderer/app/features/mcp/components/__tests__/mcp-server-detail-panel.component.spec.ts
git commit -m "feat(mcp-ui): server-detail panel (redacted env + action buttons)"
```

---

## Task 3.3: Build `<orc-mcp-orchestrator-tab>`

**Context:** Spec §4 tab 1. Sidebar lists Orchestrator-scope servers + "+ Add" button. Detail pane uses `McpServerDetailPanel` plus a fan-out checklist (4 providers).

**Files:**
- Create: `src/renderer/app/features/mcp/tabs/orc-mcp-orchestrator-tab.component.ts` (+ .html, .scss)
- Test: `.../__tests__/orc-mcp-orchestrator-tab.component.spec.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('renders orchestrator list from store', () => {
  const store = {
    orchestrator: signal([{ record: { id: 'o1', name: 'codemem', scope: 'orchestrator-codemem' }, injectInto: ['claude'] }]),
    refresh: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: McpMultiProviderStore, useValue: store }],
  });
  const fx = TestBed.createComponent(OrcMcpOrchestratorTabComponent);
  fx.detectChanges();
  const rows = fx.nativeElement.querySelectorAll('[data-test="orch-row"]');
  expect(rows.length).toBe(1);
  expect(rows[0].textContent).toContain('codemem');
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-orchestrator-tab.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the tab**

Minimal component:

```typescript
@Component({
  selector: 'orc-mcp-orchestrator-tab',
  standalone: true,
  imports: [CommonModule, McpServerDetailPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './orc-mcp-orchestrator-tab.component.html',
  styleUrl: './orc-mcp-orchestrator-tab.component.scss',
})
export class OrcMcpOrchestratorTabComponent {
  readonly store = inject(McpMultiProviderStore);
  readonly selected = signal<string | null>(null);
  readonly selectedServer = computed(() =>
    this.store.orchestrator().find(o => o.record.id === this.selected())?.record,
  );

  async ngOnInit() { await this.store.refresh(); }
  select(id: string) { this.selected.set(id); }
}
```

Template: two-pane grid (sidebar + detail), "+ Add" button (opens an inline form or dispatches a follow-up task — for v1, a minimal form is acceptable and should be wired to `McpIpcService.orchestratorUpsert`).

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-orchestrator-tab.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/tabs/orc-mcp-orchestrator-tab.component.* \
  src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-orchestrator-tab.component.spec.ts
git commit -m "feat(mcp-ui): Orchestrator tab"
```

---

## Task 3.4: Build `<orc-mcp-shared-tab>` with drift banner

**Context:** Spec §4 tab 2 + §8. Sidebar lists shared servers; detail pane shows canonical record + 4-provider fan-out checklist + per-provider drift chip (in-sync / drifted / missing / —) + drift banner at top when any target drifted.

**Files:**
- Create: `src/renderer/app/features/mcp/tabs/orc-mcp-shared-tab.component.ts` (+ .html, .scss)
- Test: `.../__tests__/orc-mcp-shared-tab.component.spec.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('shows drift banner when at least one target is drifted', () => {
  const store = {
    shared: signal([{
      record: { id: 's1', name: 'fs', scope: 'shared' },
      targets: [
        { provider: 'claude', state: 'in-sync' },
        { provider: 'codex', state: 'drifted' },
      ],
    }]),
    refresh: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: McpMultiProviderStore, useValue: store }],
  });
  const fx = TestBed.createComponent(OrcMcpSharedTabComponent);
  fx.componentInstance.select('s1');
  fx.detectChanges();
  const banner = fx.nativeElement.querySelector('[data-test="drift-banner"]');
  expect(banner).toBeTruthy();
  expect(banner.textContent).toContain('drifted');
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-shared-tab.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the tab**

Component follows the same two-pane pattern as Orchestrator tab. Detail pane adds:
- Drift banner at top (shown iff `any target.state === 'drifted'`) with "View diff" + "Resolve" ghost buttons wired to `McpIpcService.sharedGetDrift` / `sharedResolveDrift`.
- "Installed in" checklist: one row per supported provider showing the drift chip + toggleable checkbox (toggling calls `sharedUpsert` with updated targets, then `sharedFanOut`).

Use `<orc-mcp-server-detail-panel>` for the command/args/env block.

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-shared-tab.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/tabs/orc-mcp-shared-tab.component.* \
  src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-shared-tab.component.spec.ts
git commit -m "feat(mcp-ui): Shared tab + drift banner"
```

---

## Task 3.5: Build `<orc-mcp-provider-tab>` — reusable per-provider tab

**Context:** Spec §4 tab 3+ (Claude, Codex, Gemini, Copilot). Sidebar split into User (editable, + Add) + Project / Local / Workspace / Managed / System sections (read-only, lock icons, click to reveal source-file path). Shared servers appear in the User group with a "(shared)" tag; editing one routes the write back through `SharedMcpCoordinator`.

**Files:**
- Create: `src/renderer/app/features/mcp/tabs/orc-mcp-provider-tab.component.ts` (+ .html, .scss)
- Test: `.../__tests__/orc-mcp-provider-tab.component.spec.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('lists user servers with + Add button and renders project servers as read-only', () => {
  const store = {
    providerTab: (_p: string) => signal({
      provider: 'claude',
      cliAvailable: true,
      servers: [
        { id: 'u:fs', name: 'fs', scope: 'user', readOnly: false },
        { id: 'p:gh', name: 'gh', scope: 'project', readOnly: true, sourceFile: '.mcp.json' },
      ],
    }),
    refresh: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: McpMultiProviderStore, useValue: store }],
  });
  const fx = TestBed.createComponent(OrcMcpProviderTabComponent);
  fx.componentRef.setInput('provider', 'claude');
  fx.detectChanges();
  expect(fx.nativeElement.querySelector('[data-test="user-add-btn"]')).toBeTruthy();
  const projectRow = fx.nativeElement.querySelector('[data-test="provider-row"][data-scope="project"]');
  expect(projectRow.classList.contains('read-only')).toBe(true);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-provider-tab.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the tab**

Component shape:

```typescript
@Component({ /* standalone + OnPush */ })
export class OrcMcpProviderTabComponent {
  readonly provider = input.required<SupportedProvider>();
  readonly store = inject(McpMultiProviderStore);
  readonly tab = computed(() => this.store.providerTab(this.provider())());
  readonly groupedServers = computed(() => {
    const servers = this.tab()?.servers ?? [];
    const order: readonly McpScope[] = ['user', 'project', 'local', 'workspace', 'managed', 'system'];
    return order.map(scope => ({
      scope,
      servers: servers.filter(s => s.scope === scope),
    })).filter(g => g.servers.length > 0 || g.scope === 'user');
  });
  readonly selected = signal<string | null>(null);
  readonly selectedServer = computed(
    () => (this.tab()?.servers ?? []).find(s => s.id === this.selected()),
  );
}
```

Template: grouped sidebar (with the `read-only` class + lock icon on non-user groups; clicking a read-only row calls `McpIpcService.providerOpenScopeFile` and reveals in OS file explorer — wire via `window.electronAPI.showItemInFolder` if available, else just surface the path).

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-provider-tab.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/tabs/orc-mcp-provider-tab.component.* \
  src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-provider-tab.component.spec.ts
git commit -m "feat(mcp-ui): reusable per-provider tab with scope groups"
```

---

## Task 3.6: Add server-edit form (shared by all three tab types)

**Context:** One small form component invoked from "+ Add" / "Edit" buttons across tabs. Emits a payload the caller routes to the right IPC method.

**Files:**
- Create: `src/renderer/app/features/mcp/components/mcp-server-edit-form.component.ts` (+ .html, .scss)
- Test: `.../__tests__/mcp-server-edit-form.component.spec.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('emits an upsert payload on save', () => {
  const fx = TestBed.createComponent(McpServerEditFormComponent);
  const emitted: any[] = [];
  fx.componentInstance.save.subscribe(v => emitted.push(v));
  fx.componentInstance.form.patchValue({
    name: 'fs', transport: 'stdio', command: 'npx', argsCsv: '-y,@mcp/fs',
  });
  fx.componentInstance.onSubmit();
  expect(emitted[0]).toMatchObject({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'] });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/components/__tests__/mcp-server-edit-form.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the form**

Reactive form with fields: name, description, transport (stdio|sse), command, argsCsv, url, envJson (raw text). On submit, split argsCsv + JSON.parse envJson. Emit via `@Output() save`.

```typescript
@Component({
  selector: 'orc-mcp-server-edit-form',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mcp-server-edit-form.component.html',
})
export class McpServerEditFormComponent {
  private readonly fb = inject(FormBuilder);
  readonly initial = input<Partial<RedactedMcpServerDto> | null>(null);
  @Output() readonly save = new EventEmitter<UpsertPayload>();
  @Output() readonly cancel = new EventEmitter<void>();

  readonly form = this.fb.group({
    name: ['', Validators.required],
    description: [''],
    transport: ['stdio' as 'stdio' | 'sse', Validators.required],
    command: [''],
    argsCsv: [''],
    url: [''],
    envJson: [''],
  });

  ngOnInit() {
    const init = this.initial();
    if (init) {
      this.form.patchValue({
        name: init.name ?? '',
        description: init.description ?? '',
        transport: init.transport ?? 'stdio',
        command: init.command ?? '',
        argsCsv: init.args?.join(',') ?? '',
        url: init.url ?? '',
        envJson: init.env ? JSON.stringify(init.env, null, 2) : '',
      });
    }
  }

  onSubmit(): void {
    const v = this.form.getRawValue();
    this.save.emit({
      name: v.name!,
      description: v.description || undefined,
      transport: v.transport!,
      command: v.command || undefined,
      args: v.argsCsv ? v.argsCsv.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      url: v.url || undefined,
      env: v.envJson ? JSON.parse(v.envJson) : undefined,
    });
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/components/__tests__/mcp-server-edit-form.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/components/mcp-server-edit-form.component.* \
  src/renderer/app/features/mcp/components/__tests__/mcp-server-edit-form.component.spec.ts
git commit -m "feat(mcp-ui): server edit form"
```

---

## Task 3.7: Wire Orchestrator tab to the edit form + IPC

**Files:**
- Modify: `src/renderer/app/features/mcp/tabs/orc-mcp-orchestrator-tab.component.ts`
- Modify: template + spec

- [ ] **Step 1: Write failing test**

Add test: clicking "+ Add" opens the form; submitting invokes `mcpIpc.orchestratorUpsert(...)` + triggers a `store.refresh()`.

```typescript
it('on + Add + submit, calls orchestratorUpsert and refreshes', async () => {
  const ipc = { orchestratorUpsert: vi.fn().mockResolvedValue({ success: true }) };
  const store = {
    orchestrator: signal([]),
    refresh: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: McpIpcService, useValue: ipc },
      { provide: McpMultiProviderStore, useValue: store },
    ],
  });
  const fx = TestBed.createComponent(OrcMcpOrchestratorTabComponent);
  fx.detectChanges();
  fx.componentInstance.beginAdd();
  fx.detectChanges();
  const form = fx.componentInstance.editFormRef();
  form!.save.emit({ name: 'x', transport: 'stdio', command: 'node' });
  await fx.whenStable();
  expect(ipc.orchestratorUpsert).toHaveBeenCalled();
  expect(store.refresh).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-orchestrator-tab.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Wire the form**

Add to the component:

```typescript
readonly editFormRef = viewChild(McpServerEditFormComponent);
readonly isAdding = signal(false);

beginAdd(): void { this.isAdding.set(true); this.selected.set(null); }
async onSave(payload: UpsertPayload): Promise<void> {
  const id = payload.name ? `orc:${payload.name}` : `orc:${Date.now()}`;
  const now = Date.now();
  await this.ipc.orchestratorUpsert({
    id, scope: 'orchestrator', autoConnect: true,
    createdAt: now, updatedAt: now, ...payload,
  });
  this.isAdding.set(false);
  await this.store.refresh();
}
```

Template: when `isAdding()` is true, render `<orc-mcp-server-edit-form (save)="onSave($event)" (cancel)="isAdding.set(false)" />` in the detail pane.

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-orchestrator-tab.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/tabs/orc-mcp-orchestrator-tab.component.*
git commit -m "feat(mcp-ui): Orchestrator tab — wire edit form to IPC"
```

---

## Task 3.8: Wire Shared tab to edit form + fan-out + drift actions

**Files:**
- Modify: `src/renderer/app/features/mcp/tabs/orc-mcp-shared-tab.component.ts`

- [ ] **Step 1: Write failing tests**

Two cases: (a) "+ Add shared" with form submit calls `sharedUpsert` + `sharedFanOut`; (b) clicking "Resolve → overwrite-target" on a drifted row calls `sharedResolveDrift`.

```typescript
it('fan-out: upsert + fanOut + refresh chain on save', async () => {
  const ipc = {
    sharedUpsert: vi.fn().mockResolvedValue({ success: true }),
    sharedFanOut: vi.fn().mockResolvedValue({ success: true, data: [] }),
  };
  const store = { shared: signal([]), refresh: vi.fn() };
  TestBed.configureTestingModule({ providers: [
    { provide: McpIpcService, useValue: ipc },
    { provide: McpMultiProviderStore, useValue: store },
  ]});
  const fx = TestBed.createComponent(OrcMcpSharedTabComponent);
  fx.detectChanges();
  await fx.componentInstance.onSave({
    name: 'fs', transport: 'stdio', command: 'npx', targets: ['claude', 'codex'],
  } as any);
  expect(ipc.sharedUpsert).toHaveBeenCalled();
  expect(ipc.sharedFanOut).toHaveBeenCalled();
  expect(store.refresh).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-shared-tab.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Wire actions**

Add handlers:

```typescript
async onSave(payload: UpsertSharedPayload): Promise<void> {
  const res = await this.ipc.sharedUpsert(payload);
  if (res.success) {
    const id = (res.data as any)?.id ?? `shared:${payload.name}`;
    await this.ipc.sharedFanOut({ serverId: id, providers: payload.targets });
  }
  await this.store.refresh();
}

async onResolveDrift(serverId: string, provider: SupportedProvider, action: DriftResolution) {
  await this.ipc.sharedResolveDrift({ serverId, provider, action });
  await this.store.refresh();
}
```

Bind the "Installed in" checklist so toggling a checkbox updates `targets` via `sharedUpsert` + `sharedFanOut`.

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-shared-tab.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/tabs/orc-mcp-shared-tab.component.*
git commit -m "feat(mcp-ui): Shared tab — fan-out + drift resolution wiring"
```

---

## Task 3.9: Wire Provider tab user-scope CRUD + scope-file reveal

**Files:**
- Modify: `src/renderer/app/features/mcp/tabs/orc-mcp-provider-tab.component.ts`

- [ ] **Step 1: Write failing tests**

```typescript
it('user + Add → providerUserUpsert called', async () => {
  const ipc = { providerUserUpsert: vi.fn().mockResolvedValue({ success: true }) };
  const store = { providerTab: () => signal({ provider: 'claude', servers: [] }), refresh: vi.fn() };
  TestBed.configureTestingModule({ providers: [
    { provide: McpIpcService, useValue: ipc },
    { provide: McpMultiProviderStore, useValue: store },
  ]});
  const fx = TestBed.createComponent(OrcMcpProviderTabComponent);
  fx.componentRef.setInput('provider', 'claude');
  fx.detectChanges();
  await fx.componentInstance.onSave({ name: 'x', transport: 'stdio', command: 'node' } as any);
  expect(ipc.providerUserUpsert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', name: 'x' }));
});

it('clicking a read-only row calls providerOpenScopeFile with scope', async () => {
  const ipc = { providerOpenScopeFile: vi.fn().mockResolvedValue({ success: true, data: { filePath: '.mcp.json' } }) };
  const store = {
    providerTab: () => signal({
      provider: 'claude',
      servers: [{ id: 'p:gh', name: 'gh', scope: 'project', readOnly: true, sourceFile: '.mcp.json' }],
    }),
    refresh: vi.fn(),
  };
  TestBed.configureTestingModule({ providers: [
    { provide: McpIpcService, useValue: ipc },
    { provide: McpMultiProviderStore, useValue: store },
  ]});
  const fx = TestBed.createComponent(OrcMcpProviderTabComponent);
  fx.componentRef.setInput('provider', 'claude');
  fx.detectChanges();
  fx.nativeElement.querySelector('[data-scope="project"]')!.click();
  await fx.whenStable();
  expect(ipc.providerOpenScopeFile).toHaveBeenCalledWith({ provider: 'claude', scope: 'project' });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-provider-tab.component.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Wire the handlers**

```typescript
async onSave(payload: UpsertPayload): Promise<void> {
  await this.ipc.providerUserUpsert({ provider: this.provider(), ...payload });
  await this.store.refresh();
}

async onScopeRowClick(scope: McpScope): Promise<void> {
  if (scope === 'user') return;
  await this.ipc.providerOpenScopeFile({ provider: this.provider(), scope });
}
```

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/mcp/tabs/__tests__/orc-mcp-provider-tab.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/mcp/tabs/orc-mcp-provider-tab.component.*
git commit -m "feat(mcp-ui): Provider tab — user CRUD + read-only scope reveal"
```

---

## Task 3.10: Wire MCP settings section to new `mcp*` keys

**Context:** Spec §15. Once `SETTINGS_METADATA` has the three new entries (Task 0.8), the settings UI generation picks them up automatically — but verify and add a small feature test that the Settings page renders them under a `category: 'mcp'` section.

**Files:**
- Modify (only if a category block needs adding): `src/renderer/app/features/settings/settings.page.component.*`
- Test: `src/renderer/app/features/settings/__tests__/settings.page.component.spec.ts`

- [ ] **Step 1: Write failing test**

Append a case:

```typescript
it('renders the three MCP safety toggles under an MCP section', () => {
  const fx = TestBed.createComponent(SettingsPageComponent);
  fx.detectChanges();
  const section = fx.nativeElement.querySelector('[data-test="settings-section-mcp"]');
  expect(section).toBeTruthy();
  expect(section.textContent).toContain('Clean up MCP config backups');
  expect(section.textContent).toContain('world-writable');
  expect(section.textContent).toContain('backups');
});
```

- [ ] **Step 2: Run and see it fail**

Run: `npx vitest run src/renderer/app/features/settings/__tests__/settings.page.component.spec.ts`
Expected: FAIL if the category isn't rendered.

- [ ] **Step 3: Ensure template includes `category: 'mcp'`**

If the settings template iterates `groupedSettings()`, the new entries will render automatically. If an explicit list of allowed categories exists, add `'mcp'` to it. Add a group header label: `MCP Safety`.

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/renderer/app/features/settings/__tests__/settings.page.component.spec.ts
npx tsc --noEmit
git add src/renderer/app/features/settings/settings.page.component.* \
  src/renderer/app/features/settings/__tests__/settings.page.component.spec.ts
git commit -m "feat(settings): surface MCP safety settings in Settings page"
```

---

# Phase 4 — Wrap-up + verification

## Task 4.1: Generalize `testConfig` to read from Orchestrator-scope servers

**Context:** Spec §16. The existing "Test config" button in the Test page should pull MCP servers from `OrchestratorMcpRepository` (not the bootstrap JSON). Goal: use the multi-provider state as the single source of truth.

**Files:**
- Modify: `src/main/test-config/test-config.service.ts` (or wherever test-config reads MCP)
- Test: corresponding spec

- [ ] **Step 1: Locate the existing testConfig read path**

Run: `grep -rn "MCP_CONFIG_PATH\|mcp-servers.json\|buildMcpConfigPaths" src/main/test-config src/main/instance`
Expected: one or two hits showing the current hardcoded read.

- [ ] **Step 2: Write failing test**

In the test-config service spec, add a case asserting that `getTestConfig()` returns the same inline configs that `OrchestratorInjectionReader.buildBundle('claude')` produces when the repo has records.

- [ ] **Step 3: Replace the read with `getOrchestratorInjectionReader().buildBundle(provider).inlineConfigs`**

Edit the service to inject `OrchestratorInjectionReader` instead of reading the bootstrap file directly.

- [ ] **Step 4: Run + typecheck + commit**

```bash
npx vitest run src/main/test-config/__tests__/*.spec.ts
npx tsc --noEmit
git add src/main/test-config/ src/main/instance/instance-lifecycle.ts
git commit -m "feat(mcp): testConfig reads from OrchestratorInjectionReader"
```

---

## Task 4.2: Add manual-verification runbook

**Context:** Final human-in-the-loop check before merging. Covers all 14 IPC paths + the three UI tabs + the three safety settings.

**Files:**
- Create: `docs/superpowers/verifications/2026-04-21-mcp-multi-provider_completed.md`

- [ ] **Step 1: Write the runbook**

Create the doc with numbered checklist items:

```markdown
# MCP Multi-Provider Manual Verification

Run `npm run dev` and verify each item.

## Orchestrator tab
1. [ ] Click Orchestrator tab — sidebar loads instantly, no "loading..." hang.
2. [ ] Click "+ Add", fill (name=test-orch, transport=stdio, command=/bin/echo, args=hi).
       Save. New row appears in sidebar within 1s.
3. [ ] Click the row, verify detail pane shows the data. All 4 provider checkboxes are checked.
4. [ ] Uncheck Copilot. State should persist across `Refresh` button.
5. [ ] Click Remove — row disappears.

## Shared tab
6. [ ] Click "+ Add shared", name=shared-fs, transport=stdio, command=npx, args=-y,@modelcontextprotocol/server-filesystem.
       Check Claude + Codex only. Save.
7. [ ] Detail pane: "in-sync" chip next to Claude + Codex; "—" next to Gemini + Copilot.
8. [ ] Open `~/.claude.json` in an external editor. Change shared-fs command to "DIFFERENT". Save.
9. [ ] Back in the app, click Refresh. Banner shows "Drift detected". Chip next to Claude flips to "drifted".
10. [ ] Click "Resolve → overwrite-target" in the banner. Chip flips back to "in-sync" within 1s. File on disk matches canonical.

## Provider tabs
11. [ ] Click each of Claude / Codex / Gemini / Copilot tabs. User section shows "+ Add".
12. [ ] Project / Local sections show 🔒 icon + source-file path.
13. [ ] Click a read-only row — source-file reveals in OS file explorer (or path is surfaced).
14. [ ] In Claude tab, create a user-scope server, verify it appears + `~/.claude.json` contains it.

## Safety settings
15. [ ] Settings → MCP Safety → "Clean up MCP config backups on quit" defaults ON.
16. [ ] Toggle "Don't write backups" ON — confirm warning text appears. Save. Edit a user server.
       Verify no `.orc.bak-*` file is created.
17. [ ] Toggle "Allow world-writable parent" → warning shows.

## Codex comment preservation
18. [ ] Manually add `# IMPORTANT — keep me` to `~/.codex/config.toml`.
19. [ ] Edit a user-scope Codex MCP server in the UI + save.
20. [ ] Open config.toml — the comment survives.

## Session start
21. [ ] Restart Orchestrator. Tabs populate with all previously saved servers.
22. [ ] Launch a Claude instance — `claude` process receives `--mcp-config` for the Orchestrator bundle.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/verifications/2026-04-21-mcp-multi-provider_completed.md
git commit -m "docs(mcp): manual verification runbook"
```

---

## Task 4.3: Update `docs/architecture.md` with an MCP Multi-Provider section

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1: Append section**

Find the "Subsystems" heading in `docs/architecture.md` and add:

```markdown
## MCP Multi-Provider

Main-process layer managing MCP servers across Claude Code, Codex, Gemini, and
Copilot CLIs plus two Orchestrator-owned scopes (Shared, Orchestrator).

Key files:
- `src/main/mcp/cli-mcp-config-service.ts` — per-provider orchestrator; IPC targets this.
- `src/main/mcp/shared-mcp-coordinator.ts` — fan-out writes + drift detection.
- `src/main/mcp/orchestrator-injection-reader.ts` — builds spawn-time `McpInjectionBundle`.
- `src/main/mcp/adapters/*-mcp-adapter.ts` — per-provider config file readers/writers.
- `src/main/mcp/write-safety-helper.ts` — atomic writes + backups + parent-permission guard.
- `src/main/mcp/secret-storage.ts` — safeStorage wrapper with plaintext+quarantine fallback.

Data flow (renderer → write):
`McpPage` → `McpIpcService` → IPC handler → `CliMcpConfigService` or
`SharedMcpCoordinator` → `ProviderMcpAdapter` → `WriteSafetyHelper` → disk.

Data flow (disk → renderer):
`FsWatcherManager.on('change')` → `CliMcpConfigService.bumpStateVersion()` →
broadcast `MCP_MULTI_PROVIDER_STATE_CHANGED` → `McpMultiProviderStore`.

Spec: `docs/superpowers/specs/2026-04-21-mcp-multi-provider-management-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: MCP multi-provider architecture section"
```

---

## Task 4.4: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green (new + existing).

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors (warnings acceptable only if pre-existing).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Angular + Electron build completes successfully.

- [ ] **Step 5: Run the manual verification runbook**

Execute every numbered item in `docs/superpowers/verifications/2026-04-21-mcp-multi-provider_completed.md`.

- [ ] **Step 6: Observation #0.10 informs a final audit**

Revisit `docs/superpowers/observations/2026-04-21-claude-mcp-config-flag.md`. If the flag is `merge`, no further code change is needed — confirm Task 1.12 passes both bootstrap + inline configs. If `replace`, replace the multi-path plumbing in `instance-lifecycle.ts` with an in-process merge before `--mcp-config`.

- [ ] **Step 7: Summary commit**

```bash
git commit --allow-empty -m "chore(mcp): Phase 4 verification complete"
```

---

## Completion checklist

- [ ] Phase 0: 10 tasks (foundation types + schemas + migrations + settings + secret storage + observation)
- [ ] Phase 1: 12 tasks (adapters + repos + WriteSafetyHelper + OrchestratorInjectionReader + Codex TOML refactor + lifecycle wiring)
- [ ] Phase 2: 9 tasks (CliMcpConfigService + SharedMcpCoordinator + FsWatcherManager + IPC handlers + singletons + preload + renderer facade + store + integration test)
- [ ] Phase 3: 10 tasks (page restructure + detail panel + 3 tab types + edit form + wiring all three tabs + settings UI verification)
- [ ] Phase 4: 4 tasks (testConfig generalization + manual runbook + architecture docs + final verification)

**Total: 45 tasks.** Work them in order; do not skip test-then-implement pairs.
