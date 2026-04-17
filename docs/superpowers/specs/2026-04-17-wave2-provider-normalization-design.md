# Wave 2 — Provider Normalization Design

**Status:** Design approved, pending implementation plan
**Date:** 2026-04-17
**Parent roadmap:** [`2026-04-16-ai-orchestrator-cross-repo-improvements-design.md`](./2026-04-16-ai-orchestrator-cross-repo-improvements-design.md) — Item 1 / Section 4 Wave 2
**Predecessor:** Wave 1 (Item 10 — Monorepo Subpath Exports Discipline), shipped 2026-04-17

## Goal

Normalize the four provider adapters (Claude, Codex, Gemini, Copilot) behind a single, typed, Observable-driven contract so every downstream consumer — orchestration, telemetry, IPC, renderer — sees one envelope shape regardless of which CLI produced it.

## Non-Goals

- 5-family hierarchical event taxonomy (deferred to Wave 3 per Section 9).
- New provider adapters beyond the existing four.
- MCP tool integration events (Wave 3+).
- Worker-agent event normalization (Item 2 / Wave 4, though it will reuse this envelope shape).
- Renderer UI changes driven by capability flags (Wave 5+).

## Decisions Summary

Locked-in answers from brainstorming:

| Q | Decision |
| --- | --- |
| Taxonomy scope | **Hybrid.** Keep existing 9-kind `ProviderRuntimeEvent` union frozen. Add correlation IDs, Zod, SDK interface, adapter-source normalization, registry. Defer 5-family to Wave 3. |
| `ProviderAdapter` interface | **Minimal.** Preserve existing method signatures; add `readonly provider`, `readonly capabilities`, `readonly events$`. |
| Producer bridging (transitional) | **Subscribe-to-self** in `BaseProvider` constructor during Phases 1–2 only. |
| Downstream migration scope | **Everything** — main-process + IPC + renderer in this wave. |
| Legacy EventEmitter | **Remove entirely** at end of Phase 3. Subclasses call `pushEvent(envelope)`; no `emit()` / mappers / normalizer registry remain. |
| Correlation IDs | **Both** — UUID v4 `eventId` + monotonic `seq` per instance. |
| Zod validation scope | **Adapter-emit (dev only) + IPC boundary (always).** Two parses per event max. |
| `ProviderAdapterCapabilities` v1 | **All six flags:** `interruption`, `permissionPrompts`, `sessionResume`, `streamingOutput`, `usageReporting`, `subAgents`. |
| Parity test strategy | **Hybrid** — synthesized 36-cell matrix + recorded real-session fixtures as regression anchors. |
| Registry split | **Interface in SDK, implementation in main.** |
| Deprecation plan | **Documented freeze + Wave 3 coexistence commitment + codemod.** |

Sequencing: **Approach A** — single wave with three internal phases (producer scaffolding → consumer migration → producer migration + legacy removal).

---

## Section 1: Architecture Overview

### End-state layering

```
┌─────────────────────────────────────────────────────────────┐
│ @ai-orchestrator/contracts                                   │
│  • ProviderRuntimeEventEnvelope (with eventId + seq)         │
│  • ProviderRuntimeEventEnvelopeSchema (Zod)                  │
│  • ProviderRuntimeEvent (9-kind union, frozen)               │
└─────────────────────────────────────────────────────────────┘
                          ▲
┌─────────────────────────────────────────────────────────────┐
│ @ai-orchestrator/sdk                                         │
│  • ProviderAdapter (interface)                               │
│  • ProviderAdapterCapabilities (6 flags)                     │
│  • ProviderAdapterDescriptor                                 │
│  • ProviderAdapterRegistry (interface)                       │
└─────────────────────────────────────────────────────────────┘
                          ▲
┌─────────────────────────────────────────────────────────────┐
│ src/main/providers/                                          │
│  • BaseProvider (Subject-backed, NOT EventEmitter)           │
│    └─ events$: Observable<ProviderRuntimeEventEnvelope>      │
│    └─ pushEvent(event) — protected, wraps in envelope        │
│  • ClaudeProvider / CodexProvider / GeminiProvider /         │
│    CopilotProvider — inlined translation at emit sites;       │
│    no *EventMapper classes remain                             │
│  • ProviderAdapterRegistryImpl                                │
│  • ProviderInstanceManager (renamed from provider-registry)   │
└─────────────────────────────────────────────────────────────┘
                          │
                    events$ stream
                          ▼
  IPC bridge (PROVIDER_RUNTIME_EVENT channel) → renderer
  telemetry, orchestration, failover, activity-state-detector
```

