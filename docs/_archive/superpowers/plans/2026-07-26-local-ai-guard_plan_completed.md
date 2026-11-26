# Local AI Guard Implementation Plan

**Status:** Completed and independently verified on 2026-07-30; six rebuilt-app,
real-provider, or external-worker checks remain in the linked live-test plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an enrolled-target Local AI Guard that proves coordinator and worker Ollama effectiveness, prevents unhealthy local routing, makes paid fallback visible and controllable, and provides incident, recovery, and historical cost-impact surfaces.

**Architecture:** A main-process `local-ai-guard` domain owns SQLite repositories, probes, scheduling, health derivation, routing policy, incidents, and recovery. Worker-local checks use bounded authenticated RPC; coordinator-local checks use the same typed probe result. Auxiliary routing consults the guard before using an enrolled target or escalating to frontier, while a dedicated IPC/preload/Angular stack exposes setup, current health, approvals, recovery, and trends.

**Tech Stack:** TypeScript, Electron 40, Angular 21 standalone components with signals and `OnPush`, better-sqlite3 through `SqliteDriver`, Zod 4, Vitest, generated preload IPC channels.

**Specification:** [2026-07-25-local-ai-guard_spec_completed.md](../specs/2026-07-25-local-ai-guard_spec_completed.md)

## Global Constraints

- Work in the existing checkout and branch. Do not create a branch or worktree.
- Do not commit or push unless James explicitly asks.
- Monitor, poll, score, alert on, and protect only explicitly enrolled targets; an unmanaged machine or endpoint is neutral.
- The first failed required check removes the affected role from routing; two consecutive failures show Degraded; three show Unavailable and open an incident; recovery requires two consecutive successes.
- Defaults are a 60-second endpoint/model check, 10-minute load-aware functional canary, two-minute pre-route freshness limit, and outage backoff capped at 15 minutes.
- Canary prompts contain no user or repository content and never fall back to a paid provider.
- Persist no credentials, prompt bodies, or model responses. Known and estimated cost remain separate.
- Automatic repair is opt-in, bounded, audited, and restricted to named platform-specific operations.
- Preserve unrelated changes in the dirty working tree.
- Follow TDD: write a focused failing test, run it, implement the smallest complete behaviour, and rerun it.
- Keep active plan and spec files untracked. Rename them `_completed` only after implementation, canonical verification, live-test deferral where genuinely required, and an independent `task-completion-gate` PASS.

---

## File Structure

### Shared contracts

- `src/shared/types/local-ai-guard.types.ts` — domain types and exact public DTOs.
- `src/shared/validation/local-ai-guard.schemas.ts` — Zod schemas for IPC and worker RPC payloads.
- `packages/contracts/src/channels/local-ai-guard.channels.ts` — channel names.

### Main process

- `src/main/local-ai-guard/local-ai-target-repository.ts` — target lifecycle and configuration CRUD.
- `src/main/local-ai-guard/local-ai-health-repository.ts` — samples, incidents, routing events, fallback requests, retention, and aggregates.
- `src/main/local-ai-guard/local-ai-probe-service.ts` — local and worker probe orchestration.
- `src/main/local-ai-guard/local-ai-health-engine.ts` — pure state transitions and role eligibility.
- `src/main/local-ai-guard/local-ai-activity-registry.ts` — in-flight local-model work leases used by the scheduler.
- `src/main/local-ai-guard/local-ai-incident-service.ts` — incident deduplication and notifications.
- `src/main/local-ai-guard/local-ai-recovery-service.ts` — diagnostics and bounded recovery.
- `src/main/local-ai-guard/local-ai-health-scheduler.ts` — cadence, freshness, single-flight, deferral, and backoff.
- `src/main/local-ai-guard/local-ai-fallback-approval-service.ts` — durable pending fallback decisions and awaiting callers.
- `src/main/local-ai-guard/local-ai-routing-guard.ts` — health, policy, budget, and fallback enforcement.
- `src/main/local-ai-guard/local-ai-cost-correlation.ts` — AsyncLocalStorage correlation between fallback decisions and existing cost attribution.
- `src/main/local-ai-guard/local-ai-runtime.ts` — singleton construction, startup, subscriptions, and disposal.
- `src/main/local-ai-guard/index.ts` — public domain exports.
- `src/main/ipc/handlers/local-ai-guard-handlers.ts` — validated renderer API and delta bridge.

### Worker process

- `src/worker-agent/worker-local-ai-health.ts` — bounded metadata, model, canary, diagnosis, and named restart operations.

### Renderer

- `src/renderer/app/core/services/ipc/local-ai-guard-ipc.service.ts` — typed renderer calls and events.
- `src/renderer/app/core/state/local-ai-guard.store.ts` — signal state and optimistic action coordination.
- `src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.*` — health-centre shell.
- `src/renderer/app/features/local-ai-guard/local-ai-target-card.component.ts` — target/layer status.
- `src/renderer/app/features/local-ai-guard/local-ai-target-setup.component.*` — discovery, validation, and enrolment.
- `src/renderer/app/features/local-ai-guard/local-ai-incident-panel.component.ts` — incident timeline and recovery.
- `src/renderer/app/features/local-ai-guard/local-ai-effectiveness-panel.component.ts` — 24h/7d/30d metrics.
- `src/renderer/app/features/local-ai-guard/local-ai-status-chip.component.ts` — title-bar aggregate status.
- `src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.ts` — pending paid-fallback action bar.

---

### Task 1: Domain Contracts and SQLite Migration

**Files:**
- Create: `src/shared/types/local-ai-guard.types.ts`
- Create: `src/shared/validation/local-ai-guard.schemas.ts`
- Modify: `src/main/persistence/rlm/rlm-migrations-051-055.ts`
- Test: `src/main/local-ai-guard/local-ai-migration.spec.ts`
- Test: `src/shared/validation/local-ai-guard.schemas.spec.ts`

**Interfaces:**
- Produces: `LocalAiTarget`, `LocalAiTargetConfig`, `LocalAiProbeResult`, `LocalAiTargetStatus`, `LocalAiIncident`, `LocalAiRoutingEvent`, `LocalAiFallbackRequest`, `LocalAiEffectivenessSummary`, and their Zod schemas.
- Produces migration `054_local_ai_guard` with six tables: `local_ai_targets`, `local_ai_health_samples`, `local_ai_incidents`, `local_ai_routing_events`, `local_ai_fallback_requests`, and `local_ai_daily_aggregates`.

