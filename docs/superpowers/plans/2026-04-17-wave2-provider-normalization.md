# Wave 2 — Provider Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize the four provider adapters (Claude, Codex, Gemini, Copilot) behind one typed, Observable-driven `ProviderAdapter` contract so every downstream consumer — orchestration, telemetry, IPC, renderer — sees one `ProviderRuntimeEventEnvelope` shape regardless of the underlying CLI.

**Architecture:** Add `eventId` (UUID v4) + `seq` (monotonic per instance) to the envelope; ship a new `ProviderAdapter` SDK interface + `ProviderAdapterRegistry`. Migrate producers, consumers, and IPC in three internal phases within one wave: (1) scaffold Subject-backed `events$` on `BaseProvider` alongside existing EventEmitter via subscribe-to-self bridge; (2) migrate all consumers (main + IPC + renderer) to `events$`; (3) rewrite each adapter to push envelopes directly via `pushEvent()`, delete mappers, drop `extends EventEmitter`.

**Tech Stack:** TypeScript 5.9, Electron 40, Angular 21 (signals, zoneless), Node 20+, RxJS 7.8, Zod 4, Vitest 3, better-sqlite3.

**Spec:** [`../specs/2026-04-17-wave2-provider-normalization-design.md`](../specs/2026-04-17-wave2-provider-normalization-design.md)

---

## Preamble — Codebase Reality Check

The spec describes a target `ProviderAdapter` interface with aspirational method signatures. The actual `BaseProvider` in `src/main/providers/provider-interface.ts` has these existing signatures that **we are keeping** (per Q2 "minimal interface"):

- `abstract getType(): ProviderType` — returns the full `ProviderType` (`'claude-cli' | 'anthropic-api' | 'openai' | …`), not the CLI short name.
- `abstract getCapabilities(): ProviderCapabilities` — returns the existing 7-flag `ProviderCapabilities` (toolExecution, streaming, multiTurn, vision, fileAttachments, functionCalling, builtInCodeTools). Stays.
- `abstract checkStatus(): Promise<ProviderStatus>` — stays async.
- `abstract initialize(options: ProviderSessionOptions): Promise<void>` — `ProviderSessionOptions` has `sessionId?`, not `instanceId`.
- `abstract sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void>`
- `abstract terminate(graceful?: boolean): Promise<void>`
- `getUsage(): ProviderUsage | null`, `getPid(): number | null`, `isRunning(): boolean`, `getSessionId(): string` — all stay.

**New additions on `BaseProvider` / `ProviderAdapter`:**
- `readonly provider: ProviderName` — where `ProviderName = 'claude' | 'codex' | 'gemini' | 'copilot'` (the CLI short name, matching `InstanceProvider`).
- `readonly capabilities: ProviderAdapterCapabilities` — the **new 6-flag** adapter-level capability struct (see spec §2.4). Coexists with `getCapabilities()`; they answer different questions.
- `readonly events$: Observable<ProviderRuntimeEventEnvelope>`.
- `protected pushEvent(event: ProviderRuntimeEvent): void` and lifecycle helpers.
- `protected instanceId: string` — set from `ProviderSessionOptions.instanceId` (a new optional field we add in Task 1b).

**Envelope breaking changes** (Task 1):
- Add `eventId: string` (UUID v4).
- Add `seq: number`.
- Change `timestamp: string` (ISO) → `timestamp: number` (ms since epoch).
- Change `provider: string` → `provider: ProviderName`.

**Deleted at end of Wave 2:**
- `src/main/providers/event-normalizer.ts` (all 4 mapper classes + `normalizeAdapterEvent()`).
- `src/main/providers/normalizer-registry.ts` if it exists as separate file.
- `ProviderEventMapper` interface (in contracts).
- `extends EventEmitter` on `BaseProvider` + the `ProviderEvents` interface.
- 9 legacy per-event-type IPC channels, replaced by single `PROVIDER_RUNTIME_EVENT`.

---

## File Structure

### New files

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/schemas/provider-runtime-events.schemas.ts` | Zod schemas for envelope + 9-kind union |
| `packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts` | Zod schema unit tests |
| `packages/contracts/src/__fixtures__/provider-events/<provider>/<scenario>.jsonl` | Raw provider CLI captures |
| `packages/contracts/src/__fixtures__/provider-events/<provider>/<scenario>.golden.jsonl` | Expected envelope sequences |
| `packages/sdk/src/provider-adapter.ts` | `ProviderAdapter` interface + `ProviderAdapterCapabilities` |
| `packages/sdk/src/provider-adapter-registry.ts` | `ProviderAdapterRegistry` interface + `ProviderAdapterDescriptor` + factory type |
| `src/main/providers/provider-adapter-registry.ts` | `ProviderAdapterRegistryImpl` + singleton export |
| `src/main/providers/__tests__/provider-adapter-registry.spec.ts` | Registry unit tests |
| `src/main/providers/__tests__/base-provider.spec.ts` | BaseProvider Subject/pushEvent/helper tests |
| `src/main/providers/register-built-in-providers.ts` | Registers 4 built-in adapters |
| `src/main/providers/__tests__/parity/provider-parity.spec.ts` | 36-cell synthesized parity matrix |
| `src/main/providers/__tests__/parity/fixture-replay.spec.ts` | Recorded-fixture regression test |
| `scripts/record-provider-fixture.ts` | CLI helper to capture new fixtures |

### Modified files

| Path | Change |
| --- | --- |
| `packages/contracts/src/types/provider-runtime-events.ts` | Envelope v2 fields + `@frozen` JSDoc on union + `ProviderName` type (later: delete `ProviderEventMapper`) |
| `packages/contracts/package.json` | Add subpath exports for new schema + types |
| `packages/sdk/package.json` | Add subpath exports for new interfaces |
| `packages/sdk/src/providers.ts` | Delete deprecated `ProviderEvent` alias |
| `packages/contracts/src/channels/*.ts` | Add `PROVIDER_RUNTIME_EVENT`; later delete 9 legacy channels |
| `src/main/providers/provider-interface.ts` | Add `events$`, `pushEvent`, lifecycle helpers, subscribe-to-self bridge; later drop `extends EventEmitter` |
| `src/shared/types/provider.types.ts` | Add `instanceId?: string` to `ProviderSessionOptions` |
| `src/main/providers/claude-provider.ts` | Inline translation at emit sites; `DESCRIPTOR` + `provider` + `capabilities` |
| `src/main/providers/codex-provider.ts` | Same |
| `src/main/providers/gemini-provider.ts` | Drop Codex delegation + inline translation + descriptor |
| `src/main/providers/copilot-provider.ts` | Drop Codex delegation + inline translation + descriptor |
| `src/main/providers/provider-registry.ts` | Split: factory logic → registry impl; remaining becomes `ProviderInstanceManager` |
| `src/main/services/instance-communication.ts` | Subscribe to `events$`; remove legacy `.on()` listeners; forward envelopes on new channel |
| `src/main/telemetry/**` + `src/main/observability/**` | Subscribe to `events$` for span correlation |
| `src/main/orchestration/**` | Filter-subscribe on `events$` for complete/error |
| `src/main/providers/failover-manager.ts` | Filter-subscribe for exit/error |
| `src/main/providers/activity-state-detector.ts` | Filter-subscribe for status |
| `src/preload/preload.ts` | Add `onProviderRuntimeEvent(cb)`; later remove per-kind listeners |
| `src/renderer/app/core/services/instance-events.service.ts` (or equivalent) | Subject-based `events$` + filtered streams |
| Renderer components consuming legacy per-kind streams | Migrate to `events$` / filtered streams |

### Deleted files (Phase 6)

| Path | Why |
| --- | --- |
| `src/main/providers/event-normalizer.ts` | All 4 mapper classes + `normalizeAdapterEvent()` superseded by inlined translation |
| `src/main/providers/normalizer-registry.ts` (if split out) | Same |
| `src/main/providers/__tests__/event-normalizer.spec.ts` | Replaced by parity tests |

---

## Task Dependency Overview

```
Phase 1 (Contracts)          ── Tasks 1-5
         │
         ▼
Phase 2 (Producer scaffold)  ── Tasks 6-9
         │
         ▼
Phase 3 (Registry)           ── Tasks 10-12
         │
         ▼
Phase 4 (Consumer migration) ── Tasks 13-19
         │
         ▼
Phase 5 (Producer migration) ── Tasks 20-24
         │
         ▼
Phase 6 (Legacy removal)     ── Tasks 25-27
```

Each phase's checkpoint matches Spec §10.1. Do not start a phase until the previous one's final test suite + lint + build is green.

---

## Phase 1: Contracts Layer

### Task 1: Extend envelope type with eventId, seq, stronger timestamp and provider types

**Files:**
- Modify: `packages/contracts/src/types/provider-runtime-events.ts`
- Modify: `src/main/providers/event-normalizer.ts` (only `normalizeAdapterEvent()` — fix the envelope construction to produce the new shape; mappers still exist for Phase 1 bridging)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/types/__tests__/provider-runtime-events.types.spec.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type {
  ProviderRuntimeEventEnvelope,
  ProviderName,
} from '@contracts/types/provider-runtime-events';

describe('ProviderRuntimeEventEnvelope shape', () => {
  it('has eventId, seq, numeric timestamp, and typed provider', () => {
    const env: ProviderRuntimeEventEnvelope = {
      eventId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      seq: 0,
      timestamp: 1713340800000,
      provider: 'claude',
      instanceId: 'i-1',
      event: { kind: 'status', status: 'busy' },
    };
    expectTypeOf(env.eventId).toEqualTypeOf<string>();
    expectTypeOf(env.seq).toEqualTypeOf<number>();
    expectTypeOf(env.timestamp).toEqualTypeOf<number>();
    expectTypeOf(env.provider).toEqualTypeOf<ProviderName>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/types/__tests__/provider-runtime-events.types.spec.ts`
Expected: FAIL — `eventId`, `seq` do not exist on type; `timestamp` is `string`; `provider` is `string`.

- [ ] **Step 3: Update the envelope type and add `ProviderName`**

Edit `packages/contracts/src/types/provider-runtime-events.ts`. Replace the `ProviderRuntimeEventEnvelope` interface and prepend the new `ProviderName` export, and add `@frozen` JSDoc on the union:

```typescript
/**
 * CLI-level provider name used in the envelope and adapter registry.
 * Matches `InstanceProvider` in `@shared/types/instance.types`.
 */
export type ProviderName = 'claude' | 'codex' | 'gemini' | 'copilot';

/**
 * Discriminated union of all provider runtime events.
 *
 * @frozen as of Wave 2 (2026-04-17). See the Wave 3 design doc for the v2
 * taxonomy (5-family hierarchical). Do not add new `kind` values to this
 * union. Additive optional fields on existing kinds are permitted.
 */
export type ProviderRuntimeEvent =
  | ProviderOutputEvent
  | ProviderToolUseEvent
  | ProviderToolResultEvent
  | ProviderStatusEvent
  | ProviderContextEvent
  | ProviderErrorEvent
  | ProviderExitEvent
  | ProviderSpawnedEvent
  | ProviderCompleteEvent;

export interface ProviderRuntimeEventEnvelope {
  /** UUID v4 — globally unique, stable across IPC. */
  readonly eventId: string;
  /** Monotonic per-instance counter starting at 0. Renderer gap-detection. */
  readonly seq: number;
  /** Milliseconds since epoch (Date.now()). */
  readonly timestamp: number;
  /** CLI-level provider name. */
  readonly provider: ProviderName;
  readonly instanceId: string;
  readonly sessionId?: string;
  readonly event: ProviderRuntimeEvent;
}
```

- [ ] **Step 4: Fix the existing envelope producer in `event-normalizer.ts`**

Edit `src/main/providers/event-normalizer.ts`. Locate `normalizeAdapterEvent()` (or wherever envelopes are constructed). Replace the envelope-construction block so it produces the new shape. Example of what the constructor call should look like:

```typescript
import { randomUUID } from 'node:crypto';