### Data flow (per event)

1. Adapter subprocess emits raw output (Claude JSON line, Codex chunk, Gemini SSE, Copilot stream).
2. Adapter subclass inlines raw → `ProviderRuntimeEvent` translation at the handler site.
3. Subclass calls `this.pushEvent(event)`.
4. `BaseProvider.pushEvent` wraps in envelope (adds `eventId`, `seq`, `timestamp`, `provider`, `instanceId`, `sessionId`).
5. Zod validation fires in dev only at the producer side.
6. Subject emits to `events$` subscribers.
7. IPC bridge (`instance-communication.ts`) subscribes to `events$`, Zod-parses always (prod trust boundary), forwards on `PROVIDER_RUNTIME_EVENT`.
8. Renderer preload receives envelope, `InstanceEventsService` fans out to components via filtered observables / signals.

### Why this shape

- One Observable per instance unifies the 9-kind × 4-provider matrix currently served by four `*EventMapper` classes.
- `pushEvent()` + inline translation removes mapper indirection. Translation lives at the site that knows the raw format best.
- SDK interface means renderer + future plugins depend on a stable contract without pulling Node-only main-process code.
- UUID `eventId` enables log tracing across IPC; monotonic `seq` enables gap detection and per-instance ordering.

---

## Section 2: Contracts Layer

### 2.1 `ProviderRuntimeEventEnvelope` v2

`packages/contracts/src/types/provider-runtime-events.ts`:

```typescript
export interface ProviderRuntimeEventEnvelope {
  readonly eventId: string;        // UUID v4 — globally unique
  readonly seq: number;             // monotonic per instance, starts at 0
  readonly timestamp: number;       // ms since epoch, emission time
  readonly provider: ProviderName;  // 'claude' | 'codex' | 'gemini' | 'copilot'
  readonly instanceId: string;
  readonly sessionId?: string;
  readonly event: ProviderRuntimeEvent;  // existing 9-kind union, frozen
}
```

### 2.2 Zod schema

`packages/contracts/src/schemas/provider-runtime-events.schemas.ts` (new):

```typescript
export const ProviderRuntimeEventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  provider: ProviderNameSchema,
  instanceId: z.string().min(1),
  sessionId: z.string().optional(),
  event: ProviderRuntimeEventSchema,  // existing 9-kind discriminated union
});
```

Exported via subpath `@contracts/schemas/provider-runtime-events` (Wave 1 compliant).

### 2.3 `ProviderAdapter` interface

`packages/sdk/src/provider-adapter.ts` (new):

```typescript
export interface ProviderAdapter {
  readonly provider: ProviderName;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly events$: Observable<ProviderRuntimeEventEnvelope>;

  initialize(config: ProviderConfig): Promise<void>;
  sendMessage(message: string, options?: SendOptions): Promise<void>;
  terminate(): Promise<void>;
  checkStatus(): ProviderStatus;
  getUsage(): ProviderUsage | null;
  getPid(): number | null;
  isRunning(): boolean;
}
```

### 2.4 `ProviderAdapterCapabilities`

All six flags ship in v1:

```typescript
export interface ProviderAdapterCapabilities {
  readonly interruption: boolean;
  readonly permissionPrompts: boolean;
  readonly sessionResume: boolean;
  readonly streamingOutput: boolean;
  readonly usageReporting: boolean;
  readonly subAgents: boolean;
}
```

### 2.5 Registry interface

`packages/sdk/src/provider-adapter-registry.ts` (new):

```typescript
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

### 2.6 Subpath exports

```
@contracts/types/provider-runtime-events
@contracts/schemas/provider-runtime-events
@sdk/provider-adapter
@sdk/provider-adapter-registry
```

All explicit subpaths; no barrels. `verify:exports` (Wave 1) gates this.

---

## Section 3: Producer Side — `BaseProvider` Rewrite

### 3.1 Final shape (Phase 3 end-state)

`src/main/providers/base-provider.ts`:

```typescript
export abstract class BaseProvider implements ProviderAdapter {
  abstract readonly provider: ProviderName;
  abstract readonly capabilities: ProviderAdapterCapabilities;