- [x] **Step 1: Write migration and schema tests**

```ts
it('migration 054 creates and rolls back every Local AI Guard table', () => {
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  expect(migration).toBeDefined();
  db.exec(migration!.up);
  expect(tableNames(db)).toEqual(expect.arrayContaining([
    'local_ai_targets',
    'local_ai_health_samples',
    'local_ai_incidents',
    'local_ai_routing_events',
    'local_ai_fallback_requests',
    'local_ai_daily_aggregates',
  ]));
  db.exec(migration!.down);
  expect(tableNames(db)).not.toContain('local_ai_targets');
});

it('rejects an enrolled target without a canary model', () => {
  expect(() => LocalAiTargetConfigSchema.parse({
    lifecycle: 'enrolled',
    location: { type: 'worker', nodeId: 'node-1' },
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: ['qwen3:14b'],
    canary: { model: '', timeoutMs: 30_000, intervalMs: 600_000 },
  })).toThrow();
});
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-migration.spec.ts src/shared/validation/local-ai-guard.schemas.spec.ts
```

Expected: FAIL because migration 054 and Local AI Guard schemas do not exist.

- [x] **Step 3: Define exact domain types and schemas**

Use these core discriminants and enums:

```ts
export type LocalAiTargetLifecycle = 'unmanaged' | 'enrolled' | 'paused' | 'retired';
export type LocalAiHealthState = 'checking' | 'healthy' | 'degraded' | 'unavailable' | 'paused';
export type LocalAiHealthLayer = 'worker' | 'endpoint' | 'model' | 'inference' | 'effectiveness';
export type LocalAiFallbackPolicy =
  | 'allow-silently'
  | 'notify-and-allow'
  | 'require-confirmation'
  | 'defer-locally'
  | 'block-paid-fallback';
export type LocalAiFailureCode =
  | 'worker-offline'
  | 'worker-degraded'
  | 'rpc-unavailable'
  | 'endpoint-not-advertised'
  | 'configuration-drift'
  | 'connection-refused'
  | 'endpoint-timeout'
  | 'protocol-error'
  | 'authentication-error'
  | 'missing-required-model'
  | 'insufficient-context'
  | 'inference-timeout'
  | 'malformed-inference-output'
  | 'latency-exceeded'
  | 'flapping'
  | 'monitor-error';
export type LocalAiRepairAction =
  | 'recheck-layer'
  | 'deep-check'
  | 'validate-models'
  | 'reconnect-worker'
  | 'restart-ollama';
export type LocalAiFallbackDisposition =
  | 'not-needed'
  | 'allowed'
  | 'pending-confirmation'
  | 'deferred'
  | 'blocked';

export interface LocalAiTargetConfig {
  lifecycle: LocalAiTargetLifecycle;
  location: { type: 'coordinator' } | { type: 'worker'; nodeId: string };
  provider: 'ollama' | 'openai-compatible';
  endpointId: string;
  baseUrl: string;
  expectedModels: Array<{ modelId: string; required: boolean; minContextLength?: number }>;
  canary: { model: string; timeoutMs: number; intervalMs: number };
  endpointCheckIntervalMs: number;
  freshnessLimitMs: number;
  warningLatencyMs: number;
  routingRoles: AuxiliaryLlmSlot[];
  fallbackPolicy: LocalAiFallbackPolicy;
  slotFallbackPolicies: Partial<Record<AuxiliaryLlmSlot, LocalAiFallbackPolicy>>;
  confirmAboveInputTokens?: number;
  dailyFallbackBudgetUsd?: number;
  incidentFallbackBudgetUsd?: number;
  recovery: { automatic: boolean; maxAttempts: number; cooldownMs: number };
}

export type LocalAiTargetPatch = Partial<Omit<LocalAiTargetConfig, 'location' | 'provider' | 'endpointId'>>;
export interface LocalAiTarget extends LocalAiTargetConfig {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  pausedUntil?: number;
  retiredAt?: number;
}
export interface LocalAiEndpointIdentity {
  location: LocalAiTargetConfig['location'];
  provider: LocalAiTargetConfig['provider'];
  endpointId: string;
  baseUrl: string;
}

export interface LocalAiProbeResult {
  targetId: string;
  layer: LocalAiHealthLayer;
  checkType: 'lightweight' | 'functional';
  ok: boolean;
  required: boolean;
  affectedRoles: AuxiliaryLlmSlot[];
  checkedAt: number;
  durationMs: number;
  failureCode?: LocalAiFailureCode;
  message?: string;
  evidence: Record<string, string | number | boolean | string[] | undefined>;
}

export type LocalAiHealthSample = LocalAiProbeResult & {
  id: string;
  origin: 'scheduler' | 'pre-route' | 'manual' | 'recovery';
};

export interface LocalAiTargetStatus {
  targetId: string;
  state: LocalAiHealthState;
  routableRoles: AuxiliaryLlmSlot[];
  layers: Partial<Record<LocalAiHealthLayer, LocalAiProbeResult>>;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  flapping: boolean;
  checkedAt: number;
}

export interface LocalAiHealthTransition {
  previous?: LocalAiTargetStatus;
  current: LocalAiTargetStatus;
  incidentAction: 'none' | 'open' | 'update' | 'resolve';
}

export interface LocalAiAggregateStatus {
  state: LocalAiHealthState | 'not-configured';
  enrolled: number;
  healthy: number;
  degraded: number;
  unavailable: number;
  paused: number;
}

export interface LocalAiIncident {
  id: string;
  targetId: string;
  state: 'open' | 'acknowledged' | 'resolved';
  severity: 'warning' | 'critical';
  failureCode: LocalAiFailureCode;
  affectedLayers: LocalAiHealthLayer[];
  affectedRoles: AuxiliaryLlmSlot[];
  openedAt: number;
  updatedAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  fallbackCount: number;
  knownCostUsd: number;
  estimatedCostUsd: number;
}

export type LocalAiIncidentMutation =
  | { kind: 'open-or-update'; incident: LocalAiIncident }
  | { kind: 'acknowledge'; incidentId: string; at: number }
  | { kind: 'resolve'; incidentId: string; at: number };
export interface LocalAiIncidentQuery {
  targetId?: string;
  state?: LocalAiIncident['state'];
  since?: number;
  limit: number;
}

export interface LocalAiRoutingEvent {
  id: string;
  targetId?: string;
  incidentId?: string;
  slot: AuxiliaryLlmSlot;
  intendedRoute: 'local';
  actualRoute: 'local' | 'frontier' | 'deferred' | 'blocked';
  policy: LocalAiFallbackPolicy;
  disposition: LocalAiFallbackDisposition;
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  knownCostUsd?: number;
  estimatedCostUsd?: number;
  createdAt: number;
  completedAt?: number;
}
export type LocalAiRoutingEventPatch = Partial<
  Pick<LocalAiRoutingEvent, 'actualRoute' | 'disposition' | 'provider' | 'model' | 'inputTokens' | 'outputTokens' | 'knownCostUsd' | 'estimatedCostUsd' | 'completedAt'>
>;

export interface LocalAiFallbackRequest {
  id: string;
  routingEventId: string;
  incidentId?: string;
  slot: AuxiliaryLlmSlot;
  status: 'pending' | 'allowed' | 'deferred' | 'blocked' | 'expired';
  estimatedInputTokens: number;
  estimatedCostUsd?: number;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  resolution?: 'allow-once' | 'allow-incident' | 'defer' | 'block';
}
export type LocalAiFallbackRequestInput = Omit<
  LocalAiFallbackRequest,
  'id' | 'status' | 'createdAt' | 'resolvedAt' | 'resolution'
>;
export type LocalAiFallbackResolution = NonNullable<LocalAiFallbackRequest['resolution']>;

export interface LocalAiDiagnosticReport {
  targetId: string;
  checkedAt: number;
  samples: LocalAiProbeResult[];
  recommendedActions: LocalAiRepairAction[];
}
export interface LocalAiRepairResult {
  targetId: string;
  action: LocalAiRepairAction;
  supported: boolean;
  attempted: boolean;
  recovered: boolean;
  message: string;
  completedAt: number;
}

export interface LocalAiEffectivenessSummary {
  window: '24h' | '7d' | '30d';
  localTasks: number;
  localTokens: number;
  proposedFallbacks: number;
  allowedFallbacks: number;
  deferredFallbacks: number;
  blockedFallbacks: number;
  knownCostUsd: number;
  estimatedCostUsd: number;
  avoidedEstimatedTokens: number;
  avoidedEstimatedCostUsd: number;
  byTarget: Record<string, number>;
  byModel: Record<string, number>;
  bySlot: Partial<Record<AuxiliaryLlmSlot, number>>;
  byIncident: Record<string, number>;
}
export interface LocalAiRetentionReport {
  samplesDeleted: number;
  routingEventsDeleted: number;
  daysAggregated: number;
}

export interface LocalAiLocalRouteVerdict {
  eligible: boolean;
  targetId?: string;
  status?: LocalAiTargetStatus;
  reason: string;
}
export interface LocalAiFallbackVerdict {
  allowed: boolean;
  disposition: LocalAiFallbackDisposition;
  policy: LocalAiFallbackPolicy;
  routingEventId: string;
  fallbackRequestId?: string;
}
export interface LocalAiGuardSnapshot {
  aggregate: LocalAiAggregateStatus;
  targets: LocalAiTargetStatus[];
  incidents: LocalAiIncident[];
  pendingFallbacks: LocalAiFallbackRequest[];
}
```

