# RLM Storage Maintenance Implementation Plan

> **For agentic workers:** Execute inline in this session. Repository policy forbids commits unless James explicitly asks, so the commit steps from the generic planning workflow are intentionally omitted.

**Goal:** Add operator-driven, backup-first stale RLM session pruning with compaction, loop coordination, validated IPC, and complete loop-HUD feedback.

**Architecture:** A focused main-process service owns health, preview, single-flight execution, verified backup, transactional database pruning, external content cleanup, compaction, reload, and factual result reporting. The existing loop coordinator receives a read-only maintenance gate at its pre-iteration boundary. Memory-domain IPC and a signal-based Angular store/component expose the workflow without renderer-controlled retention settings.

**Tech Stack:** TypeScript, Electron IPC, better-sqlite3 through `SqliteDriver`, Zod 4 contracts, Angular 21 signals/standalone components, Vitest.

## Global Constraints

- Warning threshold is exactly `10 * 1024 * 1024 * 1024` bytes.
- Hard pause threshold is exactly `12 * 1024 * 1024 * 1024` bytes.
- Retention is fixed at 60 calendar days and is not renderer-controlled.
- Protect every session ID represented by a currently known live `InstanceManager` record.
- Protect every store whose `config_json.kind` is `codebase-auto`.
- A verified database and external-content backup must exist before deletion begins.
- The preview never authorizes deletion; candidates are recomputed at execution time.
- No threshold bypass is permitted when attempting loop resume.
- Preserve all unrelated dirty-worktree changes.

---

### Task 1: Shared contracts and storage inspection

**Files:**
- Create: `src/shared/types/rlm-maintenance.types.ts`
- Create: `packages/contracts/src/schemas/rlm-maintenance.schemas.ts`
- Modify: `packages/contracts/src/channels/memory.channels.ts`
- Modify: contract export/alias configuration required for the new schema subpath

**Interfaces:**
- Produces health, preview, progress, running, success, and staged-failure result types.
- Produces `RlmMaintenanceRequestSchema = z.object({ loopRunId: z.string().min(1).optional() }).strict()` and an empty strict request schema for health.

- [x] Write schema/channel identity tests that reject blank loop IDs and malformed fields.
- [x] Run the focused tests and verify the new channels/schema are absent or rejected.
- [x] Add the exact shared types, schema, channels, and generated/runtime aliases.
- [x] Regenerate preload channel constants and rerun the focused tests.

### Task 2: Backup-first maintenance service and real SQLite coverage

**Files:**
- Create: `src/main/rlm/rlm-storage-maintenance.ts`
- Create: `src/main/rlm/rlm-storage-maintenance.spec.ts`
- Create: `src/main/rlm/rlm-storage-maintenance.integration.spec.ts`
- Modify only if needed: `src/main/persistence/rlm-database.ts`

**Interfaces:**
- `getHealth(): RlmStorageHealth`
- `preview(request): RlmMaintenancePreview`
- `run(request): Promise<RlmMaintenanceResult>`
- `isRunning(): boolean`
- progress via `EventEmitter` event `progress`

- [x] Write failing unit tests for thresholds, exact-cutoff eligibility, recent/live/codebase protection, stale persisted sessions, preview recomputation, backup failure, single flight, and stage-specific gate release.
- [x] Write native SQLite tests for cascades, a valid database/content backup, external-file selectivity, `VACUUM`, and measured sizes. Rebuilt-app observation remains in [the live-test plan](./2026-07-11-rlm-storage-maintenance-plan_livetest.md).
- [x] Implement candidate queries, freelist inspection, backup naming/verification, transactional deletion, external cleanup, checkpoint/`VACUUM`, context reload, logging, shutdown checks, and exact results.
- [x] Run both focused specs until green.

### Task 3: Loop maintenance gate and healthy-only resume

**Files:**
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Create: `src/main/orchestration/loop-coordinator-maintenance.spec.ts`
- Modify: `src/main/app/initialization-steps.ts`