  private readonly _events$ = new Subject<ProviderRuntimeEventEnvelope>();
  readonly events$: Observable<ProviderRuntimeEventEnvelope> = this._events$.asObservable();

  private _seq = 0;

  protected readonly instanceId: string;
  protected readonly sessionId?: string;

  constructor(opts: { instanceId: string; sessionId?: string }) {
    this.instanceId = opts.instanceId;
    this.sessionId = opts.sessionId;
  }

  protected pushEvent(event: ProviderRuntimeEvent): void {
    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: crypto.randomUUID(),
      seq: this._seq++,
      timestamp: Date.now(),
      provider: this.provider,
      instanceId: this.instanceId,
      sessionId: this.sessionId,
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

  // Lifecycle convenience helpers — boilerplate identical across all 4 adapters.
  // Each is a thin wrapper that builds the matching event object and calls pushEvent().
  protected pushStatus(status: ProviderStatus['status'], detail?: string): void {
    this.pushEvent({ kind: 'status', status, detail });
  }
  protected pushExit(code: number | null, signal: string | null): void {
    this.pushEvent({ kind: 'exit', code, signal });
  }
  protected pushError(error: Error, recoverable: boolean): void {
    this.pushEvent({ kind: 'error', message: error.message, stack: error.stack, recoverable });
  }
  protected pushSpawned(pid: number): void {
    this.pushEvent({ kind: 'spawned', pid });
  }
  protected pushComplete(reason: CompleteReason): void {
    this.pushEvent({ kind: 'complete', reason });
  }

  abstract initialize(config: ProviderConfig): Promise<void>;
  abstract sendMessage(message: string, options?: SendOptions): Promise<void>;
  abstract terminate(): Promise<void>;
  abstract checkStatus(): ProviderStatus;
  abstract getUsage(): ProviderUsage | null;
  abstract getPid(): number | null;
  abstract isRunning(): boolean;
}
```

### 3.2 Phase 1 transitional bridge (temporary)

During Phase 1 only, `BaseProvider` dual-extends `EventEmitter` and wires a subscribe-to-self bridge:

```typescript
// PHASE 1 ONLY — removed in Phase 3
export abstract class BaseProvider extends EventEmitter implements ProviderAdapter {
  constructor(opts: { instanceId: string; sessionId?: string }) {
    super();
    this.instanceId = opts.instanceId;
    this.sessionId = opts.sessionId;

    // Bridge legacy emit() into events$ via per-provider normalizer (still in place)
    this.on('output', raw => {
      const event = normalizeAdapterEvent(this.provider, 'output', raw);
      if (event) this.pushEvent(event);
    });
    this.on('status',  s => this.pushEvent({ kind: 'status', ...s }));
    this.on('error',   e => this.pushEvent({ kind: 'error', message: e.message, recoverable: false }));
    this.on('exit',    x => this.pushEvent({ kind: 'exit', code: x.code, signal: x.signal }));
    // ... one bridge line per legacy event type
  }
}
```

Subclasses remain unchanged during Phase 1. Consumers can subscribe to either `events$` or legacy `.on(...)`.

### 3.3 Subscribe-to-self ordering constraint

Constructor registers bridges *before* subclass code runs. A subclass that emits during its own constructor body would fire before the bridge exists — the event would drop.

**Mitigation:** Adapters never emit during construction. They only emit during `initialize()` or subprocess handlers, which run after construction completes. Enforced via:
- `BaseProvider` unit test asserting post-construction emission works
- Code-review checklist item in the adapter migration tasks

### 3.4 eventId + seq mechanics

- `eventId`: `crypto.randomUUID()` (Node 18+ built-in; no `uuid` npm dep).
- `seq`: `this._seq++` per instance, starts at 0. Resets on each new `BaseProvider` construction (i.e., each provider restart).
- Both are stable across IPC serialization.

---

## Section 4: Registry Implementation (main-side)

`src/main/providers/provider-adapter-registry.ts` (new):

```typescript
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
    return [...this.descriptors.values()];
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
```

### 4.1 Bootstrap

`src/main/providers/register-built-in-providers.ts`:

```typescript
export function registerBuiltInProviders(registry: ProviderAdapterRegistry): void {
  registry.register(CLAUDE_DESCRIPTOR,  (config) => new ClaudeProvider(config));
  registry.register(CODEX_DESCRIPTOR,   (config) => new CodexProvider(config));
  registry.register(GEMINI_DESCRIPTOR,  (config) => new GeminiProvider(config));
  registry.register(COPILOT_DESCRIPTOR, (config) => new CopilotProvider(config));
}
```

Each `*_DESCRIPTOR` is a `const` exported from its adapter file alongside the class.

### 4.2 Split of existing `provider-registry.ts`

Current file mixes three concerns. Split:

| Concern | New home |
| --- | --- |
| Adapter factory + descriptors | `ProviderAdapterRegistryImpl` (this section) |
| Instance lifecycle tracking (running instances per session, restart/terminate coordination) | `ProviderInstanceManager` — a rename of the current `provider-registry.ts` with factory logic extracted |
| `DEFAULT_PROVIDER_CONFIGS` blob | Moved onto each `*_DESCRIPTOR.defaultConfig` — no cross-cutting config object |

`ProviderInstanceManager` receives `ProviderAdapterRegistry` via constructor injection for testability.

### 4.3 Singleton export

`src/main/providers/index.ts` exports both the class (for tests) and a singleton (for main-process startup):

```typescript
export { ProviderAdapterRegistryImpl };
export const providerAdapterRegistry: ProviderAdapterRegistry = new ProviderAdapterRegistryImpl();
```

Main-process init calls `registerBuiltInProviders(providerAdapterRegistry)` once.

---

## Section 5: Adapter Migration (×4)

Each of `ClaudeProvider`, `CodexProvider`, `GeminiProvider`, `CopilotProvider` undergoes the same transformation during Phase 3.

### 5.1 Template transformation

**Before** (example: Claude):

```typescript
// claude-provider.ts
export class ClaudeProvider extends BaseProvider {
  private onStdoutChunk(chunk: string): void {
    const parsed = JSON.parse(chunk);
    this.emit('output', parsed);  // → ClaudeEventMapper via subscribe-to-self
  }
}

// event-normalizer.ts
export class ClaudeEventMapper implements ProviderEventMapper {
  provider = 'claude' as const;
  normalize(rawType: string, ...args: unknown[]): ProviderRuntimeEvent | null {
    // 80+ lines of switch statements
  }
}
```

**After:**

```typescript
// claude-provider.ts — self-contained
export const CLAUDE_DESCRIPTOR: ProviderAdapterDescriptor = {
  provider: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    interruption: true,
    permissionPrompts: true,
    sessionResume: true,
    streamingOutput: true,
    usageReporting: true,
    subAgents: true,
  },
  defaultConfig: DEFAULT_CLAUDE_CONFIG,   // moved here from the existing DEFAULT_PROVIDER_CONFIGS.claude in provider-registry.ts
};