All persisted DTOs must include stable IDs and timestamps. `LocalAiRoutingEvent` must store `knownCostUsd?: number` and `estimatedCostUsd?: number` as separate fields.

- [x] **Step 4: Add migration 054**

The migration must create foreign keys from samples/incidents/routing events to targets, indexes on target/time and incident state, a uniqueness constraint preventing duplicate active endpoint identities, and a pending-request index. The `down` SQL must drop indexes before tables in reverse dependency order.

- [x] **Step 5: Run focused tests**

Run:

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-migration.spec.ts src/shared/validation/local-ai-guard.schemas.spec.ts
```

Expected: PASS.

---

### Task 2: Target and Health Repositories

**Files:**
- Create: `src/main/local-ai-guard/local-ai-target-repository.ts`
- Create: `src/main/local-ai-guard/local-ai-health-repository.ts`
- Create: `src/main/local-ai-guard/local-ai-row-mappers.ts`
- Test: `src/main/local-ai-guard/local-ai-target-repository.spec.ts`
- Test: `src/main/local-ai-guard/local-ai-health-repository.spec.ts`

**Interfaces:**
- Consumes: migration 054 and shared domain types.
- Produces:

```ts
class LocalAiTargetRepository {
  create(config: LocalAiTargetConfig): LocalAiTarget;
  update(targetId: string, patch: LocalAiTargetPatch): LocalAiTarget;
  get(targetId: string): LocalAiTarget | undefined;
  findByEndpoint(identity: LocalAiEndpointIdentity): LocalAiTarget | undefined;
  list(options?: { includeRetired?: boolean }): LocalAiTarget[];
  setLifecycle(targetId: string, lifecycle: 'enrolled' | 'paused' | 'retired', at?: number): LocalAiTarget;
}

class LocalAiHealthRepository {
  appendSample(sample: LocalAiHealthSample): void;
  latestSamples(targetId: string): LocalAiHealthSample[];
  upsertIncident(input: LocalAiIncidentMutation): LocalAiIncident;
  listIncidents(query: LocalAiIncidentQuery): LocalAiIncident[];
  appendRoutingEvent(event: LocalAiRoutingEvent): void;
  updateRoutingEvent(eventId: string, patch: LocalAiRoutingEventPatch): void;
  createFallbackRequest(request: LocalAiFallbackRequest): void;
  resolveFallbackRequest(requestId: string, resolution: LocalAiFallbackResolution): LocalAiFallbackRequest | undefined;
  listPendingFallbackRequests(): LocalAiFallbackRequest[];
  summarize(window: '24h' | '7d' | '30d', now?: number): LocalAiEffectivenessSummary;
  runRetention(now?: number): LocalAiRetentionReport;
}
```

- [x] **Step 1: Write repository round-trip and retention tests**

Cover create/update, duplicate endpoint rejection, pause/resume/retire timestamps, JSON configuration parsing, incident dedupe, pending-request compare-and-set resolution, known-versus-estimated aggregation, 90-day raw retention, and daily aggregate preservation.

- [x] **Step 2: Run the focused tests and verify they fail**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-target-repository.spec.ts src/main/local-ai-guard/local-ai-health-repository.spec.ts
```