**Interfaces:**
- `setMaintenanceGate(gate: (() => boolean) | null): void`
- The service receives loop lookup/resume dependencies and resumes only when its final health is below the hard threshold.

- [x] Write failing tests that maintenance prevents the next child invocation and release allows progress.
- [x] Write service tests that a paused initiating loop resumes only below 12 GiB and remains blocked at/above it.
- [x] Add the gate at the existing resource-governor pre-iteration boundary and wire the singleton service with live protected IDs.
- [x] Run the focused loop/service tests.

### Task 4: Validated IPC, preload, and renderer store

**Files:**
- Create: `src/main/ipc/handlers/rlm-maintenance-handlers.ts`
- Create: `src/main/ipc/handlers/rlm-maintenance-handlers.spec.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Modify: `src/preload/domains/memory.preload.ts`
- Create: `src/renderer/app/core/state/rlm-storage-maintenance.store.ts`
- Create: `src/renderer/app/core/state/rlm-storage-maintenance.store.spec.ts`

**Interfaces:**
- Preload methods: health, preview, start/status, and progress subscription with unsubscribe.
- Store signals: health, preview, progress, result, busy, visible, modal open, and renderer-session dismissal.

- [x] Write failing handler tests for validation, registration, typed errors, and progress forwarding.
- [x] Write failing store tests for initial/refresh health, session dismissal, preview/run/retry, single-click protection, progress, and cleanup.
- [x] Implement handlers, forwarding, preload types, and the signal store.
- [x] Run focused IPC/preload/store tests.

### Task 5: Loop-HUD warning, preview modal, progress, and result UI

**Files:**
- Create: `src/renderer/app/features/loop/rlm-storage-maintenance.component.ts`
- Create: `src/renderer/app/features/loop/rlm-storage-maintenance.component.spec.ts`
- Modify: `src/renderer/app/features/loop/loop-control.component.ts`
- Modify: `src/renderer/app/features/loop/loop-control.component.scss`

**Interfaces:**
- Component input: `loopRunId`.
- The component renders warning at exactly 10 GiB, a keyboard-accessible confirmation modal, non-dismissible progress, verified success, staged failures, cleanup warnings, retry, backup location, and loop-resume outcome.

- [x] Write failing component tests for threshold visibility, renderer-only dismissal, preview fields/action eligibility, progress, repeated-click suppression, success, partial cleanup, failure/retry, and at/above-12-GiB messaging.
- [x] Implement the standalone OnPush component with signals, modern control flow, existing design tokens, responsive layout, focus-visible states, and reduced-motion-safe progress.
- [x] Mount it in the active loop HUD and refresh health when loop state changes.
- [x] Run focused renderer and existing loop-control tests.

### Task 6: Verification and completion artifacts

**Files:**
- Rename after automated checks: this plan to `_completed.md`.
- Create if live UI cannot be exercised safely: `docs/superpowers/plans/2026-07-11-rlm-storage-maintenance-plan_livetest.md`.

- [x] Run all targeted specs.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`. Passed 2026-07-12 — the unrelated `src/main/rlm/auxiliary-llm-service.ts` blocker was brought back under the 700-line limit (now 670 lines).
- [x] Run `npm run test:quiet`.
- [x] Inspect the complete feature diff for unrelated changes, secret/path leakage, generated-file consistency, and every design requirement.
- [x] Rename this plan `_completed.md` last. The live checks are recorded in [the live-test plan](./2026-07-11-rlm-storage-maintenance-plan_livetest.md); every agent-runnable canonical gate passed on 2026-07-12 (tsc root/spec/electron, lint, ts-max-loc, full default Vitest suite — 1313/1313 files). The warning-dismissal rule was also hardened during final verification: critical storage health can no longer be hidden by a warning-tier dismissal (`rlm-storage-maintenance.store.ts`, covered by its spec).