export class ClaudeProvider extends BaseProvider {
  readonly provider = 'claude' as const;
  readonly capabilities = CLAUDE_DESCRIPTOR.capabilities;

  private onStdoutChunk(chunk: string): void {
    const parsed = JSON.parse(chunk);

    switch (parsed.type) {
      case 'assistant':
        this.pushEvent({
          kind: 'output',
          role: 'assistant',
          content: parsed.message.content,
        });
        break;
      case 'tool_use':
        this.pushEvent({
          kind: 'tool_use',
          toolName: parsed.name,
          input: parsed.input,
          toolUseId: parsed.id,
        });
        break;
      case 'tool_result':
        this.pushEvent({
          kind: 'tool_result',
          toolUseId: parsed.tool_use_id,
          output: parsed.content,
          isError: parsed.is_error ?? false,
        });
        break;
      // … other Claude-specific raw types
    }
  }
}
```

### 5.2 Per-adapter specifics

| Adapter | Raw input | Raw → union mappings | Capabilities |
| --- | --- | --- | --- |
| Claude | line-delimited JSON from `claude code` CLI | ~8 raw types | all six `true` |
| Codex | JSON chunks from Codex CLI | ~7 raw types | `subAgents: false`; rest `true` |
| Gemini | SSE-formatted events from Gemini CLI | ~5 raw types (currently delegates to Codex mapper — **delegation deleted**) | `sessionResume: false`, `subAgents: false`; rest `true` |
| Copilot | streamed from `@github/copilot-sdk` | (currently delegates to Codex mapper — **delegation deleted**) | `permissionPrompts: false`, `subAgents: false`; rest `true` |

### 5.3 Emit-site estimate

~15–30 `emit('output', …)` call sites per adapter (stdout chunks + stderr + lifecycle events). Each becomes either `pushEvent({ kind, … })` or a `pushStatus/pushExit/pushError/pushSpawned/pushComplete` helper call.

### 5.4 Files deleted at end of Phase 3

- `src/main/providers/event-normalizer.ts` — contains all 4 mapper classes + `normalizeAdapterEvent()`
- `src/main/providers/normalizer-registry.ts` if present as separate file
- Isolated mapper spec files — replaced by parity tests (Section 8)

---

## Section 6: Consumer Migration (full-stack)

Six consumer groups. Each moves from `provider.on('output', …)` / `.on('status', …)` / etc. → `provider.events$.subscribe(envelope => …)`.

### 6.1 `src/main/services/instance-communication.ts`

The fanout hub. Currently subscribes via multiple `.on(...)` listeners; becomes one subscription:

```typescript
const subscription = provider.events$.subscribe(envelope => {
  this.forwardToRenderer(envelope);
  this.recordForReplay(envelope);
  // envelope.event.kind discriminates for routing
});
```

Subscription stored on instance record, unsubscribed on provider termination.

### 6.2 Telemetry (`src/main/telemetry/`, `src/main/observability/`)

Single subscription; switch on `envelope.event.kind` for span naming. `envelope.eventId` becomes the span attribute for trace correlation.

### 6.3 Orchestration (`src/main/orchestration/`)

Debate orchestrator, sequential-mode controller. Filter-subscribe pattern for `complete` / `error` kinds.

### 6.4 Failover manager (`src/main/providers/failover-manager.ts`)

Filter-subscribe for `exit` / `error` kinds.

### 6.5 Activity-state-detector (`src/main/providers/activity-state-detector.ts`)

Filter-subscribe for `status` kinds.

### 6.6 IPC bridge consolidation

Single channel `IPC_CHANNELS.PROVIDER_RUNTIME_EVENT` replaces ~9 per-event-type channels. Zod validates at this boundary *always* (prod trust boundary, per Q7):

```typescript
private forwardToRenderer(envelope: ProviderRuntimeEventEnvelope): void {
  ProviderRuntimeEventEnvelopeSchema.parse(envelope);  // always — trust boundary
  this.mainWindow?.webContents.send(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, envelope);
}
```

**Channels deleted from `packages/contracts/src/channels/`:**
- `INSTANCE_OUTPUT`, `INSTANCE_STATUS`, `INSTANCE_ERROR`, `INSTANCE_TOOL_USE`, `INSTANCE_TOOL_RESULT`, `INSTANCE_EXIT`, `INSTANCE_SPAWNED`, `INSTANCE_COMPLETE`, `INSTANCE_CONTEXT`

Wave 1's `verify:ipc` gates channel drift.

### 6.7 Renderer preload

`src/preload/` exposes `onProviderRuntimeEvent(cb: (envelope) => void)`. Replaces ~9 per-event-type listeners.

### 6.8 Renderer `InstanceEventsService`

```typescript
@Injectable({ providedIn: 'root' })
export class InstanceEventsService {
  private readonly _events$ = new Subject<ProviderRuntimeEventEnvelope>();
  readonly events$ = this._events$.asObservable();