Expected: FAIL because repositories do not exist.

- [x] **Step 3: Implement row mappers and repositories**

Use prepared statements, transactions for incident/routing updates, bounded query limits, and strict JSON parsing through the Task 1 schemas. A malformed persisted row must be logged and omitted from list results rather than crashing application startup.

- [x] **Step 4: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-target-repository.spec.ts src/main/local-ai-guard/local-ai-health-repository.spec.ts
```

Expected: PASS.

---

### Task 3: Worker and Coordinator Probe Protocol

**Files:**
- Create: `src/main/local-ai-guard/local-ai-probe-service.ts`
- Create: `src/worker-agent/worker-local-ai-health.ts`
- Modify: `src/main/remote-node/worker-node-rpc.ts`
- Modify: `src/main/remote-node/rpc-schemas.ts`
- Modify: `src/main/remote-node/worker-node-connection-helpers.ts`
- Modify: `src/worker-agent/worker-rpc-dispatcher.ts`
- Test: `src/main/local-ai-guard/local-ai-probe-service.spec.ts`
- Test: `src/worker-agent/worker-local-ai-health.spec.ts`
- Modify test: `src/main/remote-node/__tests__/rpc-schemas.spec.ts`
- Modify test: `src/worker-agent/__tests__/worker-agent.spec.ts`

**Interfaces:**
- Produces worker RPC methods `localAi.health.check`, `localAi.health.diagnose`, and `localAi.health.repair`.
- Produces:

```ts
class LocalAiProbeService {
  check(target: LocalAiTarget, kind: 'lightweight' | 'functional'): Promise<LocalAiProbeResult[]>;
  diagnose(target: LocalAiTarget): Promise<LocalAiDiagnosticReport>;
  repair(target: LocalAiTarget, action: LocalAiRepairAction): Promise<LocalAiRepairResult>;
}
```

- [x] **Step 1: Write failing local and worker probe tests**

Test endpoint metadata, expected-model validation, bounded canary success, missing model, timeout, malformed output, worker disconnect, RPC timeout, response-size rejection, and an unrecognised repair action.

- [x] **Step 2: Run tests and verify failure**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-probe-service.spec.ts src/worker-agent/worker-local-ai-health.spec.ts src/main/remote-node/__tests__/rpc-schemas.spec.ts src/worker-agent/__tests__/worker-agent.spec.ts
```

Expected: FAIL because the RPC methods and probe classes do not exist.

- [x] **Step 3: Add bounded Zod RPC schemas**

`LocalAiHealthCheckParamsSchema` must accept only provider, endpoint ID, expected model records, check kind, a canary contract, latency threshold, and timeout. It must not accept arbitrary prompts or commands. The canary contract is a named built-in contract such as `exact-token-v1`; the worker constructs the fixed prompt internally.

- [x] **Step 4: Implement worker checks**

Reuse worker-local endpoint constants. For Ollama, call `/api/version`, `/api/tags`, and `/api/generate` with a fixed prompt requesting the exact token `AIO_HEALTH_OK`, `stream:false`, bounded `num_predict`, and no user content. Validate exact normalized output and return metadata only.

Implement named repair operations:

- Windows: fixed `taskkill.exe` target for the Ollama app followed by a resolved executable under known Ollama install roots.
- macOS: fixed `osascript` quit for application `Ollama`, followed by `/usr/bin/open -a Ollama`.
- Linux: fixed `systemctl --user restart ollama.service`.

Return `supported:false` rather than executing when the expected installation cannot be resolved.

- [x] **Step 5: Implement coordinator probing**

Coordinator-local checks use the same fixed canary and result shape. Worker checks call `sendServiceRpc` with service scope and bounded timeout. Classification must map fetch/RPC errors to the exact `LocalAiFailureCode`.

- [x] **Step 6: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-probe-service.spec.ts src/worker-agent/worker-local-ai-health.spec.ts src/main/remote-node/__tests__/rpc-schemas.spec.ts src/worker-agent/__tests__/worker-agent.spec.ts
```

Expected: PASS.

---

### Task 4: Pure Health State Engine

**Files:**
- Create: `src/main/local-ai-guard/local-ai-health-engine.ts`
- Test: `src/main/local-ai-guard/local-ai-health-engine.spec.ts`

**Interfaces:**
- Consumes: `LocalAiHealthSample`, target thresholds, and prior status.
- Produces:

```ts
class LocalAiHealthEngine {
  apply(
    target: LocalAiTarget,
    previous: LocalAiTargetStatus | undefined,
    samples: LocalAiProbeResult[],
    now?: number,
  ): LocalAiHealthTransition;
  checking(target: LocalAiTarget, now?: number): LocalAiTargetStatus;
  aggregate(targets: LocalAiTargetStatus[]): LocalAiAggregateStatus;
}
```

- [x] **Step 1: Write a table-driven failing state-machine test**

Cases must cover: zero enrolled targets gives Not configured; first required failure removes only affected roles; two failures degrade; three fail and open; critical failures immediately fail; optional-model failure affects only assigned roles; two successes recover; pause is neutral; flapping quarantines; stale evidence is not healthy.

- [x] **Step 2: Run the focused test**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-health-engine.spec.ts
```

Expected: FAIL because the engine does not exist.

- [x] **Step 3: Implement the pure reducer**

Keep counters and transition evidence in `LocalAiTargetStatus`. Do not read clocks, databases, registries, or settings inside the engine; `now` and every input are passed explicitly.

- [x] **Step 4: Run the focused test**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-health-engine.spec.ts
```

Expected: PASS.

---

### Task 5: Incident Deduplication and Notifications

**Files:**
- Create: `src/main/local-ai-guard/local-ai-incident-service.ts`
- Test: `src/main/local-ai-guard/local-ai-incident-service.spec.ts`
- Modify: `src/shared/types/notification.types.ts`

**Interfaces:**
- Consumes: health transitions, routing events, health repository, and `NotificationService`.
- Produces:

```ts
class LocalAiIncidentService {
  handleTransition(transition: LocalAiHealthTransition): LocalAiIncident | undefined;
  recordFallback(event: LocalAiRoutingEvent): LocalAiIncident | undefined;
  acknowledge(incidentId: string): LocalAiIncident | undefined;
}
```

- [x] **Step 1: Write failing incident tests**

Verify one open incident per target/failure family, repeated failure updates rather than duplicates, paid-fallback-possible notification occurs once, actual paid dispatch is immediate, budget crossing is critical, and recovery closes the incident with duration and impact.

- [x] **Step 2: Run the focused test**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-incident-service.spec.ts
```