// inside normalizeAdapterEvent(...) where an envelope is built:
const envelope: ProviderRuntimeEventEnvelope = {
  eventId: randomUUID(),
  seq: seq++,                           // caller supplies a per-instance counter
  timestamp: Date.now(),
  provider,                             // must be narrowed to ProviderName
  instanceId,
  sessionId,
  event,
};
```

If `normalizeAdapterEvent` does not currently accept a per-instance seq, add it as a parameter. Callers will be migrated by Task 8 (bridge subscribes) and Task 25 (deletion) — for now, just pass `0` at the single existing call site and silence any TS errors.

- [ ] **Step 5: Run tests to verify type + build pass**

Run: `npx vitest run packages/contracts/src/types/__tests__/provider-runtime-events.types.spec.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS. If any call sites reference `envelope.timestamp` as a string (e.g., `.toISOString()`), fix them to treat it as `number` (format with `new Date(envelope.timestamp).toISOString()` where display is needed).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/types/provider-runtime-events.ts \
        packages/contracts/src/types/__tests__/provider-runtime-events.types.spec.ts \
        src/main/providers/event-normalizer.ts
git commit -m "feat(contracts): extend ProviderRuntimeEventEnvelope with eventId+seq, typed provider, numeric timestamp"
```

---

### Task 1b: Add instanceId to ProviderSessionOptions

**Files:**
- Modify: `src/shared/types/provider.types.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/types/__tests__/provider.types.spec.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { ProviderSessionOptions } from '@shared/types/provider.types';