  readonly outputEvents$ = this.events$.pipe(filter(e => e.event.kind === 'output'));
  readonly statusEvents$ = this.events$.pipe(filter(e => e.event.kind === 'status'));
  // … one convenience stream per kind consumers actually use

  constructor() {
    window.electronAPI.onProviderRuntimeEvent(envelope => {
      this._events$.next(envelope);
    });
  }
}
```

Components using signals: `toSignal(this.events.outputEvents$)`.

### 6.9 Gap detection (latent capability from `seq`)

```typescript
let expectedSeq = 0;
this.events$.subscribe(env => {
  if (env.seq !== expectedSeq) {
    console.warn(`Event gap: expected ${expectedSeq}, got ${env.seq}`);
  }
  expectedSeq = env.seq + 1;
});
```

Per-`instanceId` tracking; resets on new instance. Not wired into UI in Wave 2; telemetry counter optional.

### 6.10 Migration order (safety-preserving)

Because Phase 1's subscribe-to-self bridge keeps the legacy EventEmitter path alive during Phases 1–2, consumers migrate one at a time:

1. IPC bridge + preload + renderer `InstanceEventsService`
2. Telemetry
3. Orchestration
4. Failover manager
5. Activity-state-detector
6. `instance-communication.ts` (last — it's the fanout hub)

Once all six consumers subscribe only to `events$`, Phase 3 begins.

---

## Section 7: Legacy Removal (Phase 3 end)

### 7.1 Deletions

**Files:**
- `src/main/providers/event-normalizer.ts`
- `src/main/providers/__tests__/event-normalizer.spec.ts`
- `src/main/providers/normalizer-registry.ts` if present

**Symbols:**
- `ProviderEventMapper` interface in `packages/contracts/src/types/provider-runtime-events.ts`
- Deprecated `ProviderEvent` alias in `packages/sdk/src/providers.ts`
- `BaseProvider`'s Phase 1 subscribe-to-self constructor lines
- `extends EventEmitter` from `BaseProvider`
- `import { EventEmitter } from 'node:events'` from `base-provider.ts` and each adapter

**IPC channels** (see Section 6.6 list).

**Preload methods:** the ~9 per-event-type listeners.

### 7.2 CI-enforced verifications

Already gated by Wave 1's `pretest`/`prebuild`:
- `npm run verify:ipc` — catches stale channel refs
- `npm run verify:exports` — catches barrel imports
- `npm run lint` — catches unused imports
- `npm run build:main` — compiles against new types
- `npm run test` — full suite + parity tests

### 7.3 Grep sweeps (manual checkpoint steps)

Zero-hit requirements before Wave 2 closes:

```bash
rg "extends EventEmitter" src/main/providers/
rg "\.emit\(['\"]output['\"]" src/main/
rg "from ['\"].*event-normalizer['\"]"
rg "ProviderEventMapper"
rg "normalizeAdapterEvent"
rg "INSTANCE_OUTPUT|INSTANCE_STATUS|INSTANCE_ERROR" src/
```

### 7.4 What remains EventEmitter (scope boundary)

Node `child_process` subprocess events (`data`, `exit`, `error`) stay EventEmitter — that's Node's API. Adapters still `process.stdout.on('data', …)`. Only the `BaseProvider` → downstream layer drops EventEmitter.

---

## Section 8: Testing Strategy

### 8.1 Parity matrix (synthesized)

9 kinds × 4 providers = 36 cells. `src/main/providers/__tests__/parity/provider-parity.spec.ts`:

```typescript
const SCENARIOS: ReadonlyArray<{
  name: string;
  kind: ProviderRuntimeEvent['kind'];
  inputs: Record<ProviderName, RawProviderInput>;
  expected: Record<ProviderName, Partial<ProviderRuntimeEvent>>;
}> = [
  {
    name: 'assistant text output',
    kind: 'output',
    inputs: {
      claude:  { type: 'assistant', message: { content: 'hello' } },
      codex:   { chunk: { role: 'assistant', text: 'hello' } },
      gemini:  'data: {"role":"model","text":"hello"}\n\n',
      copilot: { event: 'message', data: { role: 'assistant', content: 'hello' } },
    },
    expected: {
      claude:  { kind: 'output', role: 'assistant', content: 'hello' },
      codex:   { kind: 'output', role: 'assistant', content: 'hello' },
      gemini:  { kind: 'output', role: 'assistant', content: 'hello' },
      copilot: { kind: 'output', role: 'assistant', content: 'hello' },
    },
  },
  // … 8 more scenarios (tool_use, tool_result, status, context, error, exit, spawned, complete)
];