Expected: FAIL because the service does not exist.

- [x] **Step 3: Implement transition-driven incidents**

Use stable notification fingerprints containing incident ID and transition kind. Notification bodies must contain endpoint label, failed layer, affected slots, and fallback impact, but no endpoint credentials, prompt text, or model response.

- [x] **Step 4: Run the focused test**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-incident-service.spec.ts
```

Expected: PASS.

---

### Task 6: Recovery Service

**Files:**
- Create: `src/main/local-ai-guard/local-ai-recovery-service.ts`
- Test: `src/main/local-ai-guard/local-ai-recovery-service.spec.ts`

**Interfaces:**
- Consumes: probe service, repositories, and incident service.
- Produces:

```ts
class LocalAiRecoveryService {
  diagnose(targetId: string): Promise<LocalAiDiagnosticReport>;
  repair(targetId: string, action: LocalAiRepairAction, mode: 'guided' | 'automatic'): Promise<LocalAiRepairResult>;
}
```

- [x] **Step 1: Write failing recovery tests**

Cover deep-check classification, automatic-repair disabled, unsupported platform, maximum attempt exhaustion, cooldown enforcement, successful named restart followed by required health checks, and audit evidence without command or secret content.

- [x] **Step 2: Run the focused test**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-recovery-service.spec.ts
```

Expected: FAIL because the service does not exist.

- [x] **Step 3: Implement bounded recovery**

Automatic mode must check target opt-in, `maxAttempts`, and `cooldownMs`. A restart result is not recovery by itself: run a lightweight check and a functional check, then pass both through the health engine. Guided mode returns exact platform steps and supported named actions without running them.

- [x] **Step 4: Run the focused test**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-recovery-service.spec.ts
```

Expected: PASS.

---

### Task 7: Scheduler, Busy Leases, Runtime Startup, and Retention

**Files:**
- Create: `src/main/local-ai-guard/local-ai-activity-registry.ts`
- Create: `src/main/local-ai-guard/local-ai-health-scheduler.ts`
- Create: `src/main/local-ai-guard/local-ai-runtime.ts`
- Create: `src/main/local-ai-guard/index.ts`
- Modify: `src/main/app/initialization-steps.ts`
- Test: `src/main/local-ai-guard/local-ai-health-scheduler.spec.ts`
- Test: `src/main/local-ai-guard/local-ai-runtime.spec.ts`
- Modify test: `src/main/app/initialization-steps.spec.ts`

**Interfaces:**
- Produces:

```ts
class LocalAiActivityRegistry {
  acquire(targetId: string): () => void;
  isBusy(targetId: string): boolean;
}

class LocalAiHealthScheduler {
  start(): void;
  stop(): void;
  recheck(targetId: string, kind: 'lightweight' | 'functional'): Promise<LocalAiTargetStatus>;
  ensureFresh(targetId: string, role: AuxiliaryLlmSlot): Promise<LocalAiTargetStatus>;
}

function initializeLocalAiGuardRuntime(): LocalAiGuardRuntime;
function getLocalAiGuardRuntime(): LocalAiGuardRuntime;
```

- [x] **Step 1: Write fake-timer scheduler tests**

Verify enrolled-only scheduling, pause/retire cancellation, defaults, target overrides, functional deferral while busy, single flight, manual bypass of backoff, jittered exponential backoff capped at 15 minutes, reconnect freshness check, shutdown cancellation, and one daily retention pass.

- [x] **Step 2: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-health-scheduler.spec.ts src/main/local-ai-guard/local-ai-runtime.spec.ts src/main/app/initialization-steps.spec.ts
```

Expected: FAIL because scheduler/runtime do not exist.

- [x] **Step 3: Implement activity leases and scheduler**

Every timer callback must be fail-soft and use injected clock/random/timer ports in tests. `recheck()` shares the per-target/check promise instead of issuing a second probe.

- [x] **Step 4: Wire startup and disposal**

Add a fail-soft `Local AI Guard` initialization step after Auxiliary LLM configuration and before IPC handlers. Register scheduler disposal through the cleanup registry. Subscribe to worker roster/capability changes and target lifecycle changes; do not poll unmanaged discoveries.

- [x] **Step 5: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-health-scheduler.spec.ts src/main/local-ai-guard/local-ai-runtime.spec.ts src/main/app/initialization-steps.spec.ts
```

Expected: PASS.

---

### Task 8: Routing Guard, Pending Approvals, and Budgets

**Files:**
- Create: `src/main/local-ai-guard/local-ai-fallback-approval-service.ts`
- Create: `src/main/local-ai-guard/local-ai-routing-guard.ts`
- Modify: `src/shared/types/settings.types.ts`
- Modify: `src/shared/types/settings-defaults.ts`
- Modify: `src/shared/types/settings-metadata-runtime.ts`
- Modify: `src/main/core/config/settings-control-policy.ts`
- Test: `src/main/local-ai-guard/local-ai-fallback-approval-service.spec.ts`
- Test: `src/main/local-ai-guard/local-ai-routing-guard.spec.ts`
- Modify test: `src/shared/types/settings-defaults.spec.ts`

**Interfaces:**
- Produces:

```ts
class LocalAiRoutingGuard {
  evaluateLocalTarget(input: {
    targetId: string;
    slot: AuxiliaryLlmSlot;
  }): Promise<LocalAiLocalRouteVerdict>;
  authorizeFallback(input: {
    slot: AuxiliaryLlmSlot;
    intendedTargetId?: string;
    reason: string;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    slotAllowsFrontier: boolean;
  }): Promise<LocalAiFallbackVerdict>;
  markFallbackDispatched(eventId: string): void;
}

