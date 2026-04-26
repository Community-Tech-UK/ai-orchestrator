# Automations — Design Spec

**Date:** 2026-04-26
**Status:** Spec — pending implementation
**Owner:** james@shutupandshave.com

## 1. Overview

Automations are saved, scheduled prompts (or saved Workflow runs) that fire at user-configured times and spawn fresh AI instances to do the work. The user-facing model mirrors ChatGPT's "Tasks" feature: a named prompt + a recurrence + a target — the system does the rest.

The route `/automations` already exists in the renderer as a "coming-soon" placeholder (`src/renderer/app/app.routes.ts:46`) and the sidebar already links to it (`src/renderer/app/features/dashboard/sidebar-actions.component.ts:25-37`). This spec defines the implementation that replaces the placeholder.

### Problem this solves

Users have recurring agent work (server-log reviews, daily summaries, dependency audits, scheduled refactor passes). Today every run requires manually opening the app, typing the prompt, picking the project. Automations remove that friction and let runs happen on schedule.

### Single-line definition

> An automation is a saved `(prompt | workflow)` + `(schedule)` + `(provider/model/agent/yolo config)` + `(working directory)` that fires by itself, spawns a fresh instance per fire, and surfaces results in the normal session list.

## 2. Goals & non-goals

### Goals (MVP)

- Schedule a prompt on a recurrence (preset or cron). (Workflow chaining moves to Phase 2 — see Decision log Q1 update.)
- Fire on schedule, even after suspend/resume cycles, with explicit per-automation policy for runs missed while the app was off
- Produce one normal session per fire, in the working directory configured for the automation
- Distinguish automation-spawned sessions visually with a clock icon (blue when unread, gray when seen)
- Pause / resume / edit / delete / Run-now controls on each automation
- Per-automation history of past runs with status, error messages, and links to spawned sessions

### Non-goals (deliberately out of MVP)

- **Always-on background daemon** that runs while the app is closed (Phase 2)
- **Desktop OS notifications** on completion (Phase 2 — for MVP, in-app sidebar badge only)
- **Auto-retry on failure** (Phase 2)
- **Event triggers** (file changed, branch updated, message received) — schedule-only for MVP
- **Webhook / inbound HTTP triggers** (Phase 3+)
- **Cross-automation dependencies** ("fire X only after Y succeeds")
- **First-class Project entity** — "project" in this feature means "working directory"
- **Workflow action** (`actionType='workflow'`) — descoped from MVP to Phase 2 alongside its prerequisites (workflow template authoring + gated workflow support). MVP supports `actionType='prompt'` only. See revision history v7.
- **Action-handler registry** — MVP has only one action kind (`prompt`); `switch (actionType)` is a single arm. Phase 2 adds `'workflow'` and revisits whether to upgrade to a registry pattern.

## 3. Decision log

These are the decisions taken during brainstorming, recorded so the spec can stand alone.

| # | Question | Decision |
|---|---|---|
| Q1 | Trigger model — ChatGPT-style only, or include workflow chaining, or full event engine? | Originally **B** (mirror ChatGPT shape with `actionType` of `prompt` or `workflow`). **Updated v7 → MVP supports `prompt` only**; workflow action descoped to Phase 2 alongside its prerequisites (template authoring + gated-workflow support). Schema and IPC keep the discriminated-union shape so Phase 2 is purely additive. See revision history v7. |
| Q2 | Schedule semantics — preset only, preset + cron, or full RRULE? | **Preset picker + advanced cron mode**, backed by `croner` |
| Q3 | What to do when the app was off at fire time? | **Per-automation `missed_run_policy`** with global default — values: `runOnce` / `skip` / `notify` |
| Q4 | What is "Project" in the screenshot? | **Working directory only** — no new entity. Spawned instances become normal sessions in that folder, marked with a clock icon |
| Q5 | Per-automation execution config | **Full new-session-composer parity** — provider, model, agent, yolo, plus provider-specific reasoning effort |
| Q6a | Overlap when previous run still running | **Queue with max 1 pending** — running + at most one queued; further fires `skipped` |
| Q6b | Failure handling | **Mark `failed` in history, no auto-retry** |
| Q6c | Completion notification | **In-app sidebar badge + blue clock icon** for unread automation-spawned sessions; no desktop OS notifications in MVP |
| Architecture | One-shot domain or extensible registry? | **Approach 1**: new `src/main/automations/` domain with a fixed action `switch`. Registry deferred. |

### External review (Codex)

Codex reviewed the initial schema and identified seven issues, all accepted into the spec:

1. `Instance.metadata` is not durable (verified: `buildInstanceRecord` never reads `config.metadata`; `instanceToState` doesn't persist `instance.metadata`). Use `automation_runs.instance_id` as the only canonical FK; metadata is dropped from the design.
2. Add partial unique indexes on `automation_runs` to enforce overlap policy at the DB level.
3. Drop denormalized `unseen_run_count`; compute from runs (cheap with retention).
4. Make `cron_expression` nullable for `oneTime` schedules.
5. Add `completed` parent status for one-time automations after fire.
6. Move attachments out of inline JSON into a separate `automation_attachments` table backed by the existing content store.
7. Startup reconciliation for stale `pending`/`running` rows after crash.

Two additional adjustments from Section 7 review:

- **Workflow-template deletion guard** — block deletion when an automation references it; require the user to edit those automations first.
- **Clock-backward dedupe** — refuse to fire when `scheduledAt <= last_fired_at`; insert a `skipped` row with `skip_reason='duplicate'`.

(Copilot was asked to review in parallel and was unavailable both times — its CLI hung during initialization. Decision was made to proceed on Codex's review alone.)

## 4. Architecture

### Domain layout

```
src/main/automations/
├── automation-store.ts          # SQLite CRUD, retention, transactional overlap-decision
├── automation-scheduler.ts      # croner schedules, in-memory map, persistence sync, suspend/resume
├── automation-runner.ts         # fire path, action dispatch, run-state lifecycle
├── catch-up-coordinator.ts      # startup + resume sweeps, missed-run policy engine
├── automation-events.ts         # EventEmitter for IPC fan-out
└── index.ts                     # singleton wiring
```

### Domain boundaries

| Module | Owns | Doesn't own |
|---|---|---|
| Store | Persistence, partial-index enforcement, retention | Time, business decisions |
| Scheduler | Translation of payload → cron → live timer | Spawning, overlap policy |
| Runner | Spawn flow, overlap decision, queue promotion, completion detection | Schedule arming, missed-run logic |
| Catch-up | Reconciliation of stale rows, missed-fire computation, policy application | In-memory state, fresh schedules |

This narrow per-module ownership is what keeps the test surface small (Section 12).

### Dependencies

- **`croner`** (~10 KB, no deps, DST-correct, computes next-fire without polling) — added to `package.json`
- **`better-sqlite3`** (already in project) — for the new tables
- **Existing modules** — `InstanceManager` (event source AND lifecycle wrapper — subscribed for run completion via `instance:event` / `provider:normalized-event` / `instance:removed`; `createInstance` / `terminateInstance` for spawn/cleanup), `ContentStore` (`src/main/session/content-store.ts` — used for attachment binary storage), `SettingsStore` (extended with one new key, see Section 9)

`automation-events.ts` is the domain's internal `EventEmitter`. It's wired both internally (e.g., scheduler listens for `automation:run-terminal` to handle `oneTime` completion) and externally — the IPC layer subscribes and fans the events out to the renderer per Section 9.

### Cross-domain wiring at startup

The MVP automations domain has no cross-domain registrations beyond the standard event subscriptions on `InstanceManager`. (Phase 2's workflow action will register a deletion-reference probe with `WorkflowManager` — see Section 11.3 #12 for the eventual design and Section 13 Phase 2 list.)

### Startup wiring (in `src/main/app/initialization-steps.ts`)

The actual app bootstrap is `createInitializationSteps()` in `src/main/app/initialization-steps.ts`, returning an ordered array of `AppInitializationStep` objects. The implementation plan inserts new steps in this array — **not** in `src/main/index.ts`.

Crucially, **IPC handlers register first** in the existing flow (`initialization-steps.ts:85-92`) so they're ready before any other subsystem can want to dispatch through them. Our wiring must respect this:

```
existing step:        'IPC handlers'                  ← IpcMainHandler.registerHandlers()
                                                         (automation-handlers added to the registration set)
existing step:        'Runtime diagnostics'
existing step:        'Hook approvals'
existing step:        'Remote observer'
existing step:        'Event forwarding'              ← InstanceManager event routing wired
…
NEW step:             'Automations: store + attachment service'
                          AutomationStore.init()       (schema migration runs)
                          AutomationAttachmentService.init()
NEW step:             'Automations: runner'
                          AutomationRunner.initialize(deps)
                          (subscribes to InstanceManager events:
                           instance:event, provider:normalized-event, instance:removed)
NEW step:             'Automations: catch-up sweep'
                          CatchUpCoordinator.runStartupSweep()    (Steps A/B/C)
NEW step:             'Automations: scheduler'
                          AutomationScheduler.initialize(deps)    (loads active rows, arms schedules)
```

Catch-up runs **before** the scheduler activates so missed-run policy is applied with deterministic state. The scheduler step is gated on the catch-up step completing (use the existing `critical: true` semantics for ordering).

The IPC handler step needs to know about automation handlers — we add the registration call in `IpcMainHandler.registerHandlers()` (`src/main/ipc/ipc-main-handler.ts`). Crucially, the handlers themselves can be registered before the domain singletons are initialized, because they look up the singletons lazily on each call (the same pattern the existing handlers use — none of them eagerly resolve their domain at registration time).

## 5. Data model

Two new SQLite tables in the existing RLM database (added via a new migration in `src/main/persistence/rlm/rlm-schema.ts`). One additional table for attachments. No ALTERs to existing tables.

### `automations`

```sql
CREATE TABLE IF NOT EXISTS automations (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,

  -- WHAT to do — MVP supports 'prompt' only. 'workflow' is reserved for Phase 2.
  -- The CHECK below is enforced at the IPC layer too (Zod schema rejects 'workflow' in MVP).
  action_type           TEXT NOT NULL CHECK (action_type IN ('prompt','workflow')),
  prompt                TEXT,                       -- non-null when action_type='prompt'
  workflow_template_id  TEXT,                       -- reserved; non-null when action_type='workflow' (Phase 2)

  -- WHERE (the "project" = working directory)
  working_directory     TEXT NOT NULL,
  force_node_id         TEXT,                       -- null = local; future-proof for remote nodes

  -- HOW (mirrors new-session toolbar)
  agent_id              TEXT NOT NULL DEFAULT 'build',
  provider              TEXT NOT NULL DEFAULT 'auto',
  model                 TEXT,
  reasoning_effort      TEXT,
  yolo_mode             INTEGER NOT NULL DEFAULT 0,

  -- WHEN (cron_expression null only for oneTime)
  schedule_kind         TEXT NOT NULL CHECK (schedule_kind IN ('preset','cron','oneTime')),
  schedule_payload_json TEXT NOT NULL,
  cron_expression       TEXT,
  timezone              TEXT NOT NULL,

  -- POLICY
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','paused','completed')),
  missed_run_policy     TEXT CHECK (missed_run_policy IN ('runOnce','skip','notify')),  -- NULL = use global default

  -- DERIVED STATE
  next_fire_at          INTEGER,
  last_fired_at         INTEGER,
  last_run_id           TEXT,

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,

  CHECK (
    (action_type = 'prompt'   AND prompt IS NOT NULL) OR
    (action_type = 'workflow' AND workflow_template_id IS NOT NULL)
  ),
  CHECK (
    (schedule_kind = 'oneTime' AND cron_expression IS NULL) OR
    (schedule_kind IN ('preset','cron') AND cron_expression IS NOT NULL)
  ),
  CHECK (json_valid(schedule_payload_json))
);
CREATE INDEX IF NOT EXISTS idx_automations_active_next_fire
  ON automations(next_fire_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_automations_working_dir
  ON automations(working_directory);
```

### `automation_runs`

```sql
CREATE TABLE IF NOT EXISTS automation_runs (
  id                    TEXT PRIMARY KEY,
  automation_id         TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,

  scheduled_at          INTEGER NOT NULL,
  queued_at             INTEGER,
  started_at            INTEGER,
  completed_at          INTEGER,

  trigger               TEXT NOT NULL CHECK (trigger IN ('scheduled','manual','catchUp')),

  instance_id           TEXT,
  workflow_execution_id TEXT,                       -- reserved for Phase 2 workflow action

  status                TEXT NOT NULL CHECK (
                          status IN ('pending','running','succeeded','failed','skipped','canceled')),
  skip_reason           TEXT,
  error_message         TEXT,

  seen                  INTEGER NOT NULL DEFAULT 0 CHECK (seen IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_by_automation
  ON automation_runs(automation_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_runs_unseen
  ON automation_runs(seen) WHERE seen = 0;

CREATE INDEX IF NOT EXISTS idx_automation_runs_instance
  ON automation_runs(instance_id) WHERE instance_id IS NOT NULL;

-- Overlap policy enforcement
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_one_running
  ON automation_runs(automation_id) WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_one_pending
  ON automation_runs(automation_id) WHERE status = 'pending';

-- Excludes skipped/canceled so duplicate-detection skip rows
-- (e.g. clock-backward dedupe markers) can still be inserted for history visibility.
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_unique_scheduled
  ON automation_runs(automation_id, scheduled_at)
  WHERE trigger IN ('scheduled', 'catchUp')
    AND status NOT IN ('skipped', 'canceled');
```

`skip_reason` enum (string, not enforced by CHECK because of the open-ended set): `queueFull` / `paused` / `pausedDuringFire` / `deleted` / `appShutdown` / `missedWhileOff` / `missedNeedsAttention` / `duplicate`.

### `automation_attachments`

```sql
CREATE TABLE IF NOT EXISTS automation_attachments (
  id              TEXT PRIMARY KEY,
  automation_id   TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  name            TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  -- A serialized ContentStore ContentRef:
  --   inline:  '{"inline":true,"content":"…"}'
  --   external:'{"inline":false,"hash":"<sha256>","size":<n>}'
  content_ref_json TEXT NOT NULL,
  CHECK (json_valid(content_ref_json))
);
CREATE INDEX IF NOT EXISTS idx_automation_attachments_by_automation
  ON automation_attachments(automation_id, position);
```

**Storage**: The existing `ContentStore` (`src/main/session/content-store.ts`) is used. Its `store(content: string): Promise<ContentRef>` accepts a string (UTF-8 hashed) and returns either an inline ref (< 1 KB) or an external ref keyed by SHA-256.

**Encoding**: `FileAttachment.data` is already a `data:` URL string from the renderer (e.g. `data:image/png;base64,iVBORw0KGgo…`). We store the **raw data URL** as the string passed to `ContentStore.store()` — no decoding to bytes, no separate `Buffer` path. This is intentional:

- ContentStore was designed for strings; the data URL is a string with predictable length characteristics
- Round-trip is lossless: the data URL we pass in is exactly what we get back, ready to assign to `FileAttachment.data` at fire time
- No need to add a `Buffer`-capable path to `ContentStore` for MVP

The `mime_type` and `name` columns on `automation_attachments` capture the FileAttachment metadata; `size_bytes` records the data URL string's byte length (UTF-8) so list views can show "12 KB" without round-tripping the content.

**Durability requirement**: `ContentStore.store()` is *fire-and-forget* by default — the disk write isn't awaited. For automation attachments we need durability (we may not fire the run for hours/days, and an app crash before the write would leave a dangling ref). Phase 1.1 adds an `AutomationAttachmentService` thin wrapper that exposes:

```ts
class AutomationAttachmentService {
  // Saves a data URL durably (awaiting the disk write before returning) and persists the row.
  async save(
    automationId: string,
    attachment: FileAttachment,        // { name, type, size, data: string (data URL) }
    position: number,
  ): Promise<AutomationAttachmentRow>;

  // Loads attachments for fire-time materialization into FileAttachment[] for the lifecycle.
  async load(automationId: string): Promise<FileAttachment[]>;

  async delete(automationId: string, attachmentId: string): Promise<void>;
}
```

The "durable" path adds one new method to `ContentStore` — `storeDurable(content: string): Promise<ContentRef>` that awaits the disk write before returning. Backward-compatible (existing fire-and-forget callers keep current semantics).

On create/edit, the renderer sends `FileAttachment[]` (each with `data: string` data URL). The IPC handler calls `attachmentService.save(automationId, attachment, position)` for each; the service stores the data URL via `ContentStore.storeDurable()` and inserts the row with the resulting `ContentRef`. On fire, `attachmentService.load(automationId)` returns `FileAttachment[]` ready for `InstanceCreateConfig.attachments`.

### Schedule payload (JSON in `schedule_payload_json`)

```ts
type SchedulePayload =
  | { kind: 'preset'; preset: 'hourly';  minute: number /* 0-59 */ }
  | { kind: 'preset'; preset: 'daily';   time: string /* 'HH:mm' */ }
  | { kind: 'preset'; preset: 'weekly';  daysOfWeek: number[] /* 0=Sun..6=Sat */; time: string }
  | { kind: 'preset'; preset: 'monthly'; dayOfMonth: number /* 1-31 */; time: string }
  | { kind: 'cron'; expression: string }
  | { kind: 'oneTime'; runAt: number /* ms epoch UTC */ };
```

For `preset` and `cron`, `cron_expression` is computed and stored. For `oneTime`, it's `NULL` and `runAt` is the source of truth.

### Run-state machine

```
       (scheduled fire)              (instance spawned)
pending ────────────────► running ─────────────────────► succeeded
   │                          │
   │ (overlap, queue full)    │ (spawn fails / instance errors)
   ▼                          ▼
skipped                     failed
   ▲
   │ (deleted while pending, paused, app shutting down)
canceled
```

### Instance ↔ automation linkage

The runner sets `automation_runs.instance_id` after the spawn returns. The renderer queries `getSpawnedSessionMap({ instanceIds })` to drive the clock-icon UI. **No `Instance.metadata` involvement** — that path was rejected because:

- `buildInstanceRecord` (`src/main/instance/lifecycle/instance-create-builder.ts`) doesn't read `config.metadata`
- `instanceToState` (`src/main/session/session-continuity.ts:1034`) doesn't persist `instance.metadata`

The FK is the durable answer.

### Retention

`automation-store.ts` prunes runs older than the most recent 50 per automation, run on startup and after each run completes. Configurable via a future per-automation setting; default 50.

## 6. Scheduler (`AutomationScheduler`)

### Responsibilities

Translate active automation rows into live cron schedules; fire the runner when each schedule trips; keep `next_fire_at` persisted; survive OS suspend/resume.

### Engine

`croner`. DST-correct, IANA-timezone-aware, no polling, ~10 KB.

### Public API

```ts
class AutomationScheduler {
  static getInstance(): AutomationScheduler;
  static _resetForTesting(): void;

  initialize(deps: {
    store: AutomationStore;
    runner: AutomationRunner;
    catchUp: CatchUpCoordinator;
    now?: () => number;
  }): Promise<void>;

  activate(automation: Automation): void;
  deactivate(automationId: string): void;
  reschedule(automation: Automation): void;
  fireNow(automationId: string, opts?: { ignoreOverlap?: boolean }): Promise<{ runId: string }>;

  describeNextFire(automationId: string): {
    nextFireAt: number | null;
    previousFireAt: number | null;
    cron: string | null;
  };

  shutdown(): Promise<void>;
}
```

### Internal state

The schedules map holds either a real `Cron` (for preset/cron schedules) or a re-arming timer (for one-time). Both implement a small `ScheduleHandle` interface so `deactivate()`, `shutdown()`, and `describeNextFire()` stay type-safe:

```ts
interface ScheduleHandle {
  kind: 'cron' | 'oneTime';
  nextFireAt(): number | null;          // ms epoch; null when no future fire
  previousFireAt(): number | null;
  stop(): void;
}

class CronHandle implements ScheduleHandle {
  readonly kind = 'cron';
  constructor(private cron: Cron) {}
  nextFireAt() { return this.cron.nextRun()?.getTime() ?? null; }
  previousFireAt() { return this.cron.previousRun()?.getTime() ?? null; }
  stop() { this.cron.stop(); }
}

class OneTimeHandle implements ScheduleHandle {
  readonly kind = 'oneTime';
  private timer: ReturnType<typeof setTimeout> | null;
  constructor(timer: ReturnType<typeof setTimeout>, private runAt: number) { this.timer = timer; }
  nextFireAt() { return this.timer ? this.runAt : null; }
  previousFireAt() { return this.timer ? null : this.runAt; }
  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  reArm(timer: ReturnType<typeof setTimeout>): void {
    this.stop();
    this.timer = timer;
  }
}

private schedules = new Map<string, ScheduleHandle>();
```

The map is the runtime truth; the DB is the durable truth. They reconcile on `initialize()` and after every CRUD operation. (Earlier iterations of the spec talked about a `wrapTimerAsCronShim` helper — replaced by the explicit `OneTimeHandle` for clarity.)

### Payload-to-cron translation

```ts
function payloadToCron(payload: SchedulePayload): { cron: string | null; oneTimeAt: number | null } {
  switch (payload.kind) {
    case 'preset':
      switch (payload.preset) {
        case 'hourly':  return { cron: `${payload.minute} * * * *`, oneTimeAt: null };
        case 'daily':   return { cron: `${minutes(payload.time)} ${hours(payload.time)} * * *`, oneTimeAt: null };
        case 'weekly':  return { cron: `${minutes(payload.time)} ${hours(payload.time)} * * ${payload.daysOfWeek.join(',')}`, oneTimeAt: null };
        case 'monthly': return { cron: `${minutes(payload.time)} ${hours(payload.time)} ${payload.dayOfMonth} * *`, oneTimeAt: null };
      }
    case 'cron':    return { cron: payload.expression, oneTimeAt: null };
    case 'oneTime': return { cron: null, oneTimeAt: payload.runAt };
  }
}
```

`oneTime` doesn't go through croner — it uses a **bounded re-arming timer pattern** rather than a single raw `setTimeout`. Node's `setTimeout` is not robust for delays measured in weeks/months (some Node versions clamp at ~24.8 days; even when they don't, the timer can drift across system suspend cycles or be lost to GC pressure). The scheduler instead arms a timer for `min(remainingMs, MAX_TIMER_MS = 24h)`; on fire, it rechecks the persisted `next_fire_at`:

```ts
private armOneTime(automationId: string, runAt: number): void {
  const now = this.now();
  const remaining = runAt - now;

  // Past due (catch-up coordinator already handled this on startup, but defensive):
  if (remaining <= 0) {
    void this.runner.fire(automationId, { trigger: 'scheduled', scheduledAt: runAt });
    return;
  }

  const delay = Math.min(remaining, 24 * 60 * 60 * 1000);  // cap at 24h
  const timer = setTimeout(() => {
    if (this.now() >= runAt) {
      void this.runner.fire(automationId, { trigger: 'scheduled', scheduledAt: runAt });
    } else {
      this.armOneTime(automationId, runAt);  // re-arm for the remaining window
    }
  }, delay);

  // Reuse the existing OneTimeHandle if present (so a re-arm doesn't churn the map);
  // otherwise create a fresh one.
  const existing = this.schedules.get(automationId);
  if (existing && existing.kind === 'oneTime') {
    (existing as OneTimeHandle).reArm(timer);
  } else {
    this.schedules.set(automationId, new OneTimeHandle(timer, runAt));
  }
  this.store.updateNextFireAt(automationId, runAt);
}
```

The DB's `next_fire_at` is the source of truth — even if the process restarts mid-wait, the catch-up coordinator's startup sweep handles whichever side of `runAt` we're on, then the scheduler re-arms with a bounded timer for the remaining time.

### Suspend / resume

The scheduler subscribes to **both** `suspend` and `resume` so the catch-up coordinator can use the real suspend window (rather than a heuristic):

```ts
private suspendedAt: number | null = null;

powerMonitor.on('suspend', () => {
  // Capture the moment of suspend so the resume sweep has a real `since` value.
  this.suspendedAt = this.now();
});

powerMonitor.on('resume', () => {
  void this.handleResume();
});

private async handleResume(): Promise<void> {
  // Croner pauses while OS sleeps. Hand control to the catch-up coordinator
  // with both timestamps so it can apply per-automation missed_run_policy
  // against the actual suspend window. If we somehow missed the suspend event
  // (powerMonitor not wired in time, OS hibernated without firing), the
  // coordinator falls back to a heuristic — see Section 8 Resume sweep.
  const resumedAt = this.now();
  const suspendedAt = this.suspendedAt;        // may be null on first wake / missed suspend
  this.suspendedAt = null;
  await this.catchUp.runResumeSweep({ suspendedAt, resumedAt });
}
```

Each croner schedule is then re-armed from the current moment forward by re-calling `activate()` for active automations.

### `nextFireAt` persistence policy

Persist on `activate()`, after every fire, on `reschedule()`, on `deactivate()`, and after `handleResume()`. Never poll.

### One-time terminal

A `oneTime` automation's parent `status` transitions to `'completed'` only when the run produces a definitive non-failure outcome:

| Run outcome | Parent transition | Rationale |
|---|---|---|
| `succeeded` | → `completed` | The run did its job. |
| `failed` | stay `active`, `next_fire_at=NULL` | Allow manual re-fire from the UI; transient failures shouldn't bury the only chance to run. |
| `skipped` (catch-up `skip` policy) | → `completed` | The user asked to skip this run; nothing else will happen. |
| `skipped` (catch-up `notify` policy) | → `completed` | Same as above; the badge surfaces it. |
| `canceled` (paused/deleted/appShutdown) | stay `active` | Allow re-arming after un-pause. (For `deleted`, the row is gone via CASCADE.) |
| `skipped` (queueFull / pausedDuringFire / duplicate / overlap) | stay `active` | These are *runtime overlaps*, not the user's only chance — equivalent to a transient failure. |

The transition is applied by:

- The **scheduler** when it observes `automation:run-terminal` with `status='succeeded'` for a oneTime
- The **catch-up coordinator** when it inserts a `skipped` row for a oneTime under `skip`/`notify` policy (see Section 8)

In both cases:

```ts
this.store.transitionToCompleted(automationId);  // status='completed', next_fire_at=NULL
this.deactivate(automationId);                    // remove from schedules map
```

### Late-fire guard

Each croner callback compares `expectedFireTime` against `now()`. If skew exceeds 60s (e.g., after a missed wake-up), the runner re-labels the call as `trigger='catchUp'` so the run shows up correctly in history. The fire itself still proceeds — this guard does *not* re-apply missed-run policy; the catch-up coordinator handles that separately on startup/resume sweeps for fires we never received.

## 7. Runner & action dispatch (`AutomationRunner`)

### Responsibilities

Take `fire(automationId, { trigger })` calls; decide whether to run, queue, or skip; dispatch via `InstanceManager.createInstance()` (with `initialPrompt` + `attachments`); record the run; subscribe to completion events; promote queued runs. (MVP supports `actionType='prompt'` only; workflow dispatch is Phase 2.)

### Public API

```ts
class AutomationRunner {
  static getInstance(): AutomationRunner;
  static _resetForTesting(): void;

  initialize(deps: {
    store: AutomationStore;
    // InstanceManager is the SINGLE integration point for both events AND
    // lifecycle calls. The lifecycle manager itself is `private` inside
    // InstanceManager (`instance-manager.ts:116`) — no public accessor — so
    // the runner uses InstanceManager.createInstance() / .terminateInstance(),
    // which are public wrappers (`instance-manager.ts:951,955`).
    instanceManager: InstanceManager;
    attachmentService: AutomationAttachmentService;
    // workflowManager: deferred to Phase 2.
    now?: () => number;
  }): Promise<void>;

  fire(
    automationId: string,
    opts: { trigger: 'scheduled' | 'manual' | 'catchUp'; scheduledAt?: number }
  ): Promise<{ runId: string; outcome: 'started' | 'queued' | 'skipped' }>;

  cancelPending(automationId: string, reason: 'paused' | 'deleted' | 'appShutdown'): Promise<void>;

  shutdown(): Promise<void>;
}
```

### Fire flow

1. Load automation; if `status='paused'` or `'completed'`, insert `skipped` and return.
2. **Clock-backward dedupe** (only for `trigger='scheduled'` or `'catchUp'`; manual fires are exempt because the user is intentionally firing now): if `scheduledAt <= last_fired_at`, insert `skipped` with `skip_reason='duplicate'`, return.
3. **Late-fire guard**: if `trigger='scheduled'` and `now() - scheduledAt > 60s`, re-label the call as `trigger='catchUp'` so it appears correctly in history. The fire still proceeds — this guard is about *labeling*, not about re-applying missed-run policy. (Policy is applied separately by the catch-up coordinator on startup/resume sweeps for fires we never received.)
4. **Overlap decision** (single transaction):
   - No in-flight → `start`
   - `running` only → `queue` (insert `pending`)
   - `running` + `pending` → `skip` (insert with `skip_reason='queueFull'`)
5. If `start`, dispatch via action handler.
6. Record `instance_id` on the run row. (`workflow_execution_id` is reserved for Phase 2.)
7. Subscribe to completion events for this run.

The partial unique indexes from Section 5 catch any race that slips past the read-then-insert pattern; constraint errors are treated as `skip`.

### Action dispatch

The runner runs in the main process and calls `InstanceManager` (public wrappers `createInstance`/`terminateInstance`) directly — it does *not* go through the renderer-side IPC schemas. Constraints are on `InstanceCreateConfig` (the type the underlying lifecycle accepts), not on `InstanceCreateWithMessagePayloadSchema` (which is only for the renderer's create flow).

**Pre-flight check** (Section 11.3 #16): if the automation has a `forceNodeId`, the runner verifies the node is reachable *before* calling the lifecycle. The lifecycle's existing behavior is to log a warning and silently fall through to local execution if a forced node is offline (`src/main/instance/instance-lifecycle.ts:424-433`); for unattended automations this is dangerous (creds/paths may only exist on the remote), so the runner short-circuits with a `failed` run instead.

```ts
private async dispatch(automation: Automation, run: AutomationRun): Promise<DispatchResult> {
  // Pre-flight: forceNodeId must be reachable. Don't trust lifecycle's silent fall-through.
  if (automation.forceNodeId) {
    const node = getWorkerNodeRegistry().getNode(automation.forceNodeId);
    if (!node || (node.status !== 'connected' && node.status !== 'degraded')) {
      throw new RunDispatchError(`Forced node ${automation.forceNodeId} is unreachable (status=${node?.status ?? 'not-found'})`);
    }
  }

  // Build InstanceCreateConfig — note `modelOverride` (not `model`) is the field name.
  const createConfig: InstanceCreateConfig = {
    workingDirectory: automation.workingDirectory,
    agentId: automation.agentId,
    provider: automation.provider,
    modelOverride: automation.model ?? undefined,
    yoloMode: automation.yoloMode,
    forceNodeId: automation.forceNodeId ?? undefined,
    reasoningEffort: automation.reasoningEffort ?? undefined,   // see schema-extension note below
  };

  // MVP supports `actionType='prompt'` only. `'workflow'` was descoped after five
  // code-review rounds surfaced cascading complexity (synchronous-event tracking, agent
  // vs no-agent advancement, reentrant completePhase, terminalization-vs-persistence
  // races) AND the realization that the app has no UI/IPC to *create* a no-gate template
  // (registerTemplate is internal/test-only); built-in templates all have gates and would
  // be unusable. Phase 2 ships workflow action together with template authoring + gated
  // workflow support. See decision log Q1 update and revision history v7.

  // No createInstanceWithMessage exists. The "create + send first message" pattern is
  // encoded by setting initialPrompt + attachments on InstanceCreateConfig.
  const attachments = await this.attachmentService.load(automation.id);
  const instance = await this.instanceManager.createInstance({
    ...createConfig,
    initialPrompt: automation.prompt,                 // non-null per the schema CHECK
    attachments,
  });
  return { kind: 'instance', instanceId: instance.id };
}
```

**Schema-extension note**: `InstanceCreateConfig` (`src/shared/types/instance.types.ts:337`) does not currently have a `reasoningEffort` field. Phase 1.3 includes adding it. The lower-level CLI adapters already understand reasoning effort, so the type extension is the only missing piece for the runner to thread it through. The renderer's `InstanceCreateWithMessagePayloadSchema` does not need to change — that schema is only for the renderer's manual create flow, and the runner doesn't go through it.

**Type-name reminder**: `InstanceCreateConfig.modelOverride` (not `model`) is the actual field for the model id. Spec sections that say "model" are referring to the automation row's column, which the runner maps to `modelOverride` when constructing the lifecycle config.

**Lifecycle access**: `InstanceLifecycleManager` is `private` inside `InstanceManager` (`instance-manager.ts:116`) — there is no public accessor. The runner uses the public wrappers `InstanceManager.createInstance(config)` (`instance-manager.ts:951`) and `InstanceManager.terminateInstance(id, graceful)` (`instance-manager.ts:955`).

There is no `createInstanceWithMessage` anywhere in the lifecycle hierarchy. The "create + send first message" semantic is encoded by populating `initialPrompt` + `attachments` on `InstanceCreateConfig`, which the lifecycle's spawn path then forwards to the adapter (`instance-lifecycle.ts:1349-1361`).

### Workflow action — DEFERRED TO PHASE 2

**MVP supports `actionType='prompt'` only.** Workflow action was descoped after sustained code-review pressure surfaced cascading issues:

- `WorkflowManager.startWorkflow()` emits `workflow:started` synchronously inside its call frame, so any executionId-keyed mapping registered after it returns misses the first event (race);
- The auto-advance helper has a real distinction between "called pre-agents" and "called post-agents" that requires a context flag to avoid stalling agent phases;
- `workflow:phase-changed` is emitted from inside `completePhase()` before it returns, so any reentrancy guard drops follow-up advancements (no-agent → no-agent and agent → no-agent stall);
- All four built-in workflow templates contain at least one non-`none` gate, so a no-gate-template filter would show an empty/disabled dropdown by default;
- The app exposes no UI/IPC path to create user-defined templates (`registerTemplate()` is internal/test-only), so an "empty state with create-template link" goes nowhere;
- Workflow runs would also need to handle `instance:event`/`instance:removed` failure paths plus `workflow:cancelled` (`workflow-manager.ts:484`), separate from the prompt-run tracking logic.

Phase 2 ships workflow action together with **template authoring/import** + **gated workflow support** + the auto-advance/race fixes that v5/v6 of this spec sketched. The historical sketches are preserved in git history (commits `7ca530a`, `c1860d7`, `b35db51`, `88f7c85`) and the v6 design content can be revived directly into a Phase 2 spec when those prerequisites are in place.

The decision log Q1 is updated to: "MVP — prompt action only. Workflow chaining shipped in Phase 2 alongside its prerequisites."

### Completion detection

Passive — subscribe, don't poll. The runner subscribes to `InstanceManager` (which extends `EventEmitter` and forwards lifecycle events; see `src/main/instance/instance-manager.ts:378-417`).

`InstanceEventAggregator` is *not* an EventEmitter — it's a record-keeping class. Subscriptions go on `InstanceManager` instead.

**Critical envelope shape detail** (`packages/contracts/src/types/instance-events.ts:59-65`): the `instance:event` payload is

```ts
interface InstanceEventEnvelope {
  eventId: string;
  seq: number;
  timestamp: number;
  instanceId: string;
  event: InstanceEvent;          // ← the discriminated union lives HERE, not on the envelope
}
```

So inspection is `envelope.event.kind`, `envelope.event.status`, `envelope.event.failureClass` — *not* `envelope.kind` directly. And `instance:removed` is emitted with a plain `instanceId: string` payload (`instance-manager.ts:404`), not an envelope.

**Why "first busy → idle" alone is unsafe**: the spawn path emits `state-update` events that walk through `initializing → ready → idle` *before* the initial prompt is sent. If sending the prompt fails (Codex adapter test cases prove this), the lifecycle then transitions the instance to `failed` (`instance-lifecycle.ts:1363`). A naive watcher would see the early `idle` and falsely declare success. We need a stronger signal.

**The actual success signal**: the run is `succeeded` only after we observe **both** an assistant-typed output AND a subsequent transition back to `idle`. The output proves the model actually produced something; the post-output idle proves the model finished its initial turn.

**Where assistant outputs come from**: `InstanceManager.publishOutput()` (`instance-manager.ts:829`) does *not* emit a separate `'instance:output'` event — it routes everything through `'provider:normalized-event'` (line 860) carrying a `ProviderRuntimeEventEnvelope`. The runner subscribes to that channel and converts each envelope back into an `OutputMessage` via the existing `toOutputMessageFromProviderEnvelope()` helper (`src/main/providers/provider-output-event.ts`; usage pattern at `channel-message-router.ts:1471-1474`).

```ts
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

interface RunTrackingState {
  runId: string;
  sawAssistantOutput: boolean;        // bit flips on first assistant output
  awaitingPostOutputIdle: boolean;    // arms after output; tripped on next idle
}

private trackingByInstance = new Map<string, RunTrackingState>();

initialize(deps: ...): Promise<void> {
  // (1) State changes for terminal failures + the post-output-idle confirmation
  deps.instanceManager.on('instance:event', (envelope: InstanceEventEnvelope) => {
    const tracking = this.trackingByInstance.get(envelope.instanceId);
    if (!tracking) return;
    if (envelope.event.kind !== 'status_changed') return;

    const { status, failureClass } = envelope.event;

    if (status === 'idle' && tracking.awaitingPostOutputIdle) {
      this.trackingByInstance.delete(envelope.instanceId);
      this.handleInstanceTerminal(tracking.runId, 'succeeded');
      return;
    }

    if (status === 'error' || status === 'failed' || status === 'terminated') {
      this.trackingByInstance.delete(envelope.instanceId);
      this.handleInstanceTerminal(
        tracking.runId,
        'failed',
        `Instance ${status}` + (failureClass ? ` (${failureClass})` : ''),
      );
      return;
    }

    // Unattended-automation guard: waiting_for_input / waiting_for_permission are
    // durable interactive states that block the queue indefinitely. Even with
    // yolo enabled, some prompts (e.g. uncategorized tool requests) can land here.
    // Treat as terminal failure with a clear message; the user can re-fire manually
    // (after enabling yolo, completing the prompt manually, or editing the
    // automation's permission scope).
    if (status === 'waiting_for_input' || status === 'waiting_for_permission') {
      this.trackingByInstance.delete(envelope.instanceId);
      this.handleInstanceTerminal(
        tracking.runId,
        'failed',
        `Automation halted in '${status}' — interactive input/permission required. ` +
        `Enable yolo on this automation, narrow its agent profile, or re-run manually.`,
      );
      // Best-effort terminate to free the instance + spawned session for re-use.
      void this.instanceManager.terminateInstance(envelope.instanceId, true).catch(() => undefined);
    }
  });

  // (2) Output observation via provider:normalized-event — arms the post-output-idle watcher.
  //     This is the real channel — there is NO 'instance:output' event.
  deps.instanceManager.on('provider:normalized-event', (envelope: ProviderRuntimeEventEnvelope) => {
    const tracking = this.trackingByInstance.get(envelope.instanceId);
    if (!tracking) return;

    const message = toOutputMessageFromProviderEnvelope(envelope);
    if (!message || message.type !== 'assistant') return;   // ignore non-assistant outputs

    tracking.sawAssistantOutput = true;
    tracking.awaitingPostOutputIdle = true;
  });

  // (3) Instance removed entirely — ensure we don't leak tracking entries.
  //     The 'instance:removed' payload is `instanceId: string`, NOT an envelope.
  deps.instanceManager.on('instance:removed', (instanceId: string) => {
    const tracking = this.trackingByInstance.get(instanceId);
    if (tracking) {
      this.trackingByInstance.delete(instanceId);
      this.handleInstanceTerminal(tracking.runId, 'failed', 'Instance removed before completion');
    }
  });

  // (4) Workflow events — DEFERRED TO PHASE 2 (no workflow action in MVP).
}
```

**A run is `succeeded`** when the spawned instance has produced at least one assistant `output` AND has subsequently transitioned to `idle`. Subsequent user interaction is normal session activity — the queue advances.

**A run is `failed`** when the instance enters `error`, `failed`, or `terminated` *or* is removed *before* the post-output idle. We surface the `failureClass` (`startup`/`runtime`/`recovery`/`termination`/`transition`/`permission` per the contract enum) in the error message.

**Note on the InstanceStatus enum**: the contract status enum (`packages/contracts/src/types/instance-events.ts:1-22`) is wider than just `idle`/`busy`/`error`/`failed`/`terminated` — it also includes `initializing`, `ready`, `processing`, `thinking_deeply`, `waiting_for_input`, `waiting_for_permission`, etc. The runner reacts to:

- `idle` (only after assistant output → success)
- `error` / `failed` / `terminated` (failure)
- `waiting_for_input` / `waiting_for_permission` (failure with "interactive input required" message; instance terminated to free the queue)

All other intermediate statuses (`initializing`, `ready`, `processing`, `thinking_deeply`, etc.) are ignored — they're transient and don't terminalize the run.

### Queue promotion

When a `running` run terminates, the runner finds any `pending` row for the same automation and promotes it transactionally (`UPDATE ... SET status='running'` — the partial unique index protects against double-promotion).

### Run-now

Calls `runner.fire(id, { trigger: 'manual' })` — exact same code path, including overlap policy. Manual fires queue (or skip on queue-full) just like scheduled ones.

### Cancellation matrix

| Event | Pending runs | Running runs |
|---|---|---|
| Pause | `canceled`, `skip_reason='paused'` | leave running; no new fires after completion |
| Delete | `canceled`, `skip_reason='deleted'` (then CASCADE) | leave running; CASCADE removes run row |
| App shutdown | `canceled`, `skip_reason='appShutdown'` | left as `running` — startup sweep reconciles to `failed` |
| Instance killed by user mid-run | n/a | `failed`, `error_message='User terminated session'` |

## 8. Catch-up coordinator (`CatchUpCoordinator`)

### Responsibilities

Single owner of "what to do about runs we should have fired but didn't." Three triggers (startup, resume, future manual-catchup), one policy engine.

### Public API

```ts
class CatchUpCoordinator {
  static getInstance(): CatchUpCoordinator;
  static _resetForTesting(): void;

  initialize(deps: {
    store: AutomationStore;
    runner: AutomationRunner;
    settings: SettingsStore;
    now?: () => number;
  }): Promise<void>;

  runStartupSweep(): Promise<StartupSweepResult>;
  runResumeSweep(window: { suspendedAt: number | null; resumedAt: number }): Promise<ResumeSweepResult>;
}
```

### Startup sweep — Step A: stale running rows

```sql
UPDATE automation_runs
SET status='failed', error_message='App terminated mid-run', completed_at=?
WHERE status='running';
```

### Startup sweep — Step B: stale pending rows

```sql
UPDATE automation_runs
SET status='canceled', skip_reason='appShutdown'
WHERE status='pending';
```

### Step C: missed-fire policy application

The window for "missed fires" depends on whether this is a startup or resume sweep:

| Sweep | `since` | `until` |
|---|---|---|
| **Startup** | `automation.lastFiredAt ?? automation.createdAt` (per-automation; no app-level last-shutdown timestamp) | `now()` |
| **Resume** | `window.suspendedAt` (passed from scheduler's `suspend` listener; fallback to `resumedAt - 10min` heuristic when null — first wake / missed suspend event) | `window.resumedAt` |

For each automation with `status='active'`:

```ts
// SettingsManager.get<K extends keyof AppSettings>(key: K) — key must be a top-level
// AppSettings field, not a dotted path. Phase 1.5 adds a flat `defaultMissedRunPolicy`
// to AppSettings; the call site is therefore:
const policy = automation.missedRunPolicy ?? settings.get('defaultMissedRunPolicy');

// Step C inputs — computed differently per sweep type, but applied identically below.
const since = sweepKind === 'startup'
  ? (automation.lastFiredAt ?? automation.createdAt)
  : suspendedAt;
const until = sweepKind === 'startup' ? now() : resumedAt;

const baseline = automation.lastFiredAt ?? automation.createdAt;
const referencePoint = Math.max(baseline, since);
const missed = computeMissedFireTimes(automation, referencePoint, until);

if (missed.length === 0) return;

switch (policy) {
  case 'runOnce':
    await runner.fire(automation.id, { trigger: 'catchUp', scheduledAt: missed[missed.length - 1] });
    // For oneTime: the runner's terminal handler transitions parent → 'completed' on success,
    // or leaves it 'active' on failure (allowing manual re-fire). See Section 6's One-time terminal.
    break;
  case 'skip':
    store.insertSkippedRun(automation.id, missed[missed.length - 1], 'missedWhileOff');
    if (automation.scheduleKind === 'oneTime') {
      store.transitionToCompleted(automation.id);   // see One-time completion rules below
    }
    break;
  case 'notify':
    store.insertSkippedRun(automation.id, missed[missed.length - 1], 'missedNeedsAttention');
    if (automation.scheduleKind === 'oneTime') {
      store.transitionToCompleted(automation.id);
    }
    break;
}
```

### Computing missed fires

```ts
function computeMissedFireTimes(automation: Automation, since: number, until: number): number[] {
  if (automation.scheduleKind === 'oneTime') {
    const runAt = parsePayload(automation).runAt;
    return runAt > since && runAt <= until ? [runAt] : [];
  }
  const cron = new Cron(automation.cronExpression!, { timezone: automation.timezone });
  const missed: number[] = [];
  let cursor = until;
  while (true) {
    const prev = cron.previousRun(new Date(cursor))?.getTime();
    if (!prev || prev <= since) break;
    missed.push(prev);
    cursor = prev - 1;
    if (missed.length > 100) break;  // sanity cap
  }
  return missed.reverse();
}
```

`runOnce` only fires the most recent missed time — matches "I want today's daily, not last week's" intuition.

### Resume sweep

Called as `runResumeSweep({ suspendedAt, resumedAt })`. Step C runs with `since = suspendedAt ?? (resumedAt - 10 * 60 * 1000)` (10-minute heuristic fallback when the suspend event was missed — e.g., on first wake, or if powerMonitor wasn't wired in time) and `until = resumedAt`. Steps A/B are not re-run on resume.

### Global default policy

A new top-level `AppSettings` field (Phase 1.5):

```ts
defaultMissedRunPolicy: 'runOnce' | 'skip' | 'notify'   // default 'runOnce'
```

NULL on an automation row means "follow global default" — changing the global propagates without rewriting rows. Accessed via `settings.get('defaultMissedRunPolicy')`.

## 9. IPC contract

### Channels

| Channel | Payload | Returns |
|---|---|---|
| `automation:list` | — | `Automation[]` |
| `automation:get` | `{ id }` | `Automation \| null` |
| `automation:create` | `CreateAutomationInput` | `{ id }` |
| `automation:update` | `{ id, patch: UpdateAutomationInput }` | `void` |
| `automation:delete` | `{ id }` | `void` |
| `automation:pause` | `{ id }` | `void` |
| `automation:resume` | `{ id }` | `void` |
| `automation:runNow` | `{ id }` | `{ runId, outcome: 'started'\|'queued'\|'skipped' }` |
| `automation:cancelPending` | `{ id }` | `void` |
| `automation:listRuns` | `{ automationId, limit?: number }` | `AutomationRun[]` (newest-first; default 50) |
| `automation:markRunsSeen` | `{ runIds: string[] } \| { automationId }` | `void` |
| `automation:getSpawnedSessionMap` | `{ instanceIds: string[] }` | `Record<instanceId, SpawnedSessionLink>` |
| `automation:validateCron` | `{ expression, timezone? }` | `{ valid: boolean, nextFires?: number[], error?: string }` |

### Events (main → renderer)

- `automation:created` — `{ automation }`
- `automation:updated` — `{ automation }`
- `automation:deleted` — `{ id }`
- `automation:run-created` — `{ run }`
- `automation:run-updated` — `{ run }`
- `automation:next-fire-changed` — `{ id, nextFireAt }`
- `automation:unseen-count-changed` — `{ count }`

### Where the schemas / channels / preload live

Updated to match the project's current contract layout (the spec previously pointed at `src/shared/validation/ipc-schemas.ts`, which doesn't exist):

| Concern | Location | Pattern |
|---|---|---|
| Zod schemas | **NEW** `packages/contracts/src/schemas/automation.schemas.ts` | exports `*PayloadSchema` Zod values; matches sibling `instance.schemas.ts` |
| Channel constants | **NEW** `packages/contracts/src/channels/automation.channels.ts` | matches sibling `instance.channels.ts` |
| Preload bridge | `src/preload/domains/automation.preload.ts` | composed into the generated preload bundle alongside other domains |
| Main-process handlers | `src/main/ipc/handlers/automation-handlers.ts` | uses `validatedHandler` with the schemas above |

**Important**: the preload composition is generated — adding a new domain requires running whatever the project's preload-generation step is (verify in package.json scripts). If preload generation is manual (a hand-edited barrel), edit the barrel.

**`@contracts/...` subpath registration (per AGENTS.md "Packaging Gotchas")**: adding new files under `packages/contracts/src/schemas/` and `packages/contracts/src/channels/` means importers reference them as `@contracts/schemas/automation` and `@contracts/channels/automation`. The short subpath aliasing is bridged by **five** places that must stay in sync — tsc path aliases are type-check-only and don't rewrite emitted JS, so missing the runtime resolver causes the packaged DMG to crash on startup with `Cannot find module …/schemas/automation` even though typecheck and lint pass:

1. `packages/contracts/package.json` — add the new `exports` subpath entries (`./schemas/automation` and `./channels/automation`)
2. `tsconfig.json` — add path alias entries for `@contracts/schemas/automation` and `@contracts/channels/automation`
3. `tsconfig.electron.json` — same path alias additions for main-process type-checking
4. `src/main/register-aliases.ts` — add to `exactAliases` (Node runtime resolver — this is the load-bearing one for the packaged app)
5. `vitest.config.ts` — add the alias if any spec imports the new subpath

This is a checklist item the implementer must complete in Phase 1.5 alongside creating the schema/channel files.

**AppSettings extension** (from `src/shared/types/settings.types.ts:18`): `SettingsManager.get<K extends keyof AppSettings>(key: K)` is keyed by a top-level `AppSettings` field, not a dotted path (`src/main/core/config/settings-manager.ts:189`). Phase 1.5 adds a flat key `defaultMissedRunPolicy?: 'runOnce' | 'skip' | 'notify'` to `AppSettings` and the corresponding default constants. The catch-up coordinator calls `settings.get('defaultMissedRunPolicy')` (not `'automations.defaultMissedRunPolicy'`).

### Zod schemas (in `packages/contracts/src/schemas/automation.schemas.ts`)

```ts
const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'HH:mm');

export const schedulePayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), preset: z.literal('hourly'),  minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('preset'), preset: z.literal('daily'),   time: timeStringSchema }),
  z.object({ kind: z.literal('preset'), preset: z.literal('weekly'),  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1), time: timeStringSchema }),
  z.object({ kind: z.literal('preset'), preset: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31), time: timeStringSchema }),
  z.object({ kind: z.literal('cron'),    expression: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('oneTime'), runAt: z.number().int().positive() }),
]);

// MVP: prompt action only. The workflow branch is reserved for Phase 2 — keep the
// discriminated-union shape so adding it later is purely additive.
export const automationActionSchema = z.discriminatedUnion('actionType', [
  z.object({
    actionType: z.literal('prompt'),
    prompt:     z.string().min(1).max(50_000),
    attachments: z.array(fileAttachmentSchema).max(20).optional(),
  }),
  // Phase 2 (deferred):
  // z.object({
  //   actionType:         z.literal('workflow'),
  //   workflowTemplateId: z.string().min(1),
  // }),
]);

export const createAutomationInputSchema = z.object({
  name:               z.string().min(1).max(120),
  description:        z.string().max(500).optional(),
  workingDirectory:   z.string().min(1),
  forceNodeId:        z.string().optional(),
  agentId:            z.string().default('build'),
  provider:           z.enum(['claude','codex','gemini','copilot','cursor','auto']).default('auto'),
  model:              z.string().optional(),
  reasoningEffort:    z.enum(['low','medium','high']).optional(),
  yoloMode:           z.boolean().default(false),
  schedule:           schedulePayloadSchema,
  timezone:           z.string().min(1),
  missedRunPolicy:    z.enum(['runOnce','skip','notify']).nullable().default(null),
  action:             automationActionSchema,
});

export const updateAutomationInputSchema = createAutomationInputSchema.partial();
```

### `validateCron` handler

```ts
ipcMain.handle('automation:validateCron',
  validatedHandler(validateCronSchema, async ({ expression, timezone }) => {
    try {
      const cron = new Cron(expression, { timezone: timezone ?? 'UTC' });
      const fires: number[] = [];
      let cursor = new Date();
      for (let i = 0; i < 5; i++) {
        const next = cron.nextRun(cursor);
        if (!next) break;
        fires.push(next.getTime());
        cursor = new Date(next.getTime() + 1000);
      }
      return { valid: true, nextFires: fires };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid cron expression' };
    }
  }),
);
```

## 10. Renderer (UI)

### Routes

```
/automations              → AutomationsPageComponent     (list)
/automations/new          → AutomationFormComponent      (create)
/automations/:id          → AutomationDetailComponent    (matches screenshot)
/automations/:id/edit     → AutomationFormComponent      (edit)
```

### File layout

```
src/renderer/app/features/automations/
├── automations.routes.ts
├── automations-page.component.ts
├── automation-detail.component.ts
├── automation-form.component.ts
└── components/
    ├── automation-list-item.component.ts
    ├── automation-status-panel.component.ts
    ├── automation-details-panel.component.ts
    ├── automation-runs-list.component.ts
    ├── schedule-picker.component.ts
    └── automation-action-picker.component.ts

src/renderer/app/core/state/automation/automation.store.ts
src/renderer/app/core/services/ipc/automation-ipc.service.ts
src/preload/domains/automation.preload.ts
```

### `AutomationStore`

```ts
@Injectable({ providedIn: 'root' })
export class AutomationStore {
  private ipc = inject(AutomationIpcService);

  readonly automations = signal<Automation[]>([]);
  readonly selectedId  = signal<string | null>(null);
  readonly selected    = computed(() =>
    this.automations().find(a => a.id === this.selectedId()) ?? null);
  readonly unseenCount = signal<number>(0);

  readonly spawnedMap  = signal<Map<string, SpawnedSessionLink>>(new Map());

  async load(): Promise<void> { /* IPC + event subscriptions */ }
  async create(input: CreateAutomationInput): Promise<void> { /* ... */ }
  async update(id: string, patch: UpdateAutomationInput): Promise<void> { /* ... */ }
  async delete(id: string): Promise<void> { /* ... */ }
  async pause(id: string): Promise<void> { /* ... */ }
  async resume(id: string): Promise<void> { /* ... */ }
  async runNow(id: string): Promise<RunNowOutcome> { /* ... */ }

  getSessionAutomation(sessionId: string): SpawnedSessionLink | undefined;
  isUnreadAutomationSession(sessionId: string): boolean;
}
```

### List page

Header: title + "+ New automation" button. Body: list of automation cards (name, schedule summary, next-fire badge, status pill, unread count). Click → routes to detail.

Empty state: "No automations yet — create your first scheduled task" with CTA.

### Detail page

Layout matches the screenshot:

- Header: back link, title, [Pause/Resume], [Delete], [Run now] buttons
- Body: prompt body / description (or workflow template summary)
- Right panel:
  - **Status**: status pill, Next run, Last ran
  - **Details**: Runs in (Local/remote node), Project (working dir), Repeats (schedule summary), Model, Reasoning — each with quick-edit dropdown
  - **Previous runs**: last 50 with status icons; click to navigate to spawned session

Quick-edit popovers commit via `update(id, patch)`. Bigger edits go through the form mode.

### Form

Six sections:
1. Name & description
2. **What to do** — prompt textarea + attachment dropzone. (Phase 2 will add a "Run a workflow" toggle alongside; the form's discriminated state machine should leave room for it.)
3. **Where to run** — working-directory picker (re-uses recent-directories), forceNodeId picker if remote configured.
4. **How to run** — embedded compact composer toolbar (agent, provider, model, reasoning, yolo).
5. **When to run** — `<schedule-picker>`.
6. **Missed-run policy** — radio with "Use global default" as the unselected option.

### `<schedule-picker>`

Top-level radio: Preset / One-time / Advanced (cron). Each switches the body:

- **Preset**: Hourly / Daily / Weekly / Monthly + matching sub-controls (time picker, day picker, etc.)
- **One-time**: native datetime-local picker
- **Advanced (cron)**: monospace input with debounced (300ms) call to `validateCron`; shows "Will fire at: ..." preview or red error message.

Preview always uses `validateCron` for both presets (after client-side payload-to-cron) and explicit cron — single source of truth.

### Sidebar badge

Add to existing `sidebar-actions.component.ts`:

```html
<a class="action" routerLink="/automations" routerLinkActive="active" ...>
  <svg class="action-icon">...</svg>
  <span class="action-label">Automations</span>
  @if (unseenCount() > 0) {
    <span class="badge">{{ unseenCount() }}</span>
  }
</a>
```

`unseenCount` from `AutomationStore`, driven by `automation:unseen-count-changed` events. Cleared on opening Automations page (mass-mark) or on opening a specific spawned session.

### Session-list clock-icon adornment

Renderer queries `getSpawnedSessionMap({ instanceIds })` once on dashboard load, refreshes on `automation:run-updated`. The session list component reads:

```ts
link = computed(() => this.automationStore.spawnedMap().get(this.session().id));
showClock = computed(() => !!this.link());
clockClass = computed(() => this.link()?.seen === false ? 'clock-blue' : 'clock-gray');
```

```html
@if (showClock()) {
  <svg class="session-clock" [class.unread]="!link()!.seen">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>
}
```

Clicking marks the run seen via `markRunsSeen({ runIds: [link.runId] })` if currently unread.

## 11. Edge cases & failure modes

### 11.1 Clock / time

| Scenario | Behavior |
|---|---|
| DST spring forward — daily at 2:30am on transition day | Fires day before & after; on transition day no fire (no 2:30 exists). Tooltip on time picker. |
| DST fall back — daily at 1:30am | Fires once (second 1:30 silently skipped). |
| User changes system timezone | Each automation stores its own IANA tz. Schedule keeps firing in its configured tz. Detail panel shows tz. |
| System clock jumped forward (NTP / manual) | Croner re-arms for new "now". Missed fires handled by catch-up on next sweep. |
| System clock jumped backward | Clock-backward dedupe (`scheduledAt <= last_fired_at`) prevents double-fire. |

### 11.2 Schedule pathologies

| Scenario | Behavior |
|---|---|
| Cron that can never fire (`0 0 31 2 *`) | Form blocks save with "This schedule will never fire." |
| `oneTime` already in the past at create | Confirm warning. If proceeded: per `missed_run_policy` on next sweep. |
| Weekly with zero days selected | Zod `min(1)` blocks save. |
| Monthly day-of-month=31 | Inline note: "Skips months with fewer than 31 days." |

### 11.3 External dependencies

| Scenario | Behavior |
|---|---|
| Working directory deleted | Run fails with path in error message. Automation stays active. |
| Working directory permission lost | Same as above. |
| Workflow template deleted while referenced | N/A in MVP — no automation can reference a workflow template (workflow action is Phase 2). Reference-probe registration moves to Phase 2 alongside the workflow action. |
| All providers offline | Run fails. Automation continues; next fire retries. |
| Provider auth expired | Same as above. |
| Provider rate-limited | Run fails. No auto-retry. |
| `forceNodeId` offline | Runner pre-checks the worker-node registry *before* calling lifecycle (`src/main/instance/instance-lifecycle.ts:424-433` would otherwise log a warning and silently fall through to local execution — dangerous for unattended runs whose creds/paths only exist on the remote). If the node isn't `connected` or `degraded`, the run is marked `failed` with the node id and last-known status in the error message. |

### 11.4 Concurrency races

| Scenario | Protection |
|---|---|
| Cron and Run-now near-simultaneously | Partial unique index on `running` ensures one wins, other becomes `pending`. |
| Run-now × 3 in 100ms | First runs, second queues, third skips (`skip_reason='queueFull'`). |
| Same scheduled time fired twice (scheduler bug after restart) | `(automation_id, scheduled_at)` unique index (excluding `skipped`/`canceled` per Section 5) catches the second *real* run; runner traps the constraint error and inserts a `skipped` history row with `skip_reason='duplicate'` (now allowed because skipped rows aren't covered by the unique index). |
| Pause clicked mid-fire | Runner re-checks status after overlap-decision tx; cancels with `skip_reason='pausedDuringFire'`. |

### 11.5 Lifecycle races

| Scenario | Behavior |
|---|---|
| App crashes between spawn and persisting `instance_id` | Step A startup sweep marks run `failed`. Spawned instance reconciled by existing instance-recovery; appears as a normal session without clock-icon link. |
| Multiple Electron instances | `app.requestSingleInstanceLock()` enforces single-instance — verify in `src/main/index.ts` (Pre-flight #1). |
| App killed mid-run | Step A startup sweep marks `failed`. |
| App quit cleanly with pending run | Pending → `canceled`, `skip_reason='appShutdown'`. |

### 11.6 Edit / delete races

| Scenario | Behavior |
|---|---|
| Edit prompt while run is `running` | Edit applies; running spawn keeps old prompt. Toast: "Edit applied. Running session keeps the previous version." |
| Edit schedule while run is `pending` | Pending keeps original `scheduled_at`; future fires use new schedule. Pending promotes with the config it had when queued. |
| Delete while run is `running` | CASCADE removes run row immediately; running spawn becomes "just a normal session" (no clock icon). Confirmation modal warns. |
| Toggle `actionType` (prompt ↔ workflow) | Allowed; form re-validates the action block. Doesn't affect running spawn. |

### 11.7 Retention / history

| Scenario | Behavior |
|---|---|
| Viewing run #50 when retention prunes it | Detail page subscribes to events; row fades out without popping the user. |
| Spawned session deleted while run row references it | Run row keeps `instance_id`; lookup returns null; UI shows "Session no longer available." |

### 11.8 Schema migration

| Scenario | Behavior |
|---|---|
| First run after upgrade | New entry appended to `MIGRATIONS` in `rlm-schema.ts`; runs the `CREATE TABLE` statements. `IF NOT EXISTS` makes it idempotent. |
| Down-migration | Not supported (consistent with existing migrations). |

### 11.9 `oneTime`-after-app-closed

User creates a one-time scheduled 5 min from now, closes the app, opens it the next day. Per policy:

- `runOnce`: fires once on launch, marked `catchUp`. Parent → `completed`.
- `skip`: inserts `skipped` row with `skip_reason='missedWhileOff'`. Parent → `completed`.
- `notify`: same as skip but `skip_reason='missedNeedsAttention'`, drives the badge.

### 11.10 Resource limits

| Scenario | Behavior |
|---|---|
| Disk full during attachment staging | Staging fails before save. Form shows error. |
| DB locked | Handler retries once with backoff; second failure surfaces "Storage busy" toast. |
| Memory pressure (ResourceGovernor refuses spawn) | Run marked `failed` with governor's error. Next fire retries. |

## 12. Testing strategy

### Test seams

| Layer | Real | Mocked |
|---|---|---|
| `AutomationStore` | better-sqlite3 (`:memory:`) | — |
| `AutomationScheduler` | croner, store | runner, powerMonitor, injected `now` |
| `AutomationRunner` | store, croner | instanceManager (fake EventEmitter exposing `provider:normalized-event`, `instance:event`, `instance:removed` + `createInstance`/`terminateInstance` stubs), attachmentService |
| `CatchUpCoordinator` | store, croner | runner, settings, injected `now` |
| IPC handlers | Zod schemas, `validatedHandler` | domain singletons |
| Renderer store | Angular signals | IPC service |
| Components | TestBed | store fakes |

The clock is injected (`now: () => number`) wherever timing matters. No direct `Date.now()` calls in production automation code.

### Coverage focus areas

- `automation-store.ts` — partial-index enforcement, CASCADE, retention prune, JSON round-trip, migration idempotence (target 100%)
- `automation-runner.ts` — full overlap matrix, dispatch branches, queue promotion, all cancellation paths, dedupe, late-fire guard (target 90%+)
- `catch-up-coordinator.ts` — three policies × three schedule kinds × edge cases (target 90%+)
- `automation-scheduler.ts` — payload-to-cron mapping, activate/deactivate/reschedule, suspend/resume hand-off (target 80%+)
- IPC handlers — Zod-rejection paths cheap; aim 90%+
- Components — schedule picker validation states, form submission, detail page run-now states, badge rendering (target 70%+)

### Integration tests

End-to-end-within-main-process tests wiring real store + croner + fake `InstanceManager` (real EventEmitter exposing `createInstance`/`terminateInstance` stubs):

- Create automation, advance mock clock, run inserted, dispatch called
- Two rapid scheduled fires → first runs, second queues, third skips
- Pause during running run → pending cleared, no further fires
- Crash simulation → restart → step A reconciles, step C catches up
- **Run succeeded** — fake instance fires `instance:event` with `busy` → fake `provider:normalized-event` carrying assistant output → fake `instance:event` with `idle` → run terminalizes as `succeeded`
- **Run failed (terminal status)** — fake `instance:event` with `error`/`failed`/`terminated` → run marked failed with `failureClass`
- **Run failed (interactive wait)** — fake `instance:event` with `waiting_for_input` or `waiting_for_permission` → run marked failed with the interactive-input message; instance.terminate called
- **`instance:removed` before terminal status** — run marked failed with "Instance removed before completion"
- **forceNodeId pre-check** — runner skips dispatch and marks run failed when registry says node is offline (no lifecycle call attempted)
- **Duplicate skip insertion** — partial unique index now allows skipped rows alongside the (potentially-existing) running row for the same `(automation_id, scheduled_at)`
- *(Workflow action tests deferred to Phase 2.)*

### Out of MVP testing

- Real Electron `powerMonitor` (verified by handler unit tests + manual smoke)
- Real OS-level cron timing across DST (croner's own suite covers this)
- Playwright E2E (project doesn't have it wired today; manual smoke checklist used)

### Manual smoke checklist (pre-merge)

- [ ] Create daily automation; appears in list and detail
- [ ] Run-now from detail; spawned instance has the prompt
- [ ] Clock icon appears on spawned session in dashboard
- [ ] Open spawned session; clock turns gray
- [ ] Pause; no new fires
- [ ] Edit schedule; next-fire updates
- [ ] Delete; CASCADE works; spawned session survives
- [ ] Force missed-run scenario by editing `last_fired_at` in DB; restart; verify policy applies
- [ ] Cron-mode form: invalid expression blocks save
- [ ] Cron-mode form: valid expression shows next 5 fires

### Test execution

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test -- src/main/automations          # focused
npm run test                                   # full suite pre-merge
```

## 13. Phasing / MVP cut

### Sub-phase order

| Phase | Slice |
|---|---|
| 1.1 | Schema + `AutomationStore` + `AutomationAttachmentService` (CRUD + retention + partial-index tests + ContentStore durable-write extension) |
| 1.2 | `AutomationScheduler` + croner + payload-to-cron + activate/deactivate |
| 1.3 | `AutomationRunner` with **prompt action only** + overlap/queue + dedupe + **`InstanceCreateConfig.reasoningEffort` extension** + forceNodeId pre-check + completion-detection wiring against `InstanceManager` |
| 1.4 | `CatchUpCoordinator` + startup sweep + missed-fire policy + oneTime `completed` transitions |
| 1.5 | IPC handlers + new schemas in **`packages/contracts/src/schemas/automation.schemas.ts`** + new channels in **`packages/contracts/src/channels/automation.channels.ts`** + preload bridge + **AppSettings extension** (`defaultMissedRunPolicy`) |
| 1.6 | Renderer store + sidebar badge + automations list page |
| 1.7 | Detail page + run-now + run history |
| 1.8 | Create/edit form + schedule picker + cron preview |
| 1.9 | Session-list clock-icon adornment + mark-seen wiring |
| 1.10 | *(removed — workflow action descoped to Phase 2; see Decision log Q1 update and v7 revision history. Phase 1 tooling and form leave the discriminated-union shape so Phase 2 is additive.)* |
| 1.11 | Manual smoke + accessibility pass + perf check on long lists |

Phase 1.10 (workflow action) was removed entirely in v7 — workflow action is now Phase 2. Phase 1.11 (manual smoke + a11y + perf) becomes Phase 1.10 in execution order.

### Effort estimate

- Backend (1.1–1.4 + 1.10): 10–12 working days
- IPC (1.5): 2 days
- Renderer (1.6–1.9): 7–9 working days
- Tests (parallel): 3–4 days incremental
- Polish + smoke (1.11): 2 days

Total: ~24–29 working days for one engineer (~5 calendar weeks).

### Phase 2 (out of MVP)

In rough priority order:

1. **Workflow action** — full restoration of `actionType='workflow'`, including:
   - Auto-advance for no-agent and agent phases (`workflow:started` / `workflow:phase-changed` / `workflow:agents-completed` triple subscription with `AdvanceContext.agentsCompleted` flag, reentrancy-guarded `completePhase()` deferral with finally-clause re-check, `runByInstance` map registered before `startWorkflow()` to catch synchronous emit)
   - Workflow-spawned instance failure handling via `instance:event`/`instance:removed`/`workflow:cancelled`
   - Terminalization-vs-persistence race fix using in-memory `runByExecution` map
   - Reference-probe registration with `WorkflowManager.removeTemplate()` to prevent orphaning
   - **Workflow template authoring** — IPC + UI for creating/importing user-defined templates (no path exists today; `registerTemplate()` is internal/test-only)
   - **Gated workflow support** — design how `gateType !== 'none'` phases interact with unattended scheduling (surface notification, pause run, allow user to resolve via UI, then resume)
   - The v6 spec sketches the auto-advance machinery (commits `7ca530a` → `88f7c85`); revive into a Phase 2 spec.
2. **Always-on background daemon** — fires when app is closed (launchd / Windows service).
3. **Desktop OS notifications** on completion.
4. **Auto-retry on failure** with exponential backoff.
5. **Action-handler registry** when a third action kind is needed.
6. **First-class Project entity** — independent product decision, not just an automations feature.
7. **Per-automation tags / color / pinned state** — UX enrichment.
8. **Quota / cost limits per automation**.
9. **Cross-automation dependencies** (one fires after another succeeds).

### Phase 3+ (speculative)

- Event triggers (file change, branch update, MCP message)
- Webhook (incoming HTTP) triggers
- Sharing / exporting automations between machines
- Outbound webhooks on completion (Slack, Discord) — possibly via existing channel system

## 14. Pre-flight verifications (during implementation)

Before merging, the implementer should confirm these (the spec was revised twice after code reviews caught earlier mismatches; these are the remaining items to confirm during build):

1. `app.requestSingleInstanceLock()` is called in `src/main/index.ts` (Section 11.5). If absent, add it.
2. better-sqlite3 has JSON1 enabled by default for `json_valid` CHECKs. (It does in the project's current build, but verify in this branch.)
3. The **preload composition** flow — confirm whether `src/preload/domains/*.preload.ts` composition is generated or hand-edited; follow the existing pattern when adding `automation.preload.ts`.
4. **`ContentStore.storeDurable()`** — Phase 1.1 adds this method (or an equivalent) so attachment writes are awaited; if a different content store is preferred for blobs, document why.
5. *(Workflow integration deferred to Phase 2 — no MVP requirement on `WorkflowManager.startWorkflow` shape.)*
6. **`InstanceManager` events**: `instance:event` (envelope shape `{ eventId, seq, timestamp, instanceId, event: { kind, status, … } }`); `provider:normalized-event` (carries `ProviderRuntimeEventEnvelope` from `publishOutput()` at `instance-manager.ts:829-861` — there is **no** `instance:output` event); `instance:removed` (bare `instanceId: string`). Listeners at `instance-manager.ts:378-417`. Envelope contract at `packages/contracts/src/types/instance-events.ts:59-65`. Use `toOutputMessageFromProviderEnvelope()` from `src/main/providers/provider-output-event.ts` to convert provider envelopes to `OutputMessage`.
7. **`InstanceLifecycleManager.createInstance(config)`** is the only creation API — there is no `createInstanceWithMessage`. Pass `initialPrompt` + `attachments` on the config to get the "create + send first message" semantic (`instance-lifecycle.ts:937` and `:1349`).
8. **`InstanceCreateConfig.reasoningEffort`** added by Phase 1.3. Lower-level CLI adapters that don't support reasoning ignore the field.
9. **`AppSettings.defaultMissedRunPolicy`** is a flat top-level field on `AppSettings` (Phase 1.5). `SettingsManager.get('defaultMissedRunPolicy')` is the access path — dotted/nested keys won't type-check (`settings-manager.ts:189`).
10. *(WorkflowManager extensions deferred to Phase 2.)*
11. **Workflow auto-advance**: deferred to Phase 2 alongside the workflow action descope (v7). Implementation guidance for Phase 2 lives in git history (`88f7c85` v6 sketch) and in the Phase 2 list (Section 13).
12. **Startup wiring** lives in `src/main/app/initialization-steps.ts` (function `createInitializationSteps()` at line 78). New automation steps are inserted **after** the existing `'IPC handlers'` and `'Event forwarding'` steps. Automation IPC handlers register inside `IpcMainHandler.registerHandlers()` (`src/main/ipc/ipc-main-handler.ts`); they look up domain singletons lazily so registration order doesn't matter for correctness, but the documented order matches existing convention.
13. **One-time long timers**: scheduler uses bounded re-arming (24h cap) instead of a single raw `setTimeout`. Verify `setTimeout` clamping behavior on the target Node/Electron version isn't tripped.

## 15. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Schema migration corrupts existing RLM DB | Low | `CREATE TABLE IF NOT EXISTS`; no ALTERs; follows existing migration pattern. |
| `croner` DST bug we hit in production | Low | Library is actively maintained; has DST test suite. |
| Adding `reasoningEffort` to `InstanceCreateConfig` breaks an unanticipated caller | Low | Optional field — additions to the config interface that existing callers omit cause no behavior change. Type-check verifies. |
| Phase 2 workflow integration discovers blockers requiring schema/IPC migration | Low | Schema and IPC keep `'workflow'` in the discriminated unions (Zod branch commented out, action_type CHECK includes both values). Phase 2 is purely additive; no migration needed unless we discover new column requirements. |
| `ContentStore.storeDurable()` extension causes regressions in existing fire-and-forget callers | Low | New method is additive; existing `store()` keeps current semantics. |
| Startup sweep slow with thousands of run rows | Low | Steps A/B are single UPDATEs; Step C is one SELECT per active automation; indexed. |
| Single-instance lock not configured | Low | One-line addition if missing (Pre-flight #1). |
| Completion detection misses some terminal transitions across providers | Medium | Integration tests exercise transitions for each adapter (`claude`, `codex`, `gemini`, `copilot`, `cursor`); fall-through `instance:removed` handler ensures no run is left tracked indefinitely. |

## 16. References

Files inspected during research:

- `src/main/persistence/rlm/rlm-schema.ts` — existing RLM schema and migration pattern
- `src/main/instance/instance-persistence.ts` — instance persistence (proves no SQL table for instances; sessions are JSON-on-disk)
- `src/main/instance/lifecycle/instance-create-builder.ts` — proves `config.metadata` not threaded into `Instance`
- `src/main/session/session-continuity.ts:1034` — proves `instance.metadata` not in `SessionState`
- `src/main/tasks/jitter-scheduler.ts` — pattern for `powerMonitor.on('resume')` handling
- `src/main/workflows/workflow-manager.ts` — existing workflow infrastructure to integrate with
- `src/renderer/app/app.routes.ts` — existing `/automations` placeholder route to replace
- `src/renderer/app/features/dashboard/sidebar-actions.component.ts` — sidebar entry for badge
- `src/shared/types/instance.types.ts:207-360` — `Instance` and `InstanceCreateConfig` shapes
- `src/renderer/app/core/services/ipc/instance-ipc.service.ts` — `createInstanceWithMessage` config shape
- `src/main/instance/instance-manager.ts:378-399` — real event-emitter forwarding (post-revision)
- `src/main/instance/instance-event-aggregator.ts` — confirmed *not* an EventEmitter (post-revision)
- `src/main/instance/instance-lifecycle.ts:403-433` — `forceNodeId` resolution behavior (post-revision)
- `src/main/session/content-store.ts` — actual content-store API surface (post-revision)
- `src/shared/types/settings.types.ts:18` — `AppSettings` extension target (post-revision)
- `packages/contracts/src/schemas/instance.schemas.ts` — IPC schema location pattern (post-revision)
- `packages/contracts/src/types/instance-events.ts` — `InstanceEventEnvelope`/`InstanceEvent` contract (v3)
- `src/main/instance/instance-manager.ts:378-417` — real `instance:event` / `provider:normalized-event` / `instance:removed` forwarding (v3, refined v4)
- `src/main/providers/provider-output-event.ts` — `toOutputMessageFromProviderEnvelope()` for converting provider envelopes (v4)
- `src/main/instance/instance-lifecycle.ts:937,1349-1377` — confirmed only `createInstance` exists; `initialPrompt` flow + failure path (v3)
- `src/main/core/config/settings-manager.ts:189` — `keyof AppSettings` typing (v3)
- `src/main/app/initialization-steps.ts:78` — actual startup wiring (v3)
- `src/main/workflows/workflow-manager.ts:122,159,199-201,345` — `startWorkflow`, `completePhase`, `workflow:completed`/`workflow:agents-completed` (v3)

## 17. Revision history

### v7 — 2026-04-27 (post sixth code-review)

User did a sixth deep review against the v6 spec and identified three P1 + two P2 issues plus a structural concern about workflow template availability. Verified all findings against the codebase. The major change: **workflow action descoped from MVP to Phase 2**. Two prompt-run issues fixed. Two infrastructure issues spelled out.

| # | Issue | Resolution |
|---|---|---|
| Major | Workflow MVP keeps producing new bugs (P1 in five consecutive reviews) AND has no usable template path: built-in templates all have non-`none` gates and the app exposes no UI/IPC to create custom templates (`registerTemplate()` is internal/test-only). | **Workflow action descoped to MVP**. Section 7 dispatch is now prompt-only. Workflow auto-advance subsection collapsed to a "Phase 2" pointer with a list of the design considerations from v5/v6 (preserved in git history at `7ca530a` / `c1860d7` / `b35db51` / `88f7c85`). Workflow run-tracking maps (`runByInstance`, `runByExecution`, `advancingExecutions`) and the terminalization-vs-persistence-race subsection removed. Decision log Q1 updated. Phase 2 list elevates "Workflow action" to item #1, including template authoring + gated workflow support as dependencies. The DB schema CHECK keeps `'workflow'` in the action_type enum so Phase 2 is purely additive (Zod schema layer rejects it for now via commented-out branch). |
| P1.A | (workflow) Agent phase completion lost during guarded advance — the v6 follow-up retry passed `agentsCompleted: false` and the agent-completed event was dropped during the guard window | Resolved by descoping workflow from MVP. (For Phase 2, the fix is to pass `agentsCompleted: true` in the finally re-check since `completePhase()` awaits `launchPhaseAgents()` and `agents-completed` has fired by the time we re-check.) |
| P1.B | (workflow) Workflow runs ignore instance failure/removal — `instance:event`/`instance:removed` handlers only check `trackingByInstance` (prompt runs); workflow runs use `runByInstance` and were unhandled | Resolved by descoping workflow from MVP. (For Phase 2: extend the instance-event handlers to also check `runByInstance` and terminalize the corresponding workflow run; subscribe to `workflow:cancelled` from `workflow-manager.ts:484`.) |
| P1.C | Permission/input waits can leave prompt runs running forever — `waiting_for_input` and `waiting_for_permission` are durable interactive states that aren't currently terminal in the runner | `instance:event` handler now treats `waiting_for_input` and `waiting_for_permission` as failure states with a clear error message ("Automation halted in '\<status\>' — interactive input/permission required. Enable yolo on this automation, narrow its agent profile, or re-run manually."). Best-effort `terminateInstance()` call to free the queue. The InstanceStatus enum note in Section 7 lists the new terminal statuses. |
| P2.A | Resume sweep API has no suspend timestamp source — `runResumeSweep(resumedAt)` doesn't carry the suspend time, but Step C references `suspendedAt` directly | Scheduler now subscribes to **both** `powerMonitor.on('suspend')` and `powerMonitor.on('resume')`; captures `suspendedAt` on suspend, passes `{ suspendedAt, resumedAt }` to `runResumeSweep()`. Coordinator uses `suspendedAt ?? (resumedAt - 10min)` heuristic fallback for missed-suspend cases (first wake, powerMonitor not yet wired). API signature updated. |
| P2.B | New contract subpaths need export and alias updates — adding `@contracts/schemas/automation` and `@contracts/channels/automation` requires five-place sync per project AGENTS.md "Packaging Gotchas" | Section 9 expanded with the explicit five-place checklist: `packages/contracts/package.json` exports, `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts` (the load-bearing one for the packaged app), and `vitest.config.ts`. Marked as a Phase 1.5 implementation requirement. |

### v6 — 2026-04-26 (post fifth code-review)

User did a fifth deep review against the v5 spec and identified two P1 + one P2 + one P3 issue; all verified and addressed:

| # | Issue | Resolution |
|---|---|---|
| P1.A | Agent phases never auto-advance — `advanceIfPossible()` returns whenever `phase.agents` is truthy, including when called from the `workflow:agents-completed` handler. So agent phases wait for the event, receive it, then immediately bail out without calling `completePhase()`. | Added `AdvanceContext` parameter with an `agentsCompleted` boolean. The agents-truthy skip now applies only when `!ctx.agentsCompleted` — `workflow:started` and `workflow:phase-changed` set false (correctly skipping pre-agent phases), `workflow:agents-completed` sets true (correctly advancing past finished agent phases). |
| P1.B | The reentrancy guard drops the next phase's auto-advance: `workflow:phase-changed` is emitted from inside `completePhase()` *before* it returns (verified at `workflow-manager.ts:206`), so when the listener calls `advanceIfPossible()` the `advancingExecutions` flag is still set and the new phase is dropped. No-agent → no-agent transitions stall. | After the deferred `completePhase()` resolves and the `finally` clears the flag, the spec now performs a follow-up call: it queries `workflowManager.getCurrentPhase(executionId)`, checks the workflow is still running, and re-invokes `advanceIfPossible()` for the new phase. Agent → no-agent and no-agent → no-agent transitions both work; agent → agent transitions also work because the next phase's agent run will trigger `workflow:agents-completed` on its own. |
| P2 | Fast all-no-agent workflows can race DB persistence: auto-advance can fire `workflow:completed` before `dispatch()`'s caller has written `workflow_execution_id` to the run row. A terminalization handler that queries `automation_runs.workflow_execution_id` would miss the row. | Section 7 now has explicit "Avoiding the workflow terminalization-vs-persistence race" subsection with a `handleWorkflowTerminal()` sketch that resolves `runId` via the in-memory `runByExecution` (with `runByInstance` fallback) — *not* by DB query. The DB write of `workflow_execution_id` becomes a read-path-only convenience for history views. |
| P3 | Pre-flight item #11 still said Phase 1.10 wires `workflow:agents-completed` only — stale vs. the v5 design's three-event subscriptions. | Pre-flight #11 expanded to call out all three subscriptions, the `agentsCompleted` context parameter, the pre-`startWorkflow()` mapping registration, and the finally-clause re-check. |

### v5 — 2026-04-26 (post fourth code-review)

User did a fourth deep review against the v4 spec and identified two P1 + two P2 + one P3 issue; all verified and addressed:

| # | Issue | Resolution |
|---|---|---|
| P1.A | `workflow:started` is emitted **synchronously** inside `startWorkflow()` (`workflow-manager.ts:141`), so any tracking mapping registered after the call returns misses it; for no-agent first phases nothing else fires and the run stalls | Workflow dispatch now registers `runByInstance.set(instance.id, run.id)` **before** calling `startWorkflow()`. Auto-advance handlers look up by `execution.instanceId` first, falling back to `execution.id` for events that fire after we have the executionId mapping. |
| P1.B | `phase.agents.length > 0` is a type error — `WorkflowPhase.agents` is `{ count, agentType, prompts, parallel }`, an object not an array (`workflow.types.ts:36-41`) | Auto-advance helper now uses `if (phase.agents) return` (truthy presence check). Comment in spec cites the type definition. |
| P2.A | The form filter excludes any template with any gated phase, but every existing built-in template (`feature-development`, `issue-implementation`, `pr-review`, `repo-health-audit`) contains at least one non-`none` gate — workflow action would have an empty/disabled dropdown out of the box | Spec now explicit: built-in templates appear in the dropdown disabled with a tooltip explaining the gated phase ids; user-defined gate-free templates are the path. Empty-state with "Create a custom workflow" link. Phase 2 ("Gated workflow support in automations") would unlock the built-ins. |
| P2.B | Auto-advance can re-enter `completePhase()` synchronously: `workflow:phase-changed` listener can call `completePhase()` while the original `completePhase()` is still inside its emit path, before persistence | `advanceIfPossible()` now uses `queueMicrotask()` to defer the call AND a `Set<executionId>` advancing-guard flag to prevent duplicate scheduling. The flag clears in a `finally` block. |
| P3 | Stale doc lines: responsibilities (line 535), action dispatch text (line 585), test seams (line 1321), Phase 1.10 row (line 1433) still mentioned `InstanceLifecycleManager` directly or only `workflow:agents-completed` | All four lines updated to reflect v4+v5 reality. |

### v4 — 2026-04-26 (post third code-review)

User did a third deep review against the v3 spec and identified three P1 + three P2 issues; all verified and addressed:

| # | Issue | Resolution |
|---|---|---|
| P1.A | `instance:output` is not a real `InstanceManager` event — `publishOutput()` emits `provider:normalized-event` (carrying a `ProviderRuntimeEventEnvelope`) | Section 7 completion-detection rewritten to subscribe to `provider:normalized-event` and call `toOutputMessageFromProviderEnvelope()` (`src/main/providers/provider-output-event.ts`; usage pattern at `channel-message-router.ts:1471-1474`) to convert envelopes into `OutputMessage` for the assistant-output check. |
| P1.B | Runner depends on `InstanceLifecycleManager`, but it's `private` inside `InstanceManager` (`instance-manager.ts:116`) with no public accessor | Runner now uses `InstanceManager.createInstance(config)` and `InstanceManager.terminateInstance(id, graceful)` (public wrappers at `instance-manager.ts:951,955`). The `instanceLifecycle` dep was removed from the runner's `initialize()` signature; `instanceManager` is the single integration point for both events and lifecycle calls. |
| P1.C | Workflow auto-advance only fired on `workflow:agents-completed`, but `startWorkflow()` only launches agents `if (firstPhase.agents)` — no-agent gate-free phases would stall the automation immediately after `workflow:started` | Section 7 workflow auto-advance now subscribes to **three** events: `workflow:started`, `workflow:phase-changed`, and `workflow:agents-completed`. Single `advanceIfPossible()` helper called from each: skips when phase has agents (lets `workflow:agents-completed` handle it), advances immediately for no-agent no-gate phases. Form filtering inspects every phase's `gateType`, not just the first. |
| P2.A | Catch-up `since`/`until` defined only for resume sweep, not startup | Section 8 Step C now has an explicit table: startup uses `since = automation.lastFiredAt ?? automation.createdAt` and `until = now()`; resume uses `since = suspendedAt`, `until = resumedAt`. Code sketch made the conditional explicit. |
| P2.B | Scheduler declared `Map<string, Cron>` but one-time path stored `wrapTimerAsCronShim(...)`; type unsafe | Defined a real `ScheduleHandle` interface with two implementations (`CronHandle`, `OneTimeHandle`); `OneTimeHandle.reArm()` swaps timers without churning the map entry. Removed `wrapTimerAsCronShim`. |
| P2.C | Attachment encoding underspecified — `ContentStore.store()` takes `string` and hashes UTF-8, but spec said handler decodes data URLs to bytes | Spec now explicit: store the **raw data URL string** as-is (no Buffer/Uint8Array path). Lossless round-trip; no `ContentStore` API change needed beyond the durability extension. Section 5 updated. |

### v3 — 2026-04-26 (post second code-review)

User did a second deep review against the codebase and identified four P1 + three P2 issues; all verified and addressed:

| # | Issue | Resolution |
|---|---|---|
| P1.A | Completion detection used wrong `InstanceEventEnvelope` shape (`envelope.kind` vs. real `envelope.event.kind`); treated `instance:removed` as an envelope (real payload is bare `instanceId: string`) | Section 7 completion-detection block rewritten with correct shape. `instance:removed` handler accepts `instanceId: string`. |
| P1.B | `busy → idle` is unsafe success signal — adapter spawn-and-send paths emit `busy, idle` before send rejects, so naive watcher would falsely succeed | Success signal now requires both an `instance:output` event with `type === 'assistant'` AND a subsequent `idle` transition. Two-flag tracking state (`sawAssistantOutput`, `awaitingPostOutputIdle`). |
| P1.C | `InstanceLifecycleManager.createInstanceWithMessage()` doesn't exist — only `createInstance(config)`; create-with-message semantic uses `initialPrompt`/`attachments` on the config | Section 7 dispatch updated to call `createInstance({ ...config, initialPrompt: prompt, attachments })` for the prompt branch; workflow branch unchanged (already used `createInstance` without prompt). |
| P1.D | `settings.get('automations.defaultMissedRunPolicy')` won't type-check — `SettingsManager.get` is keyed by `keyof AppSettings`, not dotted paths | Settings key is now flat: `defaultMissedRunPolicy` on `AppSettings`. Catch-up coordinator calls `settings.get('defaultMissedRunPolicy')`. |
| P2.A | Workflow `workflow:completed` only fires after `completePhase()` reaches the end; `startWorkflow()` doesn't auto-advance, so an unattended automation would hang after the first phase | Added "Workflow auto-advance for unattended runs" subsection in Section 7. Runner subscribes to `workflow:agents-completed` and auto-calls `completePhase()` for `gateType === 'none'` phases. Form filters template dropdown to no-gate templates only; gated templates disabled with tooltip. Future Phase-2 item: gated workflow support. |
| P2.B | Startup wiring described in `src/main/index.ts` with IPC last; actual bootstrap is `createInitializationSteps()` in `src/main/app/initialization-steps.ts` and IPC registers first | Section 4 startup-wiring tree rewritten to match `initialization-steps.ts:78-134`. Automation steps inserted in the correct order (after IPC and event-forwarding). Note added that handlers can register before singletons since lookups are lazy. |
| P2.C | `oneTime` `setTimeout` for far-future schedules (weeks/months) is unreliable | Section 6 one-time path rewritten to use a bounded re-arming timer (cap 24h) backed by persisted `next_fire_at`. Process restart mid-wait is handled by catch-up sweep. |

### v2 — 2026-04-26 (post code-review)

User reviewed v1 against the actual codebase and identified nine issues (five P1, four P2). All were verified against the source and the spec was revised:

| # | Issue | Resolution |
|---|---|---|
| P1.1 | Workflow dispatch called `workflowManager.start({ ... })` — real API is `startWorkflow(instanceId, templateId)` requiring an existing instance | Section 7 dispatch updated to spawn-then-start with rollback on failure. Instance is created via lifecycle, then `startWorkflow(instance.id, templateId)` is called. |
| P1.2 | Subscribed to events that don't exist (`instance:idle-after-output`, etc.) on `InstanceEventAggregator` (which isn't an EventEmitter) | Section 7 completion detection rewritten to subscribe to `InstanceManager.on('instance:event', ...)` with `InstanceEventEnvelope` inspection. Status transitions (`busy → idle`, `error`/`failed`/`terminated`) drive run terminalization. |
| P1.3 | `reasoningEffort` and `yoloMode` not plumbed; `model` named `modelOverride` in `InstanceCreateConfig` | Section 7 dispatch uses `modelOverride`; Phase 1.3 adds `reasoningEffort` to `InstanceCreateConfig`. Runner calls lifecycle directly (not via IPC), so the renderer's IPC schema doesn't constrain the runner. |
| P1.4 | `forceNodeId` offline silently falls through to local execution per `instance-lifecycle.ts:424-433` — spec said "run fails" | Runner now pre-checks the worker-node registry before dispatching; fails the run if forced node is unreachable rather than allowing silent fall-through. Section 11.3 updated. |
| P1.5 | Unique index `(automation_id, scheduled_at) WHERE trigger IN ('scheduled','catchUp')` blocks the duplicate-skip history row | Index revised to also exclude `status IN ('skipped','canceled')`. Skip markers can be inserted; real-fire uniqueness preserved. |
| P2.6 | Attachments assumed `OutputStorageManager` API that doesn't exist; `ContentStore.store()` is fire-and-forget | Replaced with new `AutomationAttachmentService` wrapping `ContentStore` plus a `storeDurable()` extension that awaits the disk write. Schema column changed from `storage_ref` to `content_ref_json` storing the full `ContentRef`. |
| P2.7 | One-time `completed` transitions inconsistent across Sections 6 / 8 / 11.9 | Section 6 added a per-outcome table; catch-up coordinator now explicitly transitions oneTime → `completed` for `skip`/`notify` policies. |
| P2.8 | Schemas/channels in spec pointed at non-existent `src/shared/validation/ipc-schemas.ts`; no `AppSettings` extension call-out | Section 9 updated: schemas in `packages/contracts/src/schemas/automation.schemas.ts`, channels in `packages/contracts/src/channels/automation.channels.ts`, `AppSettings.defaultMissedRunPolicy` extension flagged in Phase 1.5. |
| P2.9 | Workflow-template deletion guard was UI-only; `WorkflowManager.removeTemplate()` blindly deletes from memory | `WorkflowManager.registerReferenceProbe()` API added (Phase 1.10); automations domain registers a probe at startup; `removeTemplate()` consults probes and returns `{ removed: false, reason }` when references exist. UI surfaces the rejection. |