describe('provider parity', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      for (const provider of PROVIDERS) {
        it(`${provider} produces ${scenario.kind} envelope`, async () => {
          const adapter = createTestAdapter(provider);
          const events: ProviderRuntimeEventEnvelope[] = [];
          adapter.events$.subscribe(e => events.push(e));

          adapter.__feedRaw(scenario.inputs[provider]);
          await waitForEvent();

          expect(events).toHaveLength(1);
          expect(events[0].event).toMatchObject(scenario.expected[provider]);
          expect(events[0].eventId).toMatch(/^[0-9a-f-]{36}$/);
          expect(events[0].seq).toBe(0);
          expect(events[0].provider).toBe(provider);
        });
      }
    });
  }
});
```

Test adapters expose `__feedRaw(input: unknown)` to bypass subprocess spawn (test-mode constructor flag).

### 8.2 Recorded fixtures (regression anchors)

`packages/contracts/src/__fixtures__/provider-events/<provider>/<scenario>.jsonl` — anonymized real sessions:
- `claude/basic-conversation.jsonl` (10–20 raw events)
- `claude/tool-use-bash.jsonl`
- `codex/basic-conversation.jsonl`
- `codex/tool-use-bash.jsonl`
- `gemini/basic-conversation.jsonl`
- `copilot/basic-conversation.jsonl`

Golden outputs at `<scenario>.golden.jsonl`. Test feeds fixture → asserts envelope stream matches golden (with `eventId` scrubbed, `seq`/`timestamp` normalized).

Fixture recording helper: `scripts/record-provider-fixture.ts` — manually invoked, not CI-gated.

### 8.3 Unit tests

**`src/main/providers/__tests__/base-provider.spec.ts`:**
- `pushEvent` populates `eventId` (UUID v4), `seq` (monotonic), `timestamp`, `provider`, `instanceId`
- `seq` resets to 0 per new instance
- `events$` is Subject-hot; late subscribers only get subsequent events
- `completeEvents()` closes the stream; subscribers' complete handlers fire
- Emission post-construction succeeds (bridges the Phase 1 ordering risk)

**`src/main/providers/__tests__/provider-adapter-registry.spec.ts`:**
- `register` throws on duplicate
- `get` throws on unknown
- `create` invokes factory with config
- `list` returns descriptors

**Consumer test updates** (existing files, signature changes):
- `instance-communication.spec.ts` — subscription lifecycle, unsubscribe on termination, fanout
- telemetry tests — envelope → span correlation via `eventId`
- renderer `instance-events.service.spec.ts` — envelope routing, gap detection warning

### 8.4 Zod schema tests

`packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts`:
- Valid envelope parses
- Missing `eventId` rejects
- Non-UUID `eventId` rejects
- Negative `seq` rejects
- Unknown `event.kind` rejects (exhaustiveness)

### 8.5 Test count estimate

| Category | New/changed |
| --- | --- |
| Parity matrix | 36 |
| Recorded fixtures | 6 |
| BaseProvider unit | ~8 |
| Registry unit | ~6 |
| Zod schema | ~8 |
| Consumer updates | ~20 |
| **Total** | **~90** |

Suite grows from 3,626 → ~3,700 tests; budget +5s.

### 8.6 CI gate

Wave 2's final task: `npm run lint && npm run test && npm run verify:ipc && npm run verify:exports && npm run build`. All green to ship.

---

## Section 9: Deprecation & Forward Compatibility

The 9-kind `ProviderRuntimeEvent` taxonomy shipped in Wave 2 is **frozen** as of this wave. No new `kind` values are added here. This constraint exists so Wave 3 can introduce a 5-family hierarchical taxonomy (session / turn / content / request / runtime) without compounded migration risk.

### Wave 3 commitments

1. **Coexistence window.** Wave 3 introduces `ProviderRuntimeEventV2` (5-family shape) as a parallel type. Both `ProviderRuntimeEvent` (v1, frozen here) and `ProviderRuntimeEventV2` remain valid envelope payloads for one release cycle. `ProviderRuntimeEventEnvelope` gains a `version: 1 | 2` field to discriminate.

2. **Translator layer.** Wave 3 ships bidirectional translators: `v1ToV2(ProviderRuntimeEvent): ProviderRuntimeEventV2` and `v2ToV1`. Adapters emit v2 directly; translator backfills v1 for unmigrated consumers. Translator is deleted in Wave 5.

3. **Codemod.** Wave 3 ships `scripts/migrate-provider-events-v1-to-v2.ts` for mechanical in-tree consumer migration. CI gates on zero v1 consumer references by end of Wave 4.

4. **No silent kind additions.** If a 10th kind becomes necessary before Wave 3 lands, it is escalated to a Wave 3 scope change rather than patched inline. Exception: purely additive, optional fields on existing kinds (e.g., `output.model?: string`) are permitted without bumping version.

5. **Telemetry contract stability.** `eventId` is stable across v1→v2; trace correlation does not break during coexistence.

### In-repo marker

```typescript
/**
 * @frozen as of Wave 2 (2026-04-17). See Wave 3 design doc for v2 taxonomy.
 * Do not add new `kind` values to this union.
 */