class LocalAiFallbackApprovalService {
  request(input: LocalAiFallbackRequestInput): Promise<LocalAiFallbackResolution>;
  listPending(): LocalAiFallbackRequest[];
  resolve(requestId: string, decision: 'allow-once' | 'allow-incident' | 'defer' | 'block'): LocalAiFallbackRequest;
}
```

- [x] **Step 1: Write failing policy tests**

Cover global default, per-slot override, unmanaged compatibility path, immediate unhealthy rejection, pre-route freshness, allow, notify, confirmation, defer, block, token threshold upgrade, daily budget upgrade, incident ceiling, single resolution, timeout/expiry, and restart sweep of orphaned pending requests.

- [x] **Step 2: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-fallback-approval-service.spec.ts src/main/local-ai-guard/local-ai-routing-guard.spec.ts
```

Expected: FAIL because routing and approval services do not exist.

- [x] **Step 3: Implement policy precedence and conservative reservations**

Add global settings `localAiGuardDefaultFallbackPolicy` (default `notify-and-allow`), `localAiGuardDailyFallbackBudgetUsd` (default `null`), and `localAiGuardConfirmAboveInputTokens` (default `null`) with metadata and control-policy validation. Policy order is hard budget block, incident ceiling block, target token threshold, global token threshold, target per-slot policy, target policy, then global default. Estimated spend uses the existing model-pricing catalogue when provider/model are known. An unknown estimate cannot bypass a configured hard ceiling.

- [x] **Step 4: Implement durable pending requests**

Persist before notifying. Awaiters resolve only through an atomic pending-to-resolved update. Expired or restart-orphaned requests resolve to block/defer, never allow.

- [x] **Step 5: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-fallback-approval-service.spec.ts src/main/local-ai-guard/local-ai-routing-guard.spec.ts
```

Expected: PASS.

---

### Task 9: Auxiliary Routing and Cost-Correlation Integration

**Files:**
- Create: `src/main/local-ai-guard/local-ai-cost-correlation.ts`
- Modify: `src/main/rlm/auxiliary-llm-service.ts`
- Modify: `src/main/core/system/cost-attribution.ts`
- Modify: `src/shared/types/auxiliary-llm.types.ts`
- Modify fallback callers:
  - `src/main/rlm/llm-service.ts`
  - `src/main/rlm/hyde-service.ts`
  - `src/main/context/context-compactor.ts`
  - `src/main/memory/unified-controller.ts`
  - `src/main/orchestration/loop-review-lesson-capture-wiring.ts`
  - `src/main/orchestration/loop-clean-review-classifier.ts`
  - `src/main/instance/auto-title-service.ts`
- Modify test: `src/main/rlm/__tests__/auxiliary-llm-service.spec.ts`
- Modify test: `src/main/core/system/cost-attribution.spec.ts`
- Create test: `src/main/local-ai-guard/local-ai-auxiliary-integration.spec.ts`

**Interfaces:**
- Extends `AuxiliaryLlmDecision` with optional `localAiRoutingEventId`, `intendedTargetId`, and `fallbackDisposition`.
- Produces:

```ts
function withLocalAiCostCorrelation<T>(
  routingEventId: string,
  run: () => Promise<T>,
): Promise<T>;

function runAuthorizedFrontierFallback<T>(
  decision: AuxiliaryLlmDecision,
  run: () => Promise<T>,
): Promise<T>;

function subscribeCostAttribution(
  listener: (record: CostAttributionRecord) => void,
): () => void;
```

- [x] **Step 1: Write failing integration tests**

Verify an enrolled healthy endpoint is checked and leased during generation; a failed local call invalidates routing; notify-and-allow creates an event; confirmation blocks the caller until resolved; defer/block set `allowFrontierFallback:false`; paid dispatch is marked; cost attribution inherits the routing correlation ID; local success records estimated local tokens without dollar cost.

- [x] **Step 2: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-auxiliary-integration.spec.ts src/main/rlm/__tests__/auxiliary-llm-service.spec.ts src/main/core/system/cost-attribution.spec.ts
```

Expected: FAIL because guard/correlation integration does not exist.

- [x] **Step 3: Integrate enrolled target resolution**

Map auxiliary endpoint identities to enrolled targets through `LocalAiTargetRepository.findByEndpoint`. Unmanaged endpoints retain existing routing behaviour and never create a false unhealthy target. Enrolled endpoints require a current eligible verdict.

- [x] **Step 4: Make fallback construction asynchronous**

`buildFallback()` must call `authorizeFallback()` before returning. Preserve the current deterministic fallback text. Set `allowFrontierFallback` from both the slot flag and guard verdict.

- [x] **Step 5: Add AsyncLocalStorage correlation**

When existing `recordCostAttribution()` receives no explicit `correlationId`, fill it from the Local AI Guard async context. Notify in-process attribution listeners before the optional JSONL sink gate, so `AIO_COST_ATTRIBUTION=0` disables only JSONL and cannot disable Local AI Guard history. Remove early sink-gate returns from the convenience wrappers and let `recordCostAttribution()` decide whether to append the file after notifying listeners. The Local AI runtime subscribes and updates the matching routing event's provider/model, normalized token counts, `knownCostUsd`, or `estimatedCostUsd`.

`runAuthorizedFrontierFallback()` marks dispatch and wraps the frontier call. Update each fallback-capable caller listed above to use the wrapper.

- [x] **Step 6: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-auxiliary-integration.spec.ts src/main/rlm/__tests__/auxiliary-llm-service.spec.ts src/main/core/system/cost-attribution.spec.ts
```

Expected: PASS.

---

### Task 10: IPC, Preload, and Renderer Service

**Files:**
- Create: `packages/contracts/src/channels/local-ai-guard.channels.ts`
- Modify: `packages/contracts/src/channels/index.ts`
- Modify: `src/preload/generated/channels.ts` via `npm run generate:ipc`
- Create: `src/preload/domains/local-ai-guard.preload.ts`
- Modify: `src/preload/preload.ts`
- Create: `src/main/ipc/handlers/local-ai-guard-handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Create: `src/renderer/app/core/services/ipc/local-ai-guard-ipc.service.ts`
- Modify: `src/renderer/app/core/services/ipc/index.ts`
- Test: `packages/contracts/src/channels/__tests__/local-ai-guard.channels.spec.ts`
- Test: `src/preload/__tests__/local-ai-guard-domain.spec.ts`
- Test: `src/main/ipc/handlers/local-ai-guard-handlers.spec.ts`

**Interfaces:**
- Channels cover snapshot, target create/update/lifecycle, discover, validate, recheck, incident acknowledge, diagnose, repair, summary query, pending fallback list/resolve, and status delta.

- [x] **Step 1: Write failing channel, preload, and handler tests**