describe('ProviderSessionOptions', () => {
  it('includes optional instanceId for event envelope correlation', () => {
    const opts: ProviderSessionOptions = {
      workingDirectory: '/tmp',
      instanceId: 'inst-42',
    };
    expectTypeOf(opts.instanceId).toEqualTypeOf<string | undefined>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/types/__tests__/provider.types.spec.ts`
Expected: FAIL — `instanceId` not in `ProviderSessionOptions`.

- [ ] **Step 3: Add the field**

Edit `src/shared/types/provider.types.ts`. In `ProviderSessionOptions`, after `sessionId?: string;`:

```typescript
export interface ProviderSessionOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  workingDirectory: string;
  sessionId?: string;
  /**
   * Stable identifier for the orchestrator instance this session belongs to.
   * Populated into every `ProviderRuntimeEventEnvelope.instanceId` emitted by
   * the adapter. Added in Wave 2 (2026-04-17).
   */
  instanceId?: string;
  resume?: boolean;
  toolsEnabled?: boolean;
  yoloMode?: boolean;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run src/shared/types/__tests__/provider.types.spec.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/provider.types.ts \
        src/shared/types/__tests__/provider.types.spec.ts
git commit -m "feat(shared): add instanceId to ProviderSessionOptions"
```

---

### Task 2: Zod schema for envelope + 9-kind event union

**Files:**
- Create: `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`
- Create: `packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';

const baseEnv = {
  eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
  seq: 0,
  timestamp: 1713340800000,
  provider: 'claude' as const,
  instanceId: 'inst-1',
  event: { kind: 'status', status: 'busy' },
};

describe('ProviderRuntimeEventEnvelopeSchema', () => {
  it('parses a valid envelope', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse(baseEnv)).not.toThrow();
  });

  it('rejects a non-UUID eventId', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, eventId: 'not-a-uuid' })).toThrow();
  });

  it('rejects a negative seq', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, seq: -1 })).toThrow();
  });

  it('rejects an unknown provider', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, provider: 'ollama' })).toThrow();
  });

  it('rejects an unknown event.kind', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, event: { kind: 'nope' } })
    ).toThrow();
  });

  it('rejects a string timestamp (old shape)', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, timestamp: '2026-04-17T00:00:00Z' })
    ).toThrow();
  });

  it('accepts each of the 9 event kinds', () => {
    const kinds = [
      { kind: 'output', content: 'hi' },
      { kind: 'tool_use', toolName: 'bash' },
      { kind: 'tool_result', toolName: 'bash', success: true },
      { kind: 'status', status: 'busy' },
      { kind: 'context', used: 10, total: 200 },
      { kind: 'error', message: 'oops' },
      { kind: 'exit', code: 0, signal: null },
      { kind: 'spawned', pid: 1234 },
      { kind: 'complete' },
    ] as const;
    for (const event of kinds) {
      expect(() =>
        ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, event })
      ).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts`
Expected: FAIL — module `@contracts/schemas/provider-runtime-events` not found.

- [ ] **Step 3: Create the schema file**

Create `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`:

```typescript
import { z } from 'zod';

export const ProviderNameSchema = z.enum(['claude', 'codex', 'gemini', 'copilot']);

const ProviderOutputEventSchema = z.object({
  kind: z.literal('output'),
  content: z.string(),
  messageType: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ProviderToolUseEventSchema = z.object({
  kind: z.literal('tool_use'),
  toolName: z.string(),
  toolUseId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});

const ProviderToolResultEventSchema = z.object({
  kind: z.literal('tool_result'),
  toolName: z.string(),
  toolUseId: z.string().optional(),
  output: z.string().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});

const ProviderStatusEventSchema = z.object({
  kind: z.literal('status'),
  status: z.string(),
});

const ProviderContextEventSchema = z.object({
  kind: z.literal('context'),
  used: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  percentage: z.number().optional(),
});

const ProviderErrorEventSchema = z.object({
  kind: z.literal('error'),
  message: z.string(),
  recoverable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});

const ProviderExitEventSchema = z.object({
  kind: z.literal('exit'),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});

const ProviderSpawnedEventSchema = z.object({
  kind: z.literal('spawned'),
  pid: z.number().int().nonnegative(),
});

const ProviderCompleteEventSchema = z.object({
  kind: z.literal('complete'),
  tokensUsed: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const ProviderRuntimeEventSchema = z.discriminatedUnion('kind', [
  ProviderOutputEventSchema,
  ProviderToolUseEventSchema,
  ProviderToolResultEventSchema,
  ProviderStatusEventSchema,
  ProviderContextEventSchema,
  ProviderErrorEventSchema,
  ProviderExitEventSchema,
  ProviderSpawnedEventSchema,
  ProviderCompleteEventSchema,
]);

export const ProviderRuntimeEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  provider: ProviderNameSchema,
  instanceId: z.string().min(1),
  sessionId: z.string().optional(),
  event: ProviderRuntimeEventSchema,
});
```

- [ ] **Step 4: Wire the subpath into package.json exports**

Edit `packages/contracts/package.json`. In the `exports` block, add:

```json
    "./schemas/provider-runtime-events": {
      "types": "./src/schemas/provider-runtime-events.schemas.ts",
      "import": "./src/schemas/provider-runtime-events.schemas.ts",
      "require": "./src/schemas/provider-runtime-events.schemas.ts"
    },
```

Edit `tsconfig.json` and `tsconfig.electron.json`: add the path mapping alongside the other `@contracts/schemas/*` entries:

```json
      "@contracts/schemas/provider-runtime-events": ["./packages/contracts/src/schemas/provider-runtime-events.schemas"],
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts`
Expected: PASS (all 7 tests).

Run: `npm run verify:exports`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/schemas/provider-runtime-events.schemas.ts \
        packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts \
        packages/contracts/package.json \
        tsconfig.json \
        tsconfig.electron.json
git commit -m "feat(contracts): add Zod schema for ProviderRuntimeEventEnvelope"
```

---

### Task 3: SDK ProviderAdapter interface + capabilities

**Files:**
- Create: `packages/sdk/src/provider-adapter.ts`
- Create: `packages/sdk/src/__tests__/provider-adapter.types.spec.ts`
- Modify: `packages/sdk/package.json`
- Modify: `tsconfig.json` + `tsconfig.electron.json`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/__tests__/provider-adapter.types.spec.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { Observable } from 'rxjs';
import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
} from '@sdk/provider-adapter';
import type {
  ProviderName,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';

describe('ProviderAdapter', () => {
  it('has provider, capabilities, and events$', () => {
    type P = Pick<ProviderAdapter, 'provider' | 'capabilities' | 'events$'>;
    expectTypeOf<P['provider']>().toEqualTypeOf<ProviderName>();
    expectTypeOf<P['capabilities']>().toEqualTypeOf<ProviderAdapterCapabilities>();
    expectTypeOf<P['events$']>().toEqualTypeOf<Observable<ProviderRuntimeEventEnvelope>>();
  });

  it('ProviderAdapterCapabilities has all 6 flags', () => {
    const caps: ProviderAdapterCapabilities = {
      interruption: true,
      permissionPrompts: true,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: true,
    };
    expectTypeOf(caps).toEqualTypeOf<ProviderAdapterCapabilities>();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/sdk/src/__tests__/provider-adapter.types.spec.ts`
Expected: FAIL — module `@sdk/provider-adapter` not found.

- [ ] **Step 3: Create the interface file**

Create `packages/sdk/src/provider-adapter.ts`:

```typescript
import type { Observable } from 'rxjs';
import type {
  ProviderName,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import type {
  ProviderConfig,
  ProviderStatus,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
  ProviderCapabilities,
} from '@shared/types/provider.types';

/**
 * Adapter-level capability flags — distinct from the existing model-capability
 * `ProviderCapabilities` (toolExecution/streaming/vision/...). These flags
 * answer "what can the runtime adapter do", not "what does the model support".
 */
export interface ProviderAdapterCapabilities {
  /** Supports `interruptTurn()` / mid-turn cancellation. */
  readonly interruption: boolean;
  /** Surfaces tool-use confirmation prompts. */
  readonly permissionPrompts: boolean;
  /** Can resume against a persisted session id. */
  readonly sessionResume: boolean;
  /** Emits streaming `output` events mid-turn (not batch-on-complete). */
  readonly streamingOutput: boolean;
  /** `getUsage()` returns real data. */
  readonly usageReporting: boolean;
  /** Spawns sub-agents (Claude Task tool, etc.). */
  readonly subAgents: boolean;
}

/**
 * Unified provider adapter contract. Consumers subscribe to `events$` for a
 * typed envelope stream and invoke the existing lifecycle methods unchanged.
 *
 * Wave 2 addition. See docs/superpowers/specs/2026-04-17-wave2-provider-normalization-design.md.
 */
export interface ProviderAdapter {
  readonly provider: ProviderName;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly events$: Observable<ProviderRuntimeEventEnvelope>;

  getCapabilities(): ProviderCapabilities;
  checkStatus(): Promise<ProviderStatus>;
  initialize(options: ProviderSessionOptions): Promise<void>;
  sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void>;
  terminate(graceful?: boolean): Promise<void>;
  getUsage(): ProviderUsage | null;
  getPid(): number | null;
  isRunning(): boolean;
  getSessionId(): string;
}
```

- [ ] **Step 4: Wire subpath export**

Edit `packages/sdk/package.json` `exports`:

```json
    "./provider-adapter": {
      "types": "./src/provider-adapter.ts",
      "import": "./src/provider-adapter.ts",
      "require": "./src/provider-adapter.ts"
    },
```

Edit `tsconfig.json` and `tsconfig.electron.json`: add the path mapping alongside existing `@sdk/*` entries:

```json
      "@sdk/provider-adapter": ["./packages/sdk/src/provider-adapter"],
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run packages/sdk/src/__tests__/provider-adapter.types.spec.ts`
Expected: PASS.

Run: `npm run verify:exports` and `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/provider-adapter.ts \
        packages/sdk/src/__tests__/provider-adapter.types.spec.ts \
        packages/sdk/package.json \
        tsconfig.json tsconfig.electron.json
git commit -m "feat(sdk): add ProviderAdapter interface + ProviderAdapterCapabilities"
```

---

### Task 4: SDK registry interface + descriptor + factory

**Files:**
- Create: `packages/sdk/src/provider-adapter-registry.ts`
- Create: `packages/sdk/src/__tests__/provider-adapter-registry.types.spec.ts`
- Modify: `packages/sdk/package.json`
- Modify: `tsconfig.json` + `tsconfig.electron.json`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/__tests__/provider-adapter-registry.types.spec.ts`:

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type {
  ProviderAdapterRegistry,
  ProviderAdapterDescriptor,
  ProviderAdapterFactory,
} from '@sdk/provider-adapter-registry';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type { ProviderConfig } from '@shared/types/provider.types';

describe('ProviderAdapterRegistry types', () => {
  it('registry has list / get / create / register', () => {
    type R = ProviderAdapterRegistry;
    expectTypeOf<R['list']>().returns.toEqualTypeOf<readonly ProviderAdapterDescriptor[]>();
    expectTypeOf<R['create']>().parameters.toEqualTypeOf<[
      ProviderAdapterDescriptor['provider'],
      ProviderConfig,
    ]>();
    expectTypeOf<R['create']>().returns.toEqualTypeOf<ProviderAdapter>();
  });

  it('factory is (config) => ProviderAdapter', () => {
    expectTypeOf<ProviderAdapterFactory>().parameters.toEqualTypeOf<[ProviderConfig]>();
    expectTypeOf<ProviderAdapterFactory>().returns.toEqualTypeOf<ProviderAdapter>();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/sdk/src/__tests__/provider-adapter-registry.types.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the file**

Create `packages/sdk/src/provider-adapter-registry.ts`:

```typescript
import type { ProviderConfig } from '@shared/types/provider.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter, ProviderAdapterCapabilities } from '@sdk/provider-adapter';

export interface ProviderAdapterDescriptor {
  readonly provider: ProviderName;
  readonly displayName: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly defaultConfig: ProviderConfig;
}

export type ProviderAdapterFactory = (config: ProviderConfig) => ProviderAdapter;

export interface ProviderAdapterRegistry {
  list(): readonly ProviderAdapterDescriptor[];
  get(provider: ProviderName): ProviderAdapterDescriptor;
  create(provider: ProviderName, config: ProviderConfig): ProviderAdapter;
  register(descriptor: ProviderAdapterDescriptor, factory: ProviderAdapterFactory): void;
}
```

- [ ] **Step 4: Wire subpath export**

Edit `packages/sdk/package.json` `exports`:

```json
    "./provider-adapter-registry": {
      "types": "./src/provider-adapter-registry.ts",
      "import": "./src/provider-adapter-registry.ts",
      "require": "./src/provider-adapter-registry.ts"
    },
```

Edit `tsconfig.json` and `tsconfig.electron.json`:

```json
      "@sdk/provider-adapter-registry": ["./packages/sdk/src/provider-adapter-registry"],
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run packages/sdk/src/__tests__/provider-adapter-registry.types.spec.ts`
Expected: PASS.

Run: `npm run verify:exports` and `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/provider-adapter-registry.ts \
        packages/sdk/src/__tests__/provider-adapter-registry.types.spec.ts \
        packages/sdk/package.json \
        tsconfig.json tsconfig.electron.json
git commit -m "feat(sdk): add ProviderAdapterRegistry interface + descriptor"
```

---

### Task 5: Phase 1 checkpoint — full verify + build green

- [ ] **Step 1: Run the full Phase 1 gate**

Run each in sequence (stop on first failure):
```
npm run lint
npm run verify:ipc
npm run verify:exports
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.electron.json
npm run build:main
npm run test -- packages/contracts/src packages/sdk/src src/shared/types
```
Expected: all PASS.

- [ ] **Step 2: No commit (verification only). Proceed to Phase 2.**

---

## Phase 2: Producer Scaffolding

### Task 6: Add Subject + events$ + abstract provider/capabilities to BaseProvider

**Files:**
- Modify: `src/main/providers/provider-interface.ts`
- Create: `src/main/providers/__tests__/base-provider.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/providers/__tests__/base-provider.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BaseProvider } from '@main/providers/provider-interface';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type { ProviderConfig, ProviderStatus, ProviderSessionOptions, ProviderCapabilities } from '@shared/types/provider.types';
import type { ProviderName, ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

class TestProvider extends BaseProvider {
  readonly provider: ProviderName = 'claude';
  readonly capabilities: ProviderAdapterCapabilities = {
    interruption: true, permissionPrompts: true, sessionResume: true,
    streamingOutput: true, usageReporting: true, subAgents: true,
  };
  getType() { return 'claude-cli' as const; }
  getCapabilities(): ProviderCapabilities {
    return { toolExecution: true, streaming: true, multiTurn: true, vision: false, fileAttachments: false, functionCalling: true, builtInCodeTools: true };
  }
  async checkStatus(): Promise<ProviderStatus> { return { type: 'claude-cli', available: true, authenticated: true }; }
  async initialize(_opts: ProviderSessionOptions): Promise<void> {}
  async sendMessage(_m: string): Promise<void> {}
  async terminate(): Promise<void> {}
}

describe('BaseProvider.events$', () => {
  it('exposes an Observable of envelopes', async () => {
    const cfg: ProviderConfig = { type: 'claude-cli', name: 'test', enabled: true };
    const p = new TestProvider(cfg);
    const received: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => received.push(e));
    // Nothing emitted yet
    expect(received).toHaveLength(0);
    // Manually push
    (p as unknown as { pushEvent: (e: unknown) => void }).pushEvent({ kind: 'status', status: 'busy' });
    await new Promise(r => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0].event).toMatchObject({ kind: 'status', status: 'busy' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/providers/__tests__/base-provider.spec.ts`
Expected: FAIL — `events$` / `pushEvent` / `provider` / `capabilities` don't exist.

- [ ] **Step 3: Modify BaseProvider**

Edit `src/main/providers/provider-interface.ts`. Keep `extends EventEmitter` for now (removed in Task 25). Add the new members and abstract declarations:

```typescript
import { EventEmitter } from 'events';
import { Subject, type Observable } from 'rxjs';
import { randomUUID } from 'node:crypto';
import type {
  ProviderType, ProviderCapabilities, ProviderConfig, ProviderStatus,
  ProviderUsage, ProviderSessionOptions, ProviderAttachment,
} from '../../shared/types/provider.types';
import type { OutputMessage, InstanceStatus, ContextUsage } from '../../shared/types/instance.types';
import type { ProviderAdapter, ProviderAdapterCapabilities } from '@sdk/provider-adapter';
import type {
  ProviderName, ProviderRuntimeEvent, ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';

export interface ProviderEvents {
  'output': (message: OutputMessage) => void;
  'status': (status: InstanceStatus) => void;
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number | null) => void;
}

export abstract class BaseProvider extends EventEmitter implements ProviderAdapter {
  protected config: ProviderConfig;
  protected sessionId: string;
  protected instanceId: string = '';
  protected isActive = false;

  // New Wave 2 members:
  abstract readonly provider: ProviderName;
  abstract readonly capabilities: ProviderAdapterCapabilities;

  private readonly _events$ = new Subject<ProviderRuntimeEventEnvelope>();
  readonly events$: Observable<ProviderRuntimeEventEnvelope> = this._events$.asObservable();
  private _seq = 0;

  constructor(config: ProviderConfig) {
    super();
    this.config = config;
    this.sessionId = '';
  }

  /**
   * Build an envelope for the given event and push it onto the `events$` stream.
   * Called by subclasses directly after Wave 2 Phase 5; during Phase 1 the
   * subscribe-to-self bridge in Task 8 routes legacy `emit('output', …)`
   * through this helper via the normalizer.
   */
  protected pushEvent(event: ProviderRuntimeEvent): void {
    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: randomUUID(),
      seq: this._seq++,
      timestamp: Date.now(),
      provider: this.provider,
      instanceId: this.instanceId,
      sessionId: this.sessionId || undefined,
      event,
    };
    if (process.env.NODE_ENV !== 'production') {
      ProviderRuntimeEventEnvelopeSchema.parse(envelope);
    }
    this._events$.next(envelope);
  }

  protected completeEvents(): void {
    this._events$.complete();
  }

  abstract getType(): ProviderType;
  abstract getCapabilities(): ProviderCapabilities;
  abstract checkStatus(): Promise<ProviderStatus>;
  abstract initialize(options: ProviderSessionOptions): Promise<void>;
  abstract sendMessage(message: string, attachments?: ProviderAttachment[]): Promise<void>;
  abstract terminate(graceful?: boolean): Promise<void>;

  getSessionId(): string { return this.sessionId; }
  isRunning(): boolean { return this.isActive; }
  getUsage(): ProviderUsage | null { return null; }
  getPid(): number | null { return null; }
}

export type ProviderFactory = (config: ProviderConfig) => BaseProvider;
```

This introduces compile errors in all 4 concrete subclasses (ClaudeProvider, CodexProvider, GeminiProvider, CopilotProvider) because they don't yet declare `provider` / `capabilities`. **This is expected — Task 9 adds them.** To keep the tree building until then, temporarily add `// @ts-expect-error wave2-task9` above each subclass class declaration:

```typescript
// @ts-expect-error wave2-task9 — provider + capabilities declared in Task 9
export class ClaudeProvider extends BaseProvider { /* existing body */ }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/main/providers/__tests__/base-provider.spec.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS (the @ts-expect-error markers are consumed by the subclass errors).

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/provider-interface.ts \
        src/main/providers/__tests__/base-provider.spec.ts \
        src/main/providers/claude-provider.ts \
        src/main/providers/codex-provider.ts \
        src/main/providers/gemini-provider.ts \
        src/main/providers/copilot-provider.ts
git commit -m "feat(main): add Subject-backed events$ + pushEvent on BaseProvider"
```

---

### Task 7: Lifecycle helpers on BaseProvider (pushStatus/pushExit/pushError/pushSpawned/pushComplete/pushOutput/pushToolUse/pushToolResult/pushContext)

**Files:**
- Modify: `src/main/providers/provider-interface.ts`
- Modify: `src/main/providers/__tests__/base-provider.spec.ts`

- [ ] **Step 1: Extend the test**

Append to `src/main/providers/__tests__/base-provider.spec.ts`:

```typescript
describe('BaseProvider lifecycle helpers', () => {
  const makeCfg = (): ProviderConfig => ({ type: 'claude-cli', name: 'test', enabled: true });

  it('pushStatus emits a status envelope', async () => {
    const p = new TestProvider(makeCfg());
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    (p as unknown as { pushStatus: (s: string) => void }).pushStatus('idle');
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toEqual({ kind: 'status', status: 'idle' });
  });

  it('pushExit emits an exit envelope', async () => {
    const p = new TestProvider(makeCfg());
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    (p as unknown as { pushExit: (c: number | null, s: string | null) => void }).pushExit(0, null);
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toEqual({ kind: 'exit', code: 0, signal: null });
  });

  it('pushError emits an error envelope', async () => {
    const p = new TestProvider(makeCfg());
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    (p as unknown as { pushError: (msg: string, recoverable?: boolean) => void }).pushError('oops', true);
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toMatchObject({ kind: 'error', message: 'oops', recoverable: true });
  });

  it('pushSpawned / pushComplete emit their kinds', async () => {
    const p = new TestProvider(makeCfg());
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    const anyP = p as unknown as {
      pushSpawned: (pid: number) => void;
      pushComplete: (p: { tokensUsed?: number; costUsd?: number; durationMs?: number }) => void;
    };
    anyP.pushSpawned(1234);
    anyP.pushComplete({ tokensUsed: 10, durationMs: 500 });
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toEqual({ kind: 'spawned', pid: 1234 });
    expect(events[1].event).toMatchObject({ kind: 'complete', tokensUsed: 10, durationMs: 500 });
  });

  it('seq is monotonic per instance and resets on new instance', async () => {
    const p1 = new TestProvider(makeCfg());
    const events: ProviderRuntimeEventEnvelope[] = [];
    p1.events$.subscribe(e => events.push(e));
    (p1 as unknown as { pushStatus: (s: string) => void }).pushStatus('a');
    (p1 as unknown as { pushStatus: (s: string) => void }).pushStatus('b');
    await new Promise(r => setImmediate(r));
    expect(events.map(e => e.seq)).toEqual([0, 1]);

    const p2 = new TestProvider(makeCfg());
    const events2: ProviderRuntimeEventEnvelope[] = [];
    p2.events$.subscribe(e => events2.push(e));
    (p2 as unknown as { pushStatus: (s: string) => void }).pushStatus('a');
    await new Promise(r => setImmediate(r));
    expect(events2[0].seq).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/providers/__tests__/base-provider.spec.ts`
Expected: FAIL — helper methods don't exist.

- [ ] **Step 3: Add the helpers**

Edit `src/main/providers/provider-interface.ts`. Inside `BaseProvider`, after `pushEvent`:

```typescript
  protected pushOutput(content: string, messageType?: string, metadata?: Record<string, unknown>): void {
    this.pushEvent({ kind: 'output', content, messageType, metadata });
  }
  protected pushToolUse(toolName: string, input?: Record<string, unknown>, toolUseId?: string): void {
    this.pushEvent({ kind: 'tool_use', toolName, input, toolUseId });
  }
  protected pushToolResult(params: { toolName: string; success: boolean; toolUseId?: string; output?: string; error?: string }): void {
    this.pushEvent({ kind: 'tool_result', ...params });
  }
  protected pushStatus(status: string): void {
    this.pushEvent({ kind: 'status', status });
  }
  protected pushContext(used: number, total: number, percentage?: number): void {
    this.pushEvent({ kind: 'context', used, total, percentage });
  }
  protected pushError(message: string, recoverable = false, details?: Record<string, unknown>): void {
    this.pushEvent({ kind: 'error', message, recoverable, details });
  }
  protected pushExit(code: number | null, signal: string | null): void {
    this.pushEvent({ kind: 'exit', code, signal });
  }
  protected pushSpawned(pid: number): void {
    this.pushEvent({ kind: 'spawned', pid });
  }
  protected pushComplete(params: { tokensUsed?: number; costUsd?: number; durationMs?: number } = {}): void {
    this.pushEvent({ kind: 'complete', ...params });
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/providers/__tests__/base-provider.spec.ts`
Expected: PASS (all tests).

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/provider-interface.ts \
        src/main/providers/__tests__/base-provider.spec.ts
git commit -m "feat(main): add pushOutput/pushStatus/pushError/etc. lifecycle helpers to BaseProvider"
```

---

### Task 8: Subscribe-to-self bridge (Phase 1 transitional)

**Files:**
- Modify: `src/main/providers/provider-interface.ts`
- Modify: `src/main/providers/__tests__/base-provider.spec.ts`
- Read-only reference: `src/main/providers/event-normalizer.ts` (for the mapper API)

**Context:** Subclasses currently call `this.emit('output', msg)` / `this.emit('status', s)` etc. Until Phase 5 migrates each subclass to `pushEvent` directly, `BaseProvider`'s constructor listens to its own EventEmitter output and forwards via the existing per-provider normalizer mapper into the new `events$`.

- [ ] **Step 1: Write the failing test**

Append to `src/main/providers/__tests__/base-provider.spec.ts`:

```typescript
describe('BaseProvider subscribe-to-self bridge', () => {
  it('legacy emit() produces an envelope on events$', async () => {
    const p = new TestProvider({ type: 'claude-cli', name: 'test', enabled: true });
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    p.emit('status', 'busy');
    await new Promise(r => setImmediate(r));
    expect(events[0].event).toMatchObject({ kind: 'status', status: 'busy' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/providers/__tests__/base-provider.spec.ts`
Expected: FAIL — the `.emit` path is not wired to `events$` yet.

- [ ] **Step 3: Wire the bridge in the constructor**

Edit `src/main/providers/provider-interface.ts`. At the end of the constructor body, import `normalizeAdapterEvent` from `event-normalizer.ts` and register listeners for each legacy event:

```typescript
import { normalizeAdapterEvent } from './event-normalizer';

// inside constructor, after `this.sessionId = '';`:
this.on('output', (msg: OutputMessage) => {
  const ev = normalizeAdapterEvent(this.provider, 'output', msg);
  if (ev) this.pushEvent(ev);
});
this.on('status', (s: InstanceStatus | string) => {
  const status = typeof s === 'string' ? s : (s as { status?: string }).status ?? String(s);
  this.pushEvent({ kind: 'status', status });
});
this.on('context', (usage: ContextUsage) => {
  this.pushEvent({ kind: 'context', used: usage.used, total: usage.total, percentage: usage.percentage });
});
this.on('error', (err: Error) => {
  this.pushEvent({ kind: 'error', message: err.message, recoverable: false });
});
this.on('exit', (code: number | null, signal: string | null) => {
  this.pushEvent({ kind: 'exit', code, signal });
});
this.on('spawned', (pid: number | null) => {
  if (pid != null) this.pushEvent({ kind: 'spawned', pid });
});
```

**Ordering note:** Subclasses MUST NOT emit during their own constructor (before this bridge is in place, registering happens post-`super()` in this base constructor, so any subclass emit in `super()`-reachable code would fire before `this.on(...)` runs). Current adapters do not emit during construction — they emit only from `initialize()` / subprocess handlers. Verified by Task 26 grep sweep.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/providers/__tests__/base-provider.spec.ts`
Expected: PASS.

Run the full provider test set to catch accidental regressions:
Run: `npx vitest run src/main/providers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/provider-interface.ts \
        src/main/providers/__tests__/base-provider.spec.ts
git commit -m "feat(main): subscribe-to-self bridge — legacy EventEmitter output fans into events$"
```

---

### Task 9: Declare `provider` + `capabilities` + `DESCRIPTOR` on each adapter

**Files:**
- Modify: `src/main/providers/claude-provider.ts`
- Modify: `src/main/providers/codex-provider.ts`
- Modify: `src/main/providers/gemini-provider.ts`
- Modify: `src/main/providers/copilot-provider.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/providers/__tests__/adapter-descriptors.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CLAUDE_DESCRIPTOR } from '@main/providers/claude-provider';
import { CODEX_DESCRIPTOR } from '@main/providers/codex-provider';
import { GEMINI_DESCRIPTOR } from '@main/providers/gemini-provider';
import { COPILOT_DESCRIPTOR } from '@main/providers/copilot-provider';

describe('adapter descriptors', () => {
  const descriptors = [
    ['claude', CLAUDE_DESCRIPTOR, { subAgents: true }],
    ['codex', CODEX_DESCRIPTOR, { subAgents: false }],
    ['gemini', GEMINI_DESCRIPTOR, { sessionResume: false, subAgents: false }],
    ['copilot', COPILOT_DESCRIPTOR, { permissionPrompts: false, subAgents: false }],
  ] as const;
  for (const [name, d, expected] of descriptors) {
    it(`${name} descriptor has provider, displayName, capabilities, defaultConfig`, () => {
      expect(d.provider).toBe(name);
      expect(typeof d.displayName).toBe('string');
      expect(d.capabilities).toMatchObject(expected);
      expect(d.defaultConfig.type).toBeDefined();
    });
  }
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/providers/__tests__/adapter-descriptors.spec.ts`
Expected: FAIL — `*_DESCRIPTOR` not exported from adapter files.

- [ ] **Step 3: For each adapter, add `provider`, `capabilities`, `DESCRIPTOR`, remove @ts-expect-error marker**

In `src/main/providers/claude-provider.ts`, above the class and inside it:

```typescript
import type { ProviderAdapterDescriptor } from '@sdk/provider-adapter-registry';
import type { ProviderAdapterCapabilities } from '@sdk/provider-adapter';

const CLAUDE_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,
  permissionPrompts: true,
  sessionResume: true,
  streamingOutput: true,
  usageReporting: true,
  subAgents: true,
};

export const CLAUDE_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'claude',
  displayName: 'Claude Code',
  capabilities: CLAUDE_CAPABILITIES,
  defaultConfig: DEFAULT_CLAUDE_CONFIG, // extract from existing DEFAULT_PROVIDER_CONFIGS.claude in provider-registry.ts
};

// Remove the @ts-expect-error marker that was added in Task 6.
export class ClaudeProvider extends BaseProvider {
  readonly provider = 'claude' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  // ... existing body unchanged
}
```

Then find `DEFAULT_PROVIDER_CONFIGS.claude` in `src/main/providers/provider-registry.ts`. Move its value into a new exported const `DEFAULT_CLAUDE_CONFIG` in `claude-provider.ts` (and import it back into `provider-registry.ts` if still referenced there).

Repeat for the other three adapters with their distinct capability flags. The capabilities values for each:

```typescript
// codex-provider.ts
const CODEX_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true, permissionPrompts: true, sessionResume: true,
  streamingOutput: true, usageReporting: true, subAgents: false,
};

// gemini-provider.ts
const GEMINI_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true, permissionPrompts: true, sessionResume: false,
  streamingOutput: true, usageReporting: true, subAgents: false,
};

// copilot-provider.ts
const COPILOT_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true, permissionPrompts: false, sessionResume: true,
  streamingOutput: true, usageReporting: true, subAgents: false,
};
```

Each adapter exports `{CODEX,GEMINI,COPILOT}_DESCRIPTOR` and declares `readonly provider` + `readonly capabilities` on its class.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/providers/__tests__/adapter-descriptors.spec.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS. All @ts-expect-error markers from Task 6 must be removed; TS will error if any remain with nothing to suppress.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/claude-provider.ts \
        src/main/providers/codex-provider.ts \
        src/main/providers/gemini-provider.ts \
        src/main/providers/copilot-provider.ts \
        src/main/providers/provider-registry.ts \
        src/main/providers/__tests__/adapter-descriptors.spec.ts
git commit -m "feat(providers): declare provider, capabilities, and DESCRIPTOR on each adapter"
```

---

## Phase 3: Registry

### Task 10: ProviderAdapterRegistryImpl

**Files:**
- Create: `src/main/providers/provider-adapter-registry.ts`
- Create: `src/main/providers/__tests__/provider-adapter-registry.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/providers/__tests__/provider-adapter-registry.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderAdapterRegistryImpl } from '@main/providers/provider-adapter-registry';
import type { ProviderAdapterDescriptor, ProviderAdapterFactory } from '@sdk/provider-adapter-registry';
import type { ProviderAdapter } from '@sdk/provider-adapter';

const fakeDescriptor: ProviderAdapterDescriptor = {
  provider: 'claude',
  displayName: 'Claude Test',
  capabilities: { interruption: true, permissionPrompts: true, sessionResume: true, streamingOutput: true, usageReporting: true, subAgents: true },
  defaultConfig: { type: 'claude-cli', name: 'test', enabled: true },
};
const fakeAdapter = {} as ProviderAdapter;
const fakeFactory: ProviderAdapterFactory = () => fakeAdapter;

describe('ProviderAdapterRegistryImpl', () => {
  let registry: ProviderAdapterRegistryImpl;
  beforeEach(() => { registry = new ProviderAdapterRegistryImpl(); });

  it('register adds a descriptor and factory', () => {
    registry.register(fakeDescriptor, fakeFactory);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('claude')).toBe(fakeDescriptor);
  });

  it('register throws on duplicate provider', () => {
    registry.register(fakeDescriptor, fakeFactory);
    expect(() => registry.register(fakeDescriptor, fakeFactory)).toThrow(/already registered/);
  });

  it('get throws for unknown provider', () => {
    expect(() => registry.get('codex')).toThrow(/not registered/);
  });

  it('create invokes factory with config', () => {
    registry.register(fakeDescriptor, fakeFactory);
    const cfg = { type: 'claude-cli', name: 'runtime', enabled: true } as const;
    expect(registry.create('claude', cfg)).toBe(fakeAdapter);
  });

  it('list returns a frozen snapshot', () => {
    registry.register(fakeDescriptor, fakeFactory);
    const snap = registry.list();
    expect(snap).toHaveLength(1);
    expect(() => (snap as ProviderAdapterDescriptor[]).push(fakeDescriptor)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/providers/__tests__/provider-adapter-registry.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `src/main/providers/provider-adapter-registry.ts`:

```typescript
import type { ProviderConfig } from '@shared/types/provider.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type {
  ProviderAdapterRegistry,
  ProviderAdapterDescriptor,
  ProviderAdapterFactory,
} from '@sdk/provider-adapter-registry';

export class ProviderAdapterRegistryImpl implements ProviderAdapterRegistry {
  private readonly descriptors = new Map<ProviderName, ProviderAdapterDescriptor>();
  private readonly factories = new Map<ProviderName, ProviderAdapterFactory>();

  register(descriptor: ProviderAdapterDescriptor, factory: ProviderAdapterFactory): void {
    if (this.descriptors.has(descriptor.provider)) {
      throw new Error(`Provider ${descriptor.provider} already registered`);
    }
    this.descriptors.set(descriptor.provider, descriptor);
    this.factories.set(descriptor.provider, factory);
  }

  list(): readonly ProviderAdapterDescriptor[] {
    return Object.freeze([...this.descriptors.values()]);
  }

  get(provider: ProviderName): ProviderAdapterDescriptor {
    const descriptor = this.descriptors.get(provider);
    if (!descriptor) throw new Error(`Provider ${provider} not registered`);
    return descriptor;
  }

  create(provider: ProviderName, config: ProviderConfig): ProviderAdapter {
    const factory = this.factories.get(provider);
    if (!factory) throw new Error(`Provider ${provider} not registered`);
    return factory(config);
  }
}

/** Process-wide singleton — main-process bootstrap registers built-ins on this. */
export const providerAdapterRegistry: ProviderAdapterRegistry = new ProviderAdapterRegistryImpl();
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/providers/__tests__/provider-adapter-registry.spec.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/provider-adapter-registry.ts \
        src/main/providers/__tests__/provider-adapter-registry.spec.ts
git commit -m "feat(main): add ProviderAdapterRegistryImpl + singleton export"
```

---

### Task 11: Extract factory logic from provider-registry.ts; rename to ProviderInstanceManager

**Files:**
- Modify (rename): `src/main/providers/provider-registry.ts` → `src/main/providers/provider-instance-manager.ts`
- Update callers that import `provider-registry.ts`
- Move factory-creation logic into `register-built-in-providers.ts` (Task 12 creates the file)

- [ ] **Step 1: Identify callers**

Run:
```bash
npx rg --files-with-matches "from ['\"].*provider-registry['\"]" src/ packages/
```

Capture the list. All must be updated in Step 3.

- [ ] **Step 2: Write the failing test**

If the existing `provider-registry.ts` has a test file (`src/main/providers/__tests__/provider-registry.spec.ts`), its imports still reference the old path → that's the failing state after rename. Update the test imports in Step 3 alongside the rename.

If there is **no** existing test file, create `src/main/providers/__tests__/provider-instance-manager.spec.ts` with a smoke test:

```typescript
import { describe, it, expect } from 'vitest';
import { ProviderInstanceManager } from '@main/providers/provider-instance-manager';

describe('ProviderInstanceManager', () => {
  it('exports as ProviderInstanceManager (renamed from ProviderRegistry)', () => {
    expect(ProviderInstanceManager).toBeDefined();
  });
});
```

- [ ] **Step 3: Rename the file and class**

```bash
git mv src/main/providers/provider-registry.ts src/main/providers/provider-instance-manager.ts
```

Inside the file, rename the class `ProviderRegistry` → `ProviderInstanceManager`. If the class currently exports a factory or owns `DEFAULT_PROVIDER_CONFIGS`, remove that logic (descriptors already live on each adapter from Task 9; the factory lives in Task 12's `register-built-in-providers.ts`). The remaining responsibilities are: tracking running provider instances per session, restart/terminate coordination, lookup by instanceId.

Inject `ProviderAdapterRegistry` via the constructor:

```typescript
import type { ProviderAdapterRegistry } from '@sdk/provider-adapter-registry';

export class ProviderInstanceManager {
  constructor(private readonly adapterRegistry: ProviderAdapterRegistry) {}

  // existing lifecycle methods — any that previously built adapters directly
  // now call `this.adapterRegistry.create(provider, config)` instead.
}
```

Update every caller identified in Step 1:
- Change `import { ProviderRegistry } from '.../provider-registry'` → `import { ProviderInstanceManager } from '.../provider-instance-manager'`
- Replace class name references
- Pass the singleton `providerAdapterRegistry` where the instance manager is constructed (main-process startup)

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/main/providers`
Expected: PASS (including any prior provider-registry tests that now import from the new path).

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

Run: `npm run build:main`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A  # rename + updates
git commit -m "refactor(providers): rename ProviderRegistry → ProviderInstanceManager; inject ProviderAdapterRegistry"
```

---

### Task 12: register-built-in-providers.ts + main-process bootstrap

**Files:**
- Create: `src/main/providers/register-built-in-providers.ts`
- Create: `src/main/providers/__tests__/register-built-in-providers.spec.ts`
- Modify: `src/main/index.ts` (main-process entry) — call the bootstrap during init

- [ ] **Step 1: Write the failing test**

Create `src/main/providers/__tests__/register-built-in-providers.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderAdapterRegistryImpl } from '@main/providers/provider-adapter-registry';
import { registerBuiltInProviders } from '@main/providers/register-built-in-providers';

describe('registerBuiltInProviders', () => {
  let registry: ProviderAdapterRegistryImpl;
  beforeEach(() => { registry = new ProviderAdapterRegistryImpl(); });

  it('registers all four built-in adapters', () => {
    registerBuiltInProviders(registry);
    expect(registry.list().map(d => d.provider).sort()).toEqual(['claude', 'codex', 'copilot', 'gemini']);
  });

  it('creating an adapter returns an instance that implements ProviderAdapter', () => {
    registerBuiltInProviders(registry);
    const adapter = registry.create('claude', { type: 'claude-cli', name: 'test', enabled: true });
    expect(adapter.provider).toBe('claude');
    expect(adapter.events$).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/providers/__tests__/register-built-in-providers.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/providers/register-built-in-providers.ts`:

```typescript
import type { ProviderAdapterRegistry } from '@sdk/provider-adapter-registry';
import { ClaudeProvider, CLAUDE_DESCRIPTOR } from './claude-provider';
import { CodexProvider, CODEX_DESCRIPTOR } from './codex-provider';
import { GeminiProvider, GEMINI_DESCRIPTOR } from './gemini-provider';
import { CopilotProvider, COPILOT_DESCRIPTOR } from './copilot-provider';

export function registerBuiltInProviders(registry: ProviderAdapterRegistry): void {
  registry.register(CLAUDE_DESCRIPTOR,  (config) => new ClaudeProvider(config));
  registry.register(CODEX_DESCRIPTOR,   (config) => new CodexProvider(config));
  registry.register(GEMINI_DESCRIPTOR,  (config) => new GeminiProvider(config));
  registry.register(COPILOT_DESCRIPTOR, (config) => new CopilotProvider(config));
}
```

In `src/main/index.ts` (or wherever the singleton `ProviderInstanceManager` is instantiated), add near the start of init:

```typescript
import { providerAdapterRegistry } from './providers/provider-adapter-registry';
import { registerBuiltInProviders } from './providers/register-built-in-providers';

registerBuiltInProviders(providerAdapterRegistry);
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/main/providers`
Expected: PASS.

Run: `npm run build:main && npm run verify:ipc && npm run verify:exports`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/register-built-in-providers.ts \
        src/main/providers/__tests__/register-built-in-providers.spec.ts \
        src/main/index.ts
git commit -m "feat(main): register built-in providers on startup"
```

---

## Phase 4: Consumer Migration

### Task 13: Add PROVIDER_RUNTIME_EVENT IPC channel with Zod boundary validation

**Files:**
- Modify: `packages/contracts/src/channels/*.ts` (wherever instance-related channels live — grep for `INSTANCE_OUTPUT`)
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/generated/channels.ts` (regenerated)
- Run: `npm run generate:ipc` + `npm run verify:ipc`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/channels/__tests__/provider-runtime-channel.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels/index';

describe('PROVIDER_RUNTIME_EVENT channel', () => {
  it('is registered', () => {
    expect(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT).toBe('provider:runtime-event');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/contracts/src/channels/__tests__/provider-runtime-channel.spec.ts`
Expected: FAIL — channel not present.

- [ ] **Step 3: Add the channel**

Grep for where other `INSTANCE_*` channels are declared:
```bash
npx rg -l "INSTANCE_OUTPUT" packages/contracts/src/channels/
```

In the matching file, add alongside existing entries:

```typescript
PROVIDER_RUNTIME_EVENT: 'provider:runtime-event',
```

- [ ] **Step 4: Regenerate preload channels**

Run: `npm run generate:ipc`
Run: `npm run verify:ipc`
Expected: PASS.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/contracts/src/channels/__tests__/provider-runtime-channel.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/channels/ \
        src/preload/generated/channels.ts \
        packages/contracts/src/channels/__tests__/provider-runtime-channel.spec.ts
git commit -m "feat(contracts): add PROVIDER_RUNTIME_EVENT IPC channel"
```

---

### Task 14: Add onProviderRuntimeEvent to preload bridge

**Files:**
- Modify: `src/preload/preload.ts`
- Modify: `src/shared/types/electron-api.d.ts` (or wherever `window.electronAPI` is typed)

- [ ] **Step 1: Write the failing test**

Create `src/preload/__tests__/on-provider-runtime-event.spec.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { electronAPI } from '@preload/preload';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

vi.mock('electron', () => ({
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
}));

describe('electronAPI.onProviderRuntimeEvent', () => {
  it('registers a listener on provider:runtime-event and invokes callback with envelope', () => {
    const cb = vi.fn();
    const unsub = electronAPI.onProviderRuntimeEvent(cb);
    expect(ipcRenderer.on).toHaveBeenCalledWith('provider:runtime-event', expect.any(Function));
    // Simulate main sending an envelope
    const handler = (ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const env: ProviderRuntimeEventEnvelope = {
      eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      seq: 0, timestamp: Date.now(), provider: 'claude', instanceId: 'i',
      event: { kind: 'status', status: 'busy' },
    };
    handler({} as unknown, env);
    expect(cb).toHaveBeenCalledWith(env);
    unsub();
    expect(ipcRenderer.removeListener).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/preload/__tests__/on-provider-runtime-event.spec.ts`
Expected: FAIL — method not present.

- [ ] **Step 3: Add the method**

Edit `src/preload/preload.ts`. Find the `electronAPI` export. Add:

```typescript
import { IPC_CHANNELS } from '@contracts/channels/index';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

// inside electronAPI:
onProviderRuntimeEvent(callback: (envelope: ProviderRuntimeEventEnvelope) => void): () => void {
  const listener = (_evt: unknown, envelope: ProviderRuntimeEventEnvelope) => callback(envelope);
  ipcRenderer.on(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, listener);
  return () => ipcRenderer.removeListener(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, listener);
},
```

Update the `ElectronAPI` type (in `src/shared/types/electron-api.d.ts` or inline) to include the new method.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/preload`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload/preload.ts \
        src/preload/__tests__/on-provider-runtime-event.spec.ts \
        src/shared/types/electron-api.d.ts
git commit -m "feat(preload): expose onProviderRuntimeEvent bridge method"
```

---

### Task 15: Renderer InstanceEventsService — events$ + filtered streams

**Files:**
- Modify (or create): `src/renderer/app/core/services/instance-events.service.ts`
- Create: `src/renderer/app/core/services/__tests__/instance-events.service.spec.ts`

**Context:** First grep for the actual current filename — it may be `instance-events.service.ts`, `provider-events.service.ts`, or similar. If no suitable service exists, create `instance-events.service.ts`. Do not create a parallel service if one already handles per-kind streams — extend it.

- [ ] **Step 1: Find the current renderer event service**

Run:
```bash
npx rg -l "onInstanceOutput|onInstanceStatus|INSTANCE_OUTPUT" src/renderer/
```

Note the file(s). The rest of this task assumes `src/renderer/app/core/services/instance-events.service.ts` — adapt paths to what you find.

- [ ] **Step 2: Write the failing test**

Create `src/renderer/app/core/services/__tests__/instance-events.service.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstanceEventsService } from '../instance-events.service';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

function makeEnv(partial: Partial<ProviderRuntimeEventEnvelope> = {}): ProviderRuntimeEventEnvelope {
  return {
    eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
    seq: 0, timestamp: Date.now(), provider: 'claude', instanceId: 'i-1',
    event: { kind: 'status', status: 'busy' },
    ...partial,
  };
}

describe('InstanceEventsService', () => {
  let captured: ((e: ProviderRuntimeEventEnvelope) => void) | undefined;

  beforeEach(() => {
    captured = undefined;
    (globalThis as unknown as { window: unknown }).window = {
      electronAPI: {
        onProviderRuntimeEvent: (cb: (e: ProviderRuntimeEventEnvelope) => void) => {
          captured = cb;
          return () => { captured = undefined; };
        },
      },
    };
    TestBed.configureTestingModule({ providers: [InstanceEventsService] });
  });

  it('exposes events$ that emits envelopes from preload', async () => {
    const svc = TestBed.inject(InstanceEventsService);
    const received: ProviderRuntimeEventEnvelope[] = [];
    svc.events$.subscribe(e => received.push(e));
    captured!(makeEnv());
    expect(received).toHaveLength(1);
  });

  it('filters by kind via outputEvents$ / statusEvents$', async () => {
    const svc = TestBed.inject(InstanceEventsService);
    const statuses: ProviderRuntimeEventEnvelope[] = [];
    const outputs: ProviderRuntimeEventEnvelope[] = [];
    svc.statusEvents$.subscribe(e => statuses.push(e));
    svc.outputEvents$.subscribe(e => outputs.push(e));
    captured!(makeEnv({ event: { kind: 'status', status: 'idle' } }));
    captured!(makeEnv({ seq: 1, event: { kind: 'output', content: 'hi' } }));
    expect(statuses).toHaveLength(1);
    expect(outputs).toHaveLength(1);
  });

  it('warns on seq gap per instanceId', () => {
    const svc = TestBed.inject(InstanceEventsService);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    svc.events$.subscribe(() => {});
    captured!(makeEnv({ seq: 0 }));
    captured!(makeEnv({ seq: 2 })); // gap: expected 1
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gap/i));
    warn.mockRestore();
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run src/renderer/app/core/services/__tests__/instance-events.service.spec.ts`
Expected: FAIL — missing service or missing streams.

- [ ] **Step 4: Implement the service**

Create (or modify) `src/renderer/app/core/services/instance-events.service.ts`:

```typescript
import { Injectable, OnDestroy } from '@angular/core';
import { Observable, Subject, filter } from 'rxjs';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

@Injectable({ providedIn: 'root' })
export class InstanceEventsService implements OnDestroy {
  private readonly _events$ = new Subject<ProviderRuntimeEventEnvelope>();
  readonly events$ = this._events$.asObservable();

  readonly outputEvents$ = this.events$.pipe(filter(e => e.event.kind === 'output'));
  readonly toolUseEvents$ = this.events$.pipe(filter(e => e.event.kind === 'tool_use'));
  readonly toolResultEvents$ = this.events$.pipe(filter(e => e.event.kind === 'tool_result'));
  readonly statusEvents$ = this.events$.pipe(filter(e => e.event.kind === 'status'));
  readonly contextEvents$ = this.events$.pipe(filter(e => e.event.kind === 'context'));
  readonly errorEvents$ = this.events$.pipe(filter(e => e.event.kind === 'error'));
  readonly exitEvents$ = this.events$.pipe(filter(e => e.event.kind === 'exit'));
  readonly spawnedEvents$ = this.events$.pipe(filter(e => e.event.kind === 'spawned'));
  readonly completeEvents$ = this.events$.pipe(filter(e => e.event.kind === 'complete'));

  private readonly expectedSeq = new Map<string, number>();
  private readonly unsub: () => void;

  constructor() {
    this.unsub = window.electronAPI.onProviderRuntimeEvent(env => {
      const expected = this.expectedSeq.get(env.instanceId) ?? 0;
      if (env.seq !== expected) {
        console.warn(`[InstanceEventsService] event gap for ${env.instanceId}: expected seq ${expected}, got ${env.seq}`);
      }
      this.expectedSeq.set(env.instanceId, env.seq + 1);
      this._events$.next(env);
    });
  }

  ngOnDestroy(): void {
    this.unsub();
    this._events$.complete();
  }
}
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/renderer/app/core/services/__tests__/instance-events.service.spec.ts`
Expected: PASS (all 3 tests).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/core/services/instance-events.service.ts \
        src/renderer/app/core/services/__tests__/instance-events.service.spec.ts
git commit -m "feat(renderer): InstanceEventsService subscribes to preload envelope stream"
```

---

### Task 16: Migrate renderer components off per-kind streams

**Files:**
- Grep + modify: all renderer components currently consuming per-event-type signals/streams
- The legacy `onInstanceOutput`, `onInstanceStatus`, etc. listeners stay on `window.electronAPI` during this phase (removed in Task 27)

- [ ] **Step 1: Enumerate affected components**

Run:
```bash
npx rg -l "onInstanceOutput|onInstanceStatus|onInstanceError|onInstanceToolUse|onInstanceToolResult|onInstanceExit|onInstanceSpawned|onInstanceComplete|onInstanceContext" src/renderer/
```

Produce a list. Each file migrates in this task.

- [ ] **Step 2: For each file, migrate the consumer**

Pattern — replace direct preload subscriptions:

```typescript
// Before
this.unsubOutput = window.electronAPI.onInstanceOutput(msg => this.handleOutput(msg));
this.unsubStatus = window.electronAPI.onInstanceStatus(s => this.handleStatus(s));
```

with injected service + filtered streams:

```typescript
// After
private readonly events = inject(InstanceEventsService);
private readonly outputSub = this.events.outputEvents$
  .pipe(filter(e => e.instanceId === this.instanceId()))
  .subscribe(env => this.handleOutput(env.event));
private readonly statusSub = this.events.statusEvents$
  .pipe(filter(e => e.instanceId === this.instanceId()))
  .subscribe(env => this.handleStatus(env.event));
```

Unsubscribe in `ngOnDestroy`.

For components using signals:

```typescript
readonly lastOutput = toSignal(
  this.events.outputEvents$.pipe(filter(e => e.instanceId === this.instanceId())),
  { initialValue: undefined },
);
```

- [ ] **Step 3: Write/update tests for each migrated component**

For each migrated component, ensure its existing spec still covers the event-handling paths. If a component's spec only tested the legacy subscription wiring, update the spec to assert the new service subscription by mocking `InstanceEventsService` with a `Subject`.

- [ ] **Step 4: Run the renderer test suite**

Run: `npx vitest run src/renderer`
Expected: PASS.

Run: `npm run build:renderer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/
git commit -m "refactor(renderer): migrate per-kind event consumers to InstanceEventsService"
```

---

### Task 17: Telemetry + observability subscribe to events$

**Files:**
- Modify: files under `src/main/telemetry/` and `src/main/observability/` that currently listen on per-event EventEmitter events

- [ ] **Step 1: Enumerate affected files**

Run:
```bash
npx rg -l "\\.on\\(['\"]output['\"]|\\.on\\(['\"]status['\"]|\\.on\\(['\"]error['\"]|\\.on\\(['\"]exit['\"]|\\.on\\(['\"]complete['\"]|\\.on\\(['\"]spawned['\"]|\\.on\\(['\"]context['\"]|\\.on\\(['\"]tool_use['\"]|\\.on\\(['\"]tool_result['\"]" src/main/telemetry/ src/main/observability/
```

- [ ] **Step 2: For each, migrate**

Replace listener registration on `provider` (`BaseProvider`) with a single `events$` subscription:

```typescript
// Before
provider.on('complete', (usage) => span.end({ tokens: usage.tokensUsed }));
provider.on('error', (err) => span.recordException(err));

// After
const sub = provider.events$.subscribe(env => {
  span.setAttribute('event.id', env.eventId);
  span.setAttribute('event.seq', env.seq);
  switch (env.event.kind) {
    case 'complete': span.end({ tokens: env.event.tokensUsed }); break;
    case 'error': span.recordException(new Error(env.event.message)); break;
    case 'output': /* streaming output trace */ break;
    // etc
  }
});
// store sub on provider's lifecycle record; unsubscribe on terminate
```

- [ ] **Step 3: Update telemetry tests**

Each migrated telemetry file should have tests asserting the new subscription behavior. Update or create tests using a `Subject<ProviderRuntimeEventEnvelope>` as the fake provider's `events$`.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/main/telemetry src/main/observability`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/telemetry src/main/observability
git commit -m "refactor(telemetry): subscribe to provider events$ with eventId correlation"
```

---

### Task 18: Orchestration + failover + activity-state-detector subscribe to events$

**Files:**
- Modify: `src/main/orchestration/**`
- Modify: `src/main/providers/failover-manager.ts`
- Modify: `src/main/providers/activity-state-detector.ts`

- [ ] **Step 1: Enumerate affected files**

Run:
```bash
npx rg -l "\\.on\\(['\"]complete['\"]|\\.on\\(['\"]error['\"]|\\.on\\(['\"]exit['\"]|\\.on\\(['\"]status['\"]" src/main/orchestration/ src/main/providers/failover-manager.ts src/main/providers/activity-state-detector.ts
```

- [ ] **Step 2: Migrate orchestration**

Within debate / sequential / multi-agent controllers, replace `provider.on('complete', …)` and `provider.on('error', …)` with filter-subscribes:

```typescript
import { filter } from 'rxjs';

const sub = provider.events$
  .pipe(filter(e => e.event.kind === 'complete' || e.event.kind === 'error'))
  .subscribe(env => {
    if (env.event.kind === 'complete') this.onTurnComplete(env);
    else this.onTurnError(env);
  });
```

- [ ] **Step 3: Migrate failover-manager**

```typescript
const sub = provider.events$
  .pipe(filter(e => e.event.kind === 'exit' || e.event.kind === 'error'))
  .subscribe(env => this.considerFallback(env));
```

- [ ] **Step 4: Migrate activity-state-detector**

```typescript
const sub = provider.events$
  .pipe(filter(e => e.event.kind === 'status'))
  .subscribe(env => this.updateState(env.instanceId, env.event.status));
```

- [ ] **Step 5: Update tests**

Each affected spec should inject a `Subject<ProviderRuntimeEventEnvelope>` as `events$` and drive the subscribed code paths.

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/main/orchestration src/main/providers/failover-manager src/main/providers/activity-state-detector`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/orchestration src/main/providers/failover-manager.ts src/main/providers/activity-state-detector.ts
git commit -m "refactor(main): orchestration/failover/activity-state subscribe to events$"
```

---

### Task 19: Migrate instance-communication.ts (fanout hub) + forward envelopes on new channel

**Files:**
- Modify: `src/main/services/instance-communication.ts`
- Modify: `src/main/services/__tests__/instance-communication.spec.ts`

**Context:** This is the last consumer. After this task lands, no main-side code subscribes to the legacy `.on('output', …)` EventEmitter interface on providers — all paths read from `events$`. The subscribe-to-self bridge is still in place, so producers can still use `emit()` until Phase 5.

- [ ] **Step 1: Write the failing test**

Update `src/main/services/__tests__/instance-communication.spec.ts` (or create if missing) with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Subject } from 'rxjs';
import { InstanceCommunicationService } from '../instance-communication';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { IPC_CHANNELS } from '@contracts/channels/index';

describe('InstanceCommunicationService envelope fanout', () => {
  it('subscribes to provider.events$ and forwards validated envelopes on PROVIDER_RUNTIME_EVENT', () => {
    const events$ = new Subject<ProviderRuntimeEventEnvelope>();
    const fakeProvider = { events$ } as unknown as { events$: Subject<ProviderRuntimeEventEnvelope> };
    const send = vi.fn();
    const mainWindow = { webContents: { send } } as unknown as Electron.BrowserWindow;
    const svc = new InstanceCommunicationService(mainWindow);
    svc.bindProvider('inst-1', fakeProvider as never);

    const env: ProviderRuntimeEventEnvelope = {
      eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      seq: 0, timestamp: Date.now(), provider: 'claude', instanceId: 'inst-1',
      event: { kind: 'status', status: 'busy' },
    };
    events$.next(env);

    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, env);
  });

  it('unsubscribes on unbindProvider', () => {
    const events$ = new Subject<ProviderRuntimeEventEnvelope>();
    const send = vi.fn();
    const mainWindow = { webContents: { send } } as unknown as Electron.BrowserWindow;
    const svc = new InstanceCommunicationService(mainWindow);
    svc.bindProvider('inst-1', { events$ } as never);
    svc.unbindProvider('inst-1');
    events$.next({
      eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      seq: 0, timestamp: Date.now(), provider: 'claude', instanceId: 'inst-1',
      event: { kind: 'status', status: 'busy' },
    });
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/services/__tests__/instance-communication.spec.ts`
Expected: FAIL — `bindProvider`/`unbindProvider` or the new forwarding path not present yet.

- [ ] **Step 3: Refactor InstanceCommunicationService**

Edit `src/main/services/instance-communication.ts`. Replace per-event-type listener registration with:

```typescript
import type { Subscription } from 'rxjs';
import { IPC_CHANNELS } from '@contracts/channels/index';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import type { ProviderAdapter } from '@sdk/provider-adapter';

export class InstanceCommunicationService {
  private readonly subs = new Map<string, Subscription>();

  constructor(private readonly mainWindow: Electron.BrowserWindow) {}

  bindProvider(instanceId: string, provider: ProviderAdapter): void {
    this.unbindProvider(instanceId);
    const sub = provider.events$.subscribe(envelope => {
      ProviderRuntimeEventEnvelopeSchema.parse(envelope); // trust-boundary parse, always
      this.mainWindow.webContents.send(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, envelope);
    });
    this.subs.set(instanceId, sub);
  }

  unbindProvider(instanceId: string): void {
    this.subs.get(instanceId)?.unsubscribe();
    this.subs.delete(instanceId);
  }
}
```

Delete all existing `provider.on('output', …)` / `.on('status', …)` / etc. listeners previously owned by this service. The lifecycle-ownership (when to `bindProvider`/`unbindProvider`) is at instance start/terminate — update callers in `ProviderInstanceManager` (and wherever providers are created/destroyed) to call these.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run src/main/services`
Expected: PASS.

Run: `npm run build:main`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/instance-communication.ts \
        src/main/services/__tests__/instance-communication.spec.ts \
        src/main/providers/provider-instance-manager.ts  # caller update
git commit -m "refactor(main): instance-communication forwards validated envelopes on PROVIDER_RUNTIME_EVENT"
```

---

### Task 19b: Phase 4 checkpoint — full verify

- [ ] **Step 1: Run the full Phase 4 gate**

```bash
npm run lint
npm run verify:ipc
npm run verify:exports
npx tsc --noEmit -p tsconfig.electron.json
npx tsc --noEmit -p tsconfig.json
npm run build
npm run test
```
Expected: all PASS. The app should boot and produce envelopes on the new channel (the old channels also still work — producer migration is Phase 5).

- [ ] **Step 2: No commit. Proceed to Phase 5.**

---

## Phase 5: Producer Migration

### Task 20: Migrate ClaudeProvider to pushEvent (inline translation)

**Files:**
- Modify: `src/main/providers/claude-provider.ts`
- Modify: `src/main/providers/__tests__/claude-provider.spec.ts` (if present)

- [ ] **Step 1: Write the failing test**

Append to (or create) `src/main/providers/__tests__/claude-provider.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '@main/providers/claude-provider';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

describe('ClaudeProvider inline translation', () => {
  it('assistant JSON line produces an output envelope on events$', async () => {
    const p = new ClaudeProvider({ type: 'claude-cli', name: 'test', enabled: true });
    (p as unknown as { instanceId: string }).instanceId = 'i-1';
    const events: ProviderRuntimeEventEnvelope[] = [];
    p.events$.subscribe(e => events.push(e));
    // Feed a raw Claude stdout chunk via the internal handler.
    const rawLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    (p as unknown as { onStdoutLine: (l: string) => void }).onStdoutLine(rawLine);
    await new Promise(r => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({ kind: 'output', content: 'hello' });
  });
  // … add tests for tool_use, tool_result, status, context, error, exit, spawned, complete
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/main/providers/__tests__/claude-provider.spec.ts`
Expected: FAIL — claude still uses `emit('output', …)` → envelope passes through the bridge but with the old normalizer's output shape, which may not match strict inline expectations.

- [ ] **Step 3: Inline the translation**

Edit `src/main/providers/claude-provider.ts`. Replace every `this.emit('output', …)` / `.emit('status', …)` / etc. call site with the matching `pushEvent()` or lifecycle helper.

For the stdout/raw-event handler (likely called `onStdoutLine` or `handleClaudeEvent` — grep the file):

```typescript
private onStdoutLine(line: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return; }
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) return;

  const p = parsed as Record<string, unknown> & { type: string };
  switch (p.type) {
    case 'assistant': {
      const msg = p.message as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> } | undefined;
      if (!msg?.content) return;
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          this.pushOutput(block.text, 'assistant');
        } else if (block.type === 'tool_use') {
          this.pushToolUse(block.name ?? '', block.input as Record<string, unknown> | undefined, block.id);
        }
      }
      break;
    }
    case 'user': {
      // tool_result arrives inside user messages
      const msg = p.message as { content?: Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }> } | undefined;
      if (!msg?.content) return;
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          this.pushToolResult({
            toolName: '', // Claude JSON doesn't include toolName in result; set empty or look up from correlation
            toolUseId: block.tool_use_id,
            output: block.content,
            success: !(block.is_error ?? false),
            error: block.is_error ? block.content : undefined,
          });
        }
      }
      break;
    }
    case 'system': {
      // system messages — could be context usage, status, etc. Map per current Claude mapper.
      // Reference the existing ClaudeEventMapper code paths in event-normalizer.ts for exact mappings.
      break;
    }
    case 'result': {
      // completion signal with usage
      const usage = p.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const costUsd = typeof p.cost_usd === 'number' ? p.cost_usd : undefined;
      const durationMs = typeof p.duration_ms === 'number' ? p.duration_ms : undefined;
      this.pushComplete({
        tokensUsed: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        costUsd,
        durationMs,
      });
      break;
    }
    // … follow the logic in ClaudeEventMapper.normalize() for exact translation parity
  }
}
```

**Reference the current `ClaudeEventMapper` in `event-normalizer.ts` for the exact mapping logic** — the inline switch must produce equivalent events for equivalent raw inputs (parity test in Task 24 verifies this).

Replace lifecycle emit sites:
- `this.emit('status', ...)` → `this.pushStatus(...)`
- `this.emit('error', err)` → `this.pushError(err.message, false)`
- `this.emit('exit', code, signal)` → `this.pushExit(code, signal)`
- `this.emit('spawned', pid)` → `this.pushSpawned(pid)`

Also: in `initialize(options)`, store `this.instanceId = options.instanceId ?? '';` so envelopes carry the correct id.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/providers/__tests__/claude-provider.spec.ts`
Expected: PASS.

Run full provider suite:
Run: `npx vitest run src/main/providers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/claude-provider.ts \
        src/main/providers/__tests__/claude-provider.spec.ts
git commit -m "refactor(claude): inline event translation; emit via pushEvent"
```

---

### Task 21: Migrate CodexProvider to pushEvent (inline translation)

**Files:**
- Modify: `src/main/providers/codex-provider.ts`
- Modify: `src/main/providers/__tests__/codex-provider.spec.ts`

**Process:** Identical shape to Task 20. Reference `CodexEventMapper` in `event-normalizer.ts` for the translation rules; inline them in CodexProvider's raw-event handler. Replace all `emit('output')` / `emit('status')` / etc. with `pushOutput` / `pushStatus` / etc.

- [ ] **Step 1: Write failing tests (mirror Task 20's test structure)**
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Inline translation — follow the existing CodexEventMapper logic exactly**
- [ ] **Step 4: Run `npx vitest run src/main/providers/__tests__/codex-provider.spec.ts` — PASS**
- [ ] **Step 5: Commit: `refactor(codex): inline event translation; emit via pushEvent`**

---

### Task 22: Migrate GeminiProvider (drop Codex delegation, own inline translation)

**Files:**
- Modify: `src/main/providers/gemini-provider.ts`
- Modify: `src/main/providers/__tests__/gemini-provider.spec.ts`

**Process:** Gemini currently delegates to `CodexEventMapper` per the codebase snapshot in the Wave 2 spec. This task writes Gemini-specific translation. Reference Gemini's actual CLI output format (SSE-formatted events) to craft the inline `switch` — the previous delegation was a shortcut that no longer applies.

- [ ] **Step 1: Write failing tests covering Gemini-specific raw formats**
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Inline translation — write Gemini-specific rules (do not import CodexEventMapper or equivalent)**
- [ ] **Step 4: Run `npx vitest run src/main/providers/__tests__/gemini-provider.spec.ts` — PASS**
- [ ] **Step 5: Commit: `refactor(gemini): drop Codex delegation; inline own event translation`**

---

### Task 23: Migrate CopilotProvider (drop Codex delegation, own inline translation)

**Files:**
- Modify: `src/main/providers/copilot-provider.ts`
- Modify: `src/main/providers/__tests__/copilot-provider.spec.ts`

**Process:** Same shape as Task 22. Copilot uses `@github/copilot-sdk` streamed events — reference the SDK's event types for the inline mapping.

- [ ] **Step 1-5: Mirror Task 22 structure; commit message: `refactor(copilot): drop Codex delegation; inline own event translation`**

---

### Task 24: Parity test matrix + recorded fixture replay

**Files:**
- Create: `src/main/providers/__tests__/parity/provider-parity.spec.ts`
- Create: `src/main/providers/__tests__/parity/fixture-replay.spec.ts`
- Create: `packages/contracts/src/__fixtures__/provider-events/<provider>/basic-conversation.jsonl` + `.golden.jsonl` (6 files)
- Create: `scripts/record-provider-fixture.ts`

- [ ] **Step 1: Write the synthesized parity matrix**

Create `src/main/providers/__tests__/parity/provider-parity.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '@main/providers/claude-provider';
import { CodexProvider } from '@main/providers/codex-provider';
import { GeminiProvider } from '@main/providers/gemini-provider';
import { CopilotProvider } from '@main/providers/copilot-provider';
import type { ProviderRuntimeEvent, ProviderRuntimeEventEnvelope, ProviderName } from '@contracts/types/provider-runtime-events';
import type { BaseProvider } from '@main/providers/provider-interface';

type AdapterFactory = () => BaseProvider;
const ADAPTERS: Record<ProviderName, AdapterFactory> = {
  claude: () => new ClaudeProvider({ type: 'claude-cli', name: 't', enabled: true }),
  codex:  () => new CodexProvider({ type: 'openai', name: 't', enabled: true }),
  gemini: () => new GeminiProvider({ type: 'google', name: 't', enabled: true }),
  copilot:() => new CopilotProvider({ type: 'claude-cli', name: 't', enabled: true }),
};

interface Scenario {
  name: string;
  kind: ProviderRuntimeEvent['kind'];
  /** Raw input per provider, fed via adapter's `__feedRaw` test hook. */
  inputs: Record<ProviderName, unknown>;
  /** Expected event shape (partial-match) per provider. */
  expected: Record<ProviderName, Partial<ProviderRuntimeEvent>>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'assistant text output',
    kind: 'output',
    inputs: {
      claude:  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
      codex:   JSON.stringify({ /* codex-specific format — fill exact raw shape from CodexEventMapper */ }),
      gemini:  'data: {"role":"model","content":"hello"}\n\n',
      copilot: { event: 'message', data: { role: 'assistant', content: 'hello' } },
    },
    expected: {
      claude:  { kind: 'output', content: 'hello' },
      codex:   { kind: 'output', content: 'hello' },
      gemini:  { kind: 'output', content: 'hello' },
      copilot: { kind: 'output', content: 'hello' },
    },
  },
  // … 8 more scenarios covering: tool_use, tool_result, status, context, error, exit, spawned, complete
  // Use the existing *EventMapper implementations in event-normalizer.ts as the reference for correct
  // input/expected pairs per provider.
];

const PROVIDERS: readonly ProviderName[] = ['claude', 'codex', 'gemini', 'copilot'];

describe('provider parity', () => {
  for (const s of SCENARIOS) {
    describe(s.name, () => {
      for (const provider of PROVIDERS) {
        it(`${provider} produces a ${s.kind} envelope`, async () => {
          const adapter = ADAPTERS[provider]();
          (adapter as unknown as { instanceId: string }).instanceId = 'i-parity';
          const events: ProviderRuntimeEventEnvelope[] = [];
          adapter.events$.subscribe(e => events.push(e));
          (adapter as unknown as { __feedRaw: (i: unknown) => void }).__feedRaw(s.inputs[provider]);
          await new Promise(r => setImmediate(r));
          expect(events.length).toBeGreaterThan(0);
          expect(events[0].event).toMatchObject(s.expected[provider]);
          expect(events[0].eventId).toMatch(/^[0-9a-f-]{36}$/);
          expect(events[0].seq).toBe(0);
          expect(events[0].provider).toBe(provider);
        });
      }
    });
  }
});
```

Each adapter needs a `__feedRaw(input: unknown)` test hook — add as a protected-but-accessible method on each adapter that routes `input` into its raw event handler (`onStdoutLine` for CLI-based, direct SDK event for Copilot).

- [ ] **Step 2: Run the matrix; fill scenario gaps until all 36 cells pass**

Run: `npx vitest run src/main/providers/__tests__/parity/provider-parity.spec.ts`
Expected: PASS for all 36 (9 × 4) cases.

- [ ] **Step 3: Write the fixture replay test**

Create `src/main/providers/__tests__/parity/fixture-replay.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeProvider } from '@main/providers/claude-provider';
import { CodexProvider } from '@main/providers/codex-provider';
import { GeminiProvider } from '@main/providers/gemini-provider';
import { CopilotProvider } from '@main/providers/copilot-provider';
import type { ProviderRuntimeEventEnvelope, ProviderName } from '@contracts/types/provider-runtime-events';

const FIXTURES_DIR = path.resolve(__dirname, '../../../../../packages/contracts/src/__fixtures__/provider-events');

function scrub(env: ProviderRuntimeEventEnvelope): Partial<ProviderRuntimeEventEnvelope> {
  // Drop non-deterministic fields for comparison
  const { eventId: _e, timestamp: _t, ...rest } = env;
  return rest;
}

const ADAPTERS = {
  claude:  () => new ClaudeProvider({ type: 'claude-cli', name: 't', enabled: true }),
  codex:   () => new CodexProvider({ type: 'openai', name: 't', enabled: true }),
  gemini:  () => new GeminiProvider({ type: 'google', name: 't', enabled: true }),
  copilot: () => new CopilotProvider({ type: 'claude-cli', name: 't', enabled: true }),
} as const;

interface FixtureCase { provider: ProviderName; scenario: string }

const CASES: readonly FixtureCase[] = [
  { provider: 'claude', scenario: 'basic-conversation' },
  { provider: 'claude', scenario: 'tool-use-bash' },
  { provider: 'codex', scenario: 'basic-conversation' },
  { provider: 'codex', scenario: 'tool-use-bash' },
  { provider: 'gemini', scenario: 'basic-conversation' },
  { provider: 'copilot', scenario: 'basic-conversation' },
];

describe('fixture replay', () => {
  for (const { provider, scenario } of CASES) {
    it(`${provider}/${scenario} produces the golden envelope stream`, async () => {
      const rawPath = path.join(FIXTURES_DIR, provider, `${scenario}.jsonl`);
      const goldenPath = path.join(FIXTURES_DIR, provider, `${scenario}.golden.jsonl`);
      const rawLines = fs.readFileSync(rawPath, 'utf8').split('\n').filter(Boolean);
      const goldenEnvelopes = fs.readFileSync(goldenPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

      const adapter = ADAPTERS[provider]();
      (adapter as unknown as { instanceId: string }).instanceId = 'i-replay';
      const got: ProviderRuntimeEventEnvelope[] = [];
      adapter.events$.subscribe(e => got.push(e));
      for (const line of rawLines) {
        (adapter as unknown as { __feedRaw: (i: unknown) => void }).__feedRaw(line);
      }
      await new Promise(r => setImmediate(r));

      expect(got.map(scrub)).toEqual(goldenEnvelopes.map(scrub));
    });
  }
});
```

- [ ] **Step 4: Create fixtures**

Create the six fixture directories:
```bash
mkdir -p packages/contracts/src/__fixtures__/provider-events/{claude,codex,gemini,copilot}
```

Create `scripts/record-provider-fixture.ts` — a CLI helper (tsx-invoked) that spawns a real provider with a canned prompt, captures stdout lines into `<scenario>.jsonl`, runs them through the matching adapter's inline translation, and writes the resulting envelope stream as `<scenario>.golden.jsonl`.

```typescript
#!/usr/bin/env tsx
// scripts/record-provider-fixture.ts
// Usage: tsx scripts/record-provider-fixture.ts <provider> <scenario>
// Manually invoked to regenerate fixtures; not CI-gated.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeProvider } from '../src/main/providers/claude-provider';
// ... similar imports per provider

const [, , provider, scenario] = process.argv;
if (!provider || !scenario) { console.error('provider and scenario required'); process.exit(2); }

// 1. Spawn the provider with a canned prompt.
// 2. Capture stdout lines into rawPath.
// 3. Create a fresh adapter instance, feed the raw lines via __feedRaw,
//    collect events$ envelopes.
// 4. Write envelopes as JSONL to goldenPath, scrubbing eventId/timestamp
//    (replace with deterministic placeholders).
```

Implement the full helper; run it once per case to populate the 6 fixture pairs. Alternative for initial implementation: hand-write small fixtures using the current adapter output as ground truth.

- [ ] **Step 5: Run the fixture replay tests**

Run: `npx vitest run src/main/providers/__tests__/parity/fixture-replay.spec.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/__tests__/parity/ \
        packages/contracts/src/__fixtures__/ \
        scripts/record-provider-fixture.ts
git commit -m "test(providers): add parity matrix + recorded fixture replay"
```

---

### Task 24b: Phase 5 checkpoint — full gate

- [ ] **Step 1: Run the full Phase 5 gate**

```bash
npm run lint
npm run verify:ipc
npm run verify:exports
npx tsc --noEmit -p tsconfig.electron.json
npx tsc --noEmit -p tsconfig.json
npm run build
npm run test
```
Expected: all PASS. `events$` is the canonical event path; EventEmitter `emit()` is no longer called by any subclass, but `BaseProvider` still extends EventEmitter (removed in Task 25).

- [ ] **Step 2: No commit. Proceed to Phase 6.**

---

## Phase 6: Legacy Removal

### Task 25: Remove EventEmitter inheritance from BaseProvider

**Files:**
- Modify: `src/main/providers/provider-interface.ts`
- Modify: `src/main/providers/__tests__/base-provider.spec.ts`

- [ ] **Step 1: Update the bridge test to assert legacy path no longer used**

Update `src/main/providers/__tests__/base-provider.spec.ts`: remove the "subscribe-to-self bridge" describe block from Task 8 (it no longer exists). If any other spec asserts `provider.emit(...)` behavior, remove or rewrite those expectations.

- [ ] **Step 2: Strip EventEmitter**

Edit `src/main/providers/provider-interface.ts`:

1. Remove `import { EventEmitter } from 'events';`
2. Remove the `ProviderEvents` interface export (fail any consumer imports — update them to use events$).
3. Change class declaration: `export abstract class BaseProvider implements ProviderAdapter {` (drop `extends EventEmitter`).
4. Remove `super()` call from constructor.
5. Remove all `this.on('output', …)` / `this.on('status', …)` / etc. bridge listeners from the constructor.
6. Remove the `normalizeAdapterEvent` import (it becomes unreferenced — the file itself is deleted in Task 26).

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: PASS. If any tests still reference `.on(...)` on an adapter, they were missed in Phase 4 — fix them now.

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/providers/provider-interface.ts \
        src/main/providers/__tests__/base-provider.spec.ts
git commit -m "refactor(providers): drop EventEmitter inheritance from BaseProvider"
```

---

### Task 26: Delete event-normalizer.ts + ProviderEventMapper interface + related dead code

**Files:**
- Delete: `src/main/providers/event-normalizer.ts`
- Delete: `src/main/providers/__tests__/event-normalizer.spec.ts` (if present)
- Delete: `src/main/providers/normalizer-registry.ts` (if present as separate file)
- Modify: `packages/contracts/src/types/provider-runtime-events.ts` (remove `ProviderEventMapper`)
- Modify: `packages/sdk/src/providers.ts` (remove deprecated `ProviderEvent` alias from `provider.types.ts`)

- [ ] **Step 1: Delete the normalizer files**

```bash
git rm src/main/providers/event-normalizer.ts
git rm -f src/main/providers/__tests__/event-normalizer.spec.ts
git rm -f src/main/providers/normalizer-registry.ts
```

- [ ] **Step 2: Remove ProviderEventMapper from contracts**

Edit `packages/contracts/src/types/provider-runtime-events.ts`. Delete the `ProviderEventMapper` interface at the bottom.

- [ ] **Step 3: Remove deprecated ProviderEvent alias**

Edit `src/shared/types/provider.types.ts`. Delete the `ProviderEvent` type (the deprecated 5-kind union, currently lines ~97-112).

Grep for any remaining consumers:
```bash
npx rg "ProviderEvent\\b(?!Mapper)" src/ packages/
```
If any remain, migrate them to `ProviderRuntimeEvent` or delete them.

- [ ] **Step 4: Run build + tests**

Run: `npm run build`
Expected: PASS. If anything still imports from `event-normalizer`, fix the imports (usually to `@contracts/types/provider-runtime-events` for types).

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(providers): delete event-normalizer + ProviderEventMapper + deprecated ProviderEvent"
```

---

### Task 27: Delete 9 legacy IPC channels + preload listeners + grep sweep + final CI gate

**Files:**
- Modify: `packages/contracts/src/channels/*.ts` (remove 9 legacy channels)
- Modify: `src/preload/preload.ts` (remove 9 per-kind listener methods)
- Modify: `src/shared/types/electron-api.d.ts` (remove 9 method types)
- Regenerate: `src/preload/generated/channels.ts` (`npm run generate:ipc`)

- [ ] **Step 1: Delete the channels**

In the channel registry file (identified during Task 13), delete the following entries:

```typescript
// Delete these:
INSTANCE_OUTPUT: 'instance:output',
INSTANCE_STATUS: 'instance:status',
INSTANCE_ERROR: 'instance:error',
INSTANCE_TOOL_USE: 'instance:tool-use',
INSTANCE_TOOL_RESULT: 'instance:tool-result',
INSTANCE_EXIT: 'instance:exit',
INSTANCE_SPAWNED: 'instance:spawned',
INSTANCE_COMPLETE: 'instance:complete',
INSTANCE_CONTEXT: 'instance:context',
```

(Exact keys may differ; the list here is the target set from Spec §6.6 / §7.1. Match the channel keys actually present.)

- [ ] **Step 2: Delete preload methods**

In `src/preload/preload.ts`, delete the 9 methods on `electronAPI`: `onInstanceOutput`, `onInstanceStatus`, `onInstanceError`, `onInstanceToolUse`, `onInstanceToolResult`, `onInstanceExit`, `onInstanceSpawned`, `onInstanceComplete`, `onInstanceContext`. Remove their declarations from the `ElectronAPI` type.

- [ ] **Step 3: Regenerate generated channels**

Run: `npm run generate:ipc`
Run: `npm run verify:ipc`
Expected: PASS.

- [ ] **Step 4: Grep sweep for stragglers (expect zero hits each)**

```bash
npx rg "extends EventEmitter" src/main/providers/
npx rg "\.emit\\(['\"]output['\"]|\.emit\\(['\"]status['\"]|\.emit\\(['\"]error['\"]|\.emit\\(['\"]exit['\"]|\.emit\\(['\"]spawned['\"]|\.emit\\(['\"]complete['\"]|\.emit\\(['\"]context['\"]|\.emit\\(['\"]tool_use['\"]|\.emit\\(['\"]tool_result['\"]" src/main/
npx rg "from ['\"].*event-normalizer['\"]"
npx rg "\bProviderEventMapper\b"
npx rg "\bnormalizeAdapterEvent\b"
npx rg "INSTANCE_OUTPUT|INSTANCE_STATUS|INSTANCE_ERROR|INSTANCE_TOOL_USE|INSTANCE_TOOL_RESULT|INSTANCE_EXIT|INSTANCE_SPAWNED|INSTANCE_COMPLETE|INSTANCE_CONTEXT" src/ packages/
npx rg "onInstanceOutput|onInstanceStatus|onInstanceError|onInstanceToolUse|onInstanceToolResult|onInstanceExit|onInstanceSpawned|onInstanceComplete|onInstanceContext" src/
```

Any hit is a Phase 4 or Phase 5 miss — fix it here.

- [ ] **Step 5: Full CI gate**

```bash
npm run lint
npm run verify:ipc
npm run verify:exports
npx tsc --noEmit -p tsconfig.electron.json
npx tsc --noEmit -p tsconfig.json
npm run build
npm run test
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(ipc): delete 9 legacy instance:* channels; consolidate on PROVIDER_RUNTIME_EVENT"
```

---

## Wave 2 Complete — Exit Criteria

At this point:
- [ ] All 27 tasks are committed.
- [ ] `BaseProvider` no longer extends `EventEmitter`; all 4 adapters push via `pushEvent()`.
- [ ] `packages/contracts/src/types/provider-runtime-events.ts` carries the `@frozen` JSDoc on `ProviderRuntimeEvent`.
- [ ] `ProviderAdapter`, `ProviderAdapterCapabilities`, `ProviderAdapterRegistry` + registry impl + `PROVIDER_RUNTIME_EVENT` channel are live.
- [ ] Zod validation fires at producer (dev only) + IPC boundary (always).
- [ ] `event-normalizer.ts` / `ProviderEventMapper` / deprecated `ProviderEvent` are gone.
- [ ] 9 legacy `INSTANCE_*` channels + matching preload methods are gone.
- [ ] Parity matrix (36 cells) + 6 recorded fixtures run green.
- [ ] `npm run lint && npm run test && npm run verify:ipc && npm run verify:exports && npm run build` green.
- [ ] The design spec's Deprecation Plan (Section 9) is preserved in-repo via the `@frozen` JSDoc.

Next: Wave 3 brainstorming per the roadmap in the parent design doc's Section 4.