export type ProviderRuntimeEvent =
  | OutputEvent | ToolUseEvent | ToolResultEvent | StatusEvent
  | ContextEvent | ErrorEvent | ExitEvent | SpawnedEvent | CompleteEvent;
```

PR reviewers and code-review subagents have a clear signal.

---

## Section 10: Rollout, Risks, Open Items

### 10.1 Phased rollout (internal checkpoints)

| Checkpoint | Scope | Verify |
| --- | --- | --- |
| 1 — Contracts green | `@contracts` + `@sdk` types/schemas, subpath exports wired | build clean; no runtime change; Wave 1 `verify:*` green |
| 2 — Producer scaffolded | `BaseProvider` dual-mode with subscribe-to-self bridge; registry skeleton | all existing tests still pass |
| 3 — Consumers on `events$` | All 6 consumer groups migrated; legacy EventEmitter listeners removed from consumers | producers still emit; bridge still forwards; full suite green |
| 4 — Producers on `pushEvent` | All 4 adapters rewritten with inline translation; `event-normalizer.ts` deleted; `BaseProvider` drops EventEmitter | parity matrix green |
| 5 — Legacy channel deletion | Old per-event-type IPC channels removed from contracts + preload + renderer | grep sweeps zero hits; full `lint && test && verify:* && build` green |

### 10.2 Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | Subscribe-to-self ordering during Phase 1 — subclass emits during constructor before bridge registers | Adapters never emit during construction; tested via BaseProvider unit test + code-review checklist |
| R2 | Subject memory leak on unterminated providers | `BaseProvider.terminate()` calls `completeEvents()` unconditionally; subclasses chain `super.terminate()` |
| R3 | Zod parse cost at IPC boundary (~1k events/sec peak) | Measured ~3µs/parse on M-series; 3ms/sec budget; if profiling disagrees post-ship, gate prod parse behind runtime flag |
| R4 | Renderer components missing events during hot-reload | `seq` gap detection surfaces in telemetry; not a regression |
| R5 | Test time budget (+~90 tests) | Suite grows ~5s on 90s baseline; acceptable |
| R6 | "Frozen 9-kind" discipline risk — pressing 10th-kind need arrives mid-Wave-2 | Section 9 language + `@frozen` JSDoc; escalate to Wave 3 rather than patch inline |

### 10.3 Out of scope (explicit)

- 5-family taxonomy (Wave 3)
- New provider adapters (Cursor, Aider, etc.)
- MCP tool integration events (Wave 3+)
- Worker-agent event normalization (Item 2 / Wave 4)
- Renderer UI driven by capability flags (Wave 5+)

### 10.4 Open items for the plan writer

- Exact IPC channel name: `PROVIDER_RUNTIME_EVENT` vs `INSTANCE_EVENT` vs `PROVIDER_EVENT`. Preference: `PROVIDER_RUNTIME_EVENT` (mirrors type name). Check against Wave 1 channel naming.
- `BaseProvider.completeEvents()` visibility: `protected` (preferred, allows subclass `terminate()` override).
- Singleton registry export in addition to class: export both; main-process uses singleton, tests inject fresh.
- Test-mode `__feedRaw()` signature: unified `__feedRaw(input: unknown)`; adapter-specific parsing internal.

### 10.5 Wave size estimate

~28 tasks, 2–5 min steps per `writing-plans` convention → ~120–180 steps. Subagent-driven execution: continuous; human-reviewed: 4–6 sessions.

---

## Post-Wave Artifacts

- Implementation plan at `docs/superpowers/plans/YYYY-MM-DD-wave2-provider-normalization.md` (written by `superpowers:writing-plans` immediately after this spec is approved).
- Subsequent waves (3–9) brainstormed one at a time per the roadmap in the parent design doc's Section 4.