Assert exact channel strings, trusted/validated mutation payloads, bounded query windows, delta cleanup, and error envelopes.

- [x] **Step 2: Run focused tests**

```bash
npm run test:quiet -- packages/contracts/src/channels/__tests__/local-ai-guard.channels.spec.ts src/preload/__tests__/local-ai-guard-domain.spec.ts src/main/ipc/handlers/local-ai-guard-handlers.spec.ts
```

Expected: FAIL because the domain is not exposed.

- [x] **Step 3: Implement channels, generate preload constants, and add preload domain**

Run:

```bash
npm run generate:ipc
```

Do not hand-edit generated channel values.

- [x] **Step 4: Implement validated main handlers and delta bridge**

Mutations must use Zod schemas and trusted-sender checks. The status delta must carry the bounded `LocalAiGuardSnapshot`, not raw database rows.

- [x] **Step 5: Implement renderer IPC service**

Return typed `IpcResponse<T>` values and unsubscribe functions for delta listeners.

- [x] **Step 6: Run focused tests**

```bash
npm run test:quiet -- packages/contracts/src/channels/__tests__/local-ai-guard.channels.spec.ts src/preload/__tests__/local-ai-guard-domain.spec.ts src/main/ipc/handlers/local-ai-guard-handlers.spec.ts
```

Expected: PASS.

---

### Task 11: Renderer Store, Title Status, and Fallback Banner

**Files:**
- Create: `src/renderer/app/core/state/local-ai-guard.store.ts`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-status-chip.component.ts`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.ts`
- Modify: `src/renderer/app/app.component.ts`
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.scss`
- Test: `src/renderer/app/core/state/local-ai-guard.store.spec.ts`
- Test: `src/renderer/app/features/local-ai-guard/local-ai-status-chip.component.spec.ts`
- Test: `src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.spec.ts`
- Modify test: `src/renderer/app/app.component.spec.ts`

**Interfaces:**
- Store exposes `snapshot`, `aggregate`, `targets`, `activeIncidents`, `pendingFallbacks`, `isInitialized`, `error`, `initialize()`, `refresh()`, `resolveFallback()`, and `destroy()`.

- [x] **Step 1: Write failing signal-store and component tests**

Cover initial snapshot before delta subscription, Not configured, every aggregate state, accessible labels, navigation to `/local-ai`, one oldest pending request, allow once, allow incident, defer, block, error recovery, and no repeated live-region announcement for an unchanged state.

- [x] **Step 2: Run focused tests**

```bash
npm run test:quiet -- src/renderer/app/core/state/local-ai-guard.store.spec.ts src/renderer/app/features/local-ai-guard/local-ai-status-chip.component.spec.ts src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.spec.ts src/renderer/app/app.component.spec.ts
```

Expected: FAIL because renderer state and shell components do not exist.

- [x] **Step 3: Implement store and title chip**

Initialize once from `AppComponent`. The chip must always show after initialization, including Not configured, and navigate to the health centre.

- [x] **Step 4: Implement fallback action banner**

Mount the banner at root level near other approval banners. Disable buttons while resolving, keep focus predictable, expose the token/cost estimate and affected slot, and announce only meaningful state changes through `aria-live="polite"`.

- [x] **Step 5: Run focused tests**

```bash
npm run test:quiet -- src/renderer/app/core/state/local-ai-guard.store.spec.ts src/renderer/app/features/local-ai-guard/local-ai-status-chip.component.spec.ts src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.spec.ts src/renderer/app/app.component.spec.ts
```

Expected: PASS.

---

### Task 12: Health Centre, Enrolment, Target Management, and Recovery UI

**Files:**
- Create: `src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.ts`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.html`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.scss`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-target-card.component.ts`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-target-setup.component.ts`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-target-setup.component.html`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-target-setup.component.scss`
- Create: `src/renderer/app/features/local-ai-guard/local-ai-incident-panel.component.ts`
- Modify: `src/renderer/app/app.routes.ts`
- Modify: `src/renderer/app/shared/control-surface/control-surface.types.ts`
- Modify: `src/renderer/app/shared/control-surface/control-surface.registry.ts`
- Modify: `src/renderer/app/shared/control-surface/control-surface-icons.ts`
- Test: `src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.spec.ts`
- Test: `src/renderer/app/features/local-ai-guard/local-ai-target-setup.component.spec.ts`
- Test: `src/renderer/app/features/local-ai-guard/local-ai-incident-panel.component.spec.ts`
- Modify test: `src/renderer/app/app.routes.spec.ts`
- Modify test: `src/renderer/app/shared/control-surface/control-surface.registry.spec.ts`

**Interfaces:**
- Adds `ControlSurfaceId` value `local-ai`, route `/local-ai`, Monitoring group entry, and dashboard navigation.

- [x] **Step 1: Write failing route and UI tests**

Cover discovered-but-unmanaged neutrality, one-time validation, expected-model and canary selection, safe interval bounds, enrol, edit, pause, timed pause, resume, retire confirmation, layer evidence, configuration drift, manual check, incident acknowledge, diagnose, guided recovery, opt-in automatic repair, and keyboard/focus behaviour.

- [x] **Step 2: Run focused tests**

```bash
npm run test:quiet -- src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.spec.ts src/renderer/app/features/local-ai-guard/local-ai-target-setup.component.spec.ts src/renderer/app/features/local-ai-guard/local-ai-incident-panel.component.spec.ts src/renderer/app/app.routes.spec.ts src/renderer/app/shared/control-surface/control-surface.registry.spec.ts
```

Expected: FAIL because the health centre does not exist.

- [x] **Step 3: Implement route and control-surface entry**

Use lazy component loading and the existing Control Center shell.

- [x] **Step 4: Implement setup and lifecycle controls**

Discovery is read-only until the operator submits enrolment. Validation result must show worker, endpoint, model, and canary layers separately. Pause and retirement stop active polling through main-process lifecycle state, not renderer-only hiding.

- [x] **Step 5: Implement target cards and incident recovery**

Show evidence age, last success, last failure, current routing roles, advertised/expected model differences, recovery attempts, fallback impact, and named safe actions.

- [x] **Step 6: Run focused tests**

```bash
npm run test:quiet -- src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.spec.ts src/renderer/app/features/local-ai-guard/local-ai-target-setup.component.spec.ts src/renderer/app/features/local-ai-guard/local-ai-incident-panel.component.spec.ts src/renderer/app/app.routes.spec.ts src/renderer/app/shared/control-surface/control-surface.registry.spec.ts
```

Expected: PASS.

---

### Task 13: Effectiveness Dashboard and Historical Aggregation

**Files:**
- Create: `src/renderer/app/features/local-ai-guard/local-ai-effectiveness-panel.component.ts`
- Test: `src/renderer/app/features/local-ai-guard/local-ai-effectiveness-panel.component.spec.ts`
- Modify: `src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.ts`
- Modify: `src/renderer/app/features/local-ai-guard/local-ai-guard-page.component.html`
- Modify: `src/main/local-ai-guard/local-ai-health-repository.ts`
- Modify test: `src/main/local-ai-guard/local-ai-health-repository.spec.ts`

**Interfaces:**
- Consumes `LocalAiEffectivenessSummary` for `24h`, `7d`, and `30d`.

- [x] **Step 1: Write failing aggregation and rendering tests**

Verify local completion rate, local tasks/tokens, proposed/allowed/deferred/blocked fallbacks, known cost, estimated cost, avoided-token estimate, endpoint/model/slot/incident breakdowns, empty state, and accessible text equivalents for every visual.

- [x] **Step 2: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-health-repository.spec.ts src/renderer/app/features/local-ai-guard/local-ai-effectiveness-panel.component.spec.ts
```

Expected: FAIL because complete summaries and panel do not exist.

- [x] **Step 3: Implement daily aggregation and queries**

Build idempotent daily upserts from routing events before pruning raw data. Keep `knownCostUsd`, `estimatedCostUsd`, and `avoidedEstimatedCostUsd` separate through SQL, DTOs, and labels.

- [x] **Step 4: Implement dashboard panel**

Use existing design tokens and lightweight CSS/SVG bars with visible text values; do not add a chart dependency. Filters update the query window and breakdown without discarding current target/incident state.

- [x] **Step 5: Run focused tests**

```bash
npm run test:quiet -- src/main/local-ai-guard/local-ai-health-repository.spec.ts src/renderer/app/features/local-ai-guard/local-ai-effectiveness-panel.component.spec.ts
```

Expected: PASS.

---

### Task 14: End-to-End Wiring, Runtime Verification, and Documentation Closure

**Files:**
- Create: `src/main/local-ai-guard/local-ai-guard.integration.spec.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-25-local-ai-guard_spec_completed.md`
- Modify: `docs/superpowers/plans/2026-07-26-local-ai-guard_plan_completed.md`
- Create if required: `docs/superpowers/plans/2026-07-26-local-ai-guard_plan_livetest.md`

**Interfaces:**
- Validates the complete coordinator → worker/probe → health → routing → incident → IPC path.

- [x] **Step 1: Write end-to-end integration tests**

Cover:

1. paired worker without enrolment produces no polling or incident;
2. enrolment validates and starts checks;
3. worker stays connected while Ollama fails;
4. failed endpoint leaves routing immediately;
5. notification-and-allow records fallback;
6. confirmation waits and resolves;
7. budget blocks dispatch;
8. recovery requires two successes;
9. restart reconstructs targets/open incidents but rechecks before routing;
10. retention preserves daily history.

- [x] **Step 2: Run the complete Local AI Guard focused suite**

```bash
npm run test:quiet -- src/main/local-ai-guard src/worker-agent/worker-local-ai-health.spec.ts src/renderer/app/features/local-ai-guard src/renderer/app/core/state/local-ai-guard.store.spec.ts src/main/ipc/handlers/local-ai-guard-handlers.spec.ts src/preload/__tests__/local-ai-guard-domain.spec.ts
```

Expected: PASS.

- [x] **Step 3: Run type checks before broad verification**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both PASS.

- [x] **Step 4: Run the canonical project gates**

```bash
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Expected: all PASS.

- [x] **Step 5: Perform real runtime checks where available**

The six checks requiring a rebuilt renderer, real local/provider processes, app restart, or an external disposable worker remain in [the active live-test plan](./2026-07-26-local-ai-guard_plan_livetest.md).

- [x] **Step 6: Run the independent completion gate**

Start a genuinely fresh agent context and require the `task-completion-gate` skill to review the merge-base-to-HEAD diff plus staged, unstaged, and relevant untracked implementation files, along with the specification, architecture, tests, security, async/state handling, performance, accessibility, migrations, and runtime wiring.

Expected: `VERDICT: PASS` with no actionable findings. Fix every finding, rerun affected checks, and repeat with another fresh reviewer until PASS.

- [x] **Step 7: Close documentation only after the gate passes**

Update the spec and plan with as-built notes and verification evidence. Update the spec link to the completed plan filename. Rename:

- `2026-07-26-local-ai-guard_plan.md` → `2026-07-26-local-ai-guard_plan_completed.md`
- `2026-07-25-local-ai-guard_spec_planned.md` → `2026-07-25-local-ai-guard_spec_completed.md`

Verify no active Local AI Guard plan/spec remains and report any pending `_livetest.md` separately.

## Completion and As-Built Record

All fourteen implementation tasks and their agent-runnable acceptance criteria are
implemented. The as-built subsystem uses explicit enrolment, bounded worker RPC,
layered health evidence, conservative role-scoped routing, durable incidents and
fallback decisions, restart-safe SQLite reconstruction, and bounded renderer IPC.
Provider context minima are checked after a functional canary can load the model;
present invalid metadata fails closed, and duplicate capacity rows use the lowest
reported value independent of order.

Canonical verification on 2026-07-30 passed both TypeScript checks, lint, the
TypeScript LOC ratchet, main/worker/renderer builds, IPC/contracts/boundaries/exports,
dependency audits, and the plan-prescribed Local AI suite (27 files, 474 tests). The
implementer's uncached full suite passed 1,638 files / 16,704 tests with one existing
skip in 490.02 seconds. A genuinely fresh Round 4 completion reviewer independently
reproduced 30 provider/parser permutations plus both quarantine paths, reran the
focused and canonical gates, and passed its own cold full suite (1,638 files / 16,704
tests, one skip, 544.5 seconds), returning `VERDICT: PASS` with no findings.

The six remaining checks are deliberately not claimed as executed. Their exact
prerequisites, actions, and expected observations remain in
[the live-test plan](./2026-07-26-local-ai-guard_plan_livetest.md).
