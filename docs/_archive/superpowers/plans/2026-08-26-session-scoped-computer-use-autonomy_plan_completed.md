# Session-Scoped Computer Use Autonomy ("Super YOLO") — Implementation Plan

**Status:** COMPLETED (2026-08-27). Every agent-runnable check passed and the fourth fresh
completion-gate review returned `VERDICT: PASS` with no actionable findings. Rebuilt-app checks are
deferred to
[2026-08-26-session-scoped-computer-use-autonomy_plan_livetest.md](./2026-08-26-session-scoped-computer-use-autonomy_plan_livetest.md)
and are **not** claimed as verified.

**Date:** 2026-08-26
**Spec:** [2026-08-26-session-scoped-computer-use-autonomy_spec_completed.md](../specs/2026-08-26-session-scoped-computer-use-autonomy_spec_completed.md)

**Goal:** Let James raise one session's Computer Use autonomy above the global default, deliberately,
visibly, and attributably, without touching any other session.

**Architecture:** A per-instance `computerUseMode` override resolved against the global setting by a
pure function, held in an in-memory scoping registry alongside its three siblings, read per decision
by `DesktopGatewayService` so no respawn is needed, and settable only from a trusted-renderer IPC
channel.

**Tech stack:** Electron main, TypeScript, Zod 4, Angular 22 signals + standalone components, Vitest.

## Global constraints

- The global default (`trusted`) and the existing level semantics do not change.
- No agent-reachable route may set the override — not MCP tools, not `$AIO_MCP settings`.
- Toggling must not require a respawn or disturb an in-flight turn.
- Do not commit unless James asks.

## Verified findings that shape this plan

Read from source on 2026-08-26; implement against these where they conflict with intuition.

- **F1 — every Computer Use call already carries a validated instance id.**
  `desktop-gateway-rpc-server.ts:132` rejects any call whose `instanceId` fails
  `isKnownLocalInstance()`, and `:241` rejects a missing one. So the override can be resolved at the
  decision point with no new plumbing and no "unknown instance" fallback path to design.
- **F2 — the registry pattern is established three times over.** `browser-tool-scoping.ts`,
  `hardened-mode-scoping.ts` and `contained-execution-scoping.ts` are the same shape: a bounded
  `Map`, a `set/get/remove`, a `_resetForTesting`, written from the create path and cleared together
  at `instance-manager.ts:674`. Follow it exactly; do not invent a fourth shape.
- **F3 — `resolveBrowserToolsMode()` (`browser-tool-scoping.ts`) is the precedent for the pure
  resolver**, including the `undefined` = "global decides" convention.
- **F4 — this does NOT need the yoloMode machinery.** `yoloMode` changes CLI spawn args, which is why
  it needs `requestYoloModeToggle()` and its queued apply-on-idle
  (`instance-manager.ts:1502`). `DesktopGatewayService.autonomyLevel()` re-reads per decision, so a
  plain setter suffices. Do not copy the queueing.
- **F5 — the audit already redacts and already carries `instanceId`.** `redactDesktopMetadata` runs
  on every row (`desktop-gateway-service.ts:723`), so adding the resolved level and its source to
  metadata is safe and needs no new redaction rule.

---

### Task 1: Type, registry and pure resolver

**Files:**
- Modify: `src/shared/types/instance.types.ts`
- Create: `src/main/instance/lifecycle/computer-use-scoping.ts` + `.spec.ts`

- [x] **Step 1: Add the field.** `computerUseMode?: ComputerUseAutonomyLevel` on `Instance`, beside
      `browserToolsMode`, with a doc comment saying `undefined` = global setting decides and that it
      is a session-lifetime elevation.
- [x] **Step 2: Write the registry**, copying the shape of `browser-tool-scoping.ts` verbatim —
      `MAX_ENTRIES = 1000`, LRU-ish re-insert on set, delete on `undefined`.
- [x] **Step 3: Add the pure resolver** `resolveComputerUseAutonomy(perInstance, globalLevel)`
      returning `perInstance ?? globalLevel`.
- [x] **Step 4: Test** the registry (set/get/remove/eviction/reset) and the resolver
      (override wins both directions; `undefined` defers; eviction does not leak an elevation).

### Task 2: Resolve per decision in the gateway

**Files:** `src/main/desktop-gateway/desktop-gateway-service.ts`, its spec

- [x] **Step 1: Take the instance id into the resolution.** `autonomyLevel()` becomes
      `autonomyLevel(context)`, reading the registry first and falling back to the validated global
      setting it already reads.
- [x] **Step 2: Thread `context` to both call sites** — `annotateApp()` (which currently has no
      context; pass it down from the listing call) and the input controller's `autonomyLevel()`
      callback, which must become per-call rather than per-construction.
- [x] **Step 3: Return the source alongside the level** (`{ level, source: 'session' | 'global' }`)
      so Task 4 can record it without resolving twice.
- [x] **Step 4: Test** that two contexts with different overrides resolve differently against one
      service instance — this is acceptance item 2 and the whole point of the feature.

### Task 3: Trusted-renderer IPC and lifecycle wiring

**Files:** `packages/contracts/src/channels/instance.channels.ts`,
`src/shared/validation/ipc-schemas.ts`, `src/main/ipc/handlers/instance-handlers.ts`,
`src/preload/domains/instance.preload.ts`, `src/main/instance/instance-manager.ts`,
`src/main/instance/instance-lifecycle.ts`, specs for each

- [x] **Step 1: Add `INSTANCE_SET_COMPUTER_USE_MODE`** plus a `Zod` payload
      (`instanceId`, `mode: ComputerUseAutonomyLevel | null`). Declare `ipcAuthToken` as optional on
      the schema — the preload stamps it and a `.strict()` schema without it rejects every call
      (this is exactly how LT-522 made 15 channels unreachable).
- [x] **Step 2: Register the handler on the trusted-renderer surface only.** Verify by inspection
      that it is absent from `orchestrator-tools` and from the settings CLI policy.
- [x] **Step 3: Expose in preload** and emit an `INSTANCE_STATE_UPDATE` so the header re-renders.
- [x] **Step 4: Write the registry from the lifecycle** where the siblings are written
      (`instance-lifecycle.ts:1235-1240`) and clear it at `instance-manager.ts:674`.
- [x] **Step 5: Test** that the handler rejects an unknown instance, an invalid mode, and a payload
      carrying `ipcAuthToken`; and that removal clears the entry.

### Task 4: Attribution

**Files:** `src/main/desktop-gateway/desktop-gateway-service.ts`,
`src/main/desktop-gateway/desktop-input-controller.ts`, specs

- [x] **Step 1: Stamp the resolved level and source** into the audit metadata of any action a lower
      level would have refused, matching the existing `autonomyLevel` metadata on denial rows.
- [x] **Step 2: Audit the elevation itself** — one row on set, with previous level, new level, and
      `decidedBy: 'user'`.
- [x] **Step 3: Test** that an action allowed only by a session override is distinguishable in the
      log from one allowed globally (acceptance item 8).

### Task 5: Persistence decision (D1)

- [x] **Step 1: Resolve D1.** Implement the plan's recommendation: do **not** persist, so a restart
      returns the session to the global default and re-arming is a deliberate act. James requested
      implementation of this plan; the documented recommendation was selected under the project's
      decision-autonomy rule rather than leaving implementation blocked on a routine confirmation.
- [x] **Step 2: If not persisted** (recommended), add a `history-restore-coordinator` test asserting
      a restored instance comes back with `computerUseMode` undefined — otherwise this silently
      starts persisting the day someone adds the field to the restore path.
- [x] **Step 3: If persisted**, mirror `browserToolsMode` through `history-manager.ts:251` and the
      two restore paths, and say so in the UI copy.
      **Not applicable:** D1 was resolved as non-persistent.

### Task 6: The control

**Files:** `src/renderer/app/features/instance-detail/instance-header.component.html` and its
component + spec

- [x] **Step 1: Add the control beside the YOLO toggle**, showing the effective level and its source.
- [x] **Step 2: Make an elevated session visually obvious** — this is the state in which an agent can
      click the app's own approval prompts.
- [x] **Step 3: Copy** must say it applies immediately, needs no restart, and ends with the session.
- [x] **Step 4: Test** the three display states (global default, session-elevated, session-lowered)
      and that the click calls the IPC method once.

### Task 7: Verification

- [x] **Step 1: Focused specs** for every acceptance item in spec §5.
- [x] **Step 2: Canonical checklist** — `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
      `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run test:quiet`.
      Read the failing-test summary line, not the exit code, when running inside a compound command.
- [x] **Step 3: Independent completion gate** until `VERDICT: PASS` with no findings.
- [x] **Step 4: Close the lifecycle**, recording rebuilt-app checks in a `_livetest.md` — at minimum:
      two live sessions resolving different levels at the same moment, and the Harness app reachable
      in the elevated one while denied in the other.

## Risks

- **Task 2 Step 2 is the awkward one.** `annotateApp()` has no `context` today, so the listing path
  needs it threaded down. If that proves invasive, resolve the level once at the top of the listing
  call and pass the resolved value, rather than reaching for a module-global "current instance",
  which would be wrong under concurrent sessions.
- Two sessions holding different levels is intended, so any caching of the resolved level must be
  per-call or keyed by instance — never a service-level field.

## As-built

- The override is stored on the live `Instance` and in a bounded in-memory registry. Lifecycle
  creation registers it, removal clears it, and history restore deliberately omits it. Native and
  replay-fallback restore tests both pin the non-persistence decision.
- The trusted-renderer setter audits the requested transition before mutating state, so an audit
  write failure cannot leave an unattributed elevation active. No setter exists on MCP,
  orchestrator-tools, or `$AIO_MCP settings` surfaces.
- Gateway policy is resolved once at each public call boundary and threaded through app policy,
  grants, observations, window activation, waits, input readiness, locking, driver completion, and
  every success or failure audit. Deferred screenshot, driver-error, and readiness-failure tests
  prove a mid-call toggle cannot rewrite the audit source after the fact.
- The renderer control is standalone and signal-driven. It distinguishes global, elevated,
  lowered, and explicit-equal session states; shows the lifecycle copy visibly; announces failures;
  and clears back to global through `null` state updates.

### Verification evidence

```
npx tsc --noEmit                       → passed
npx tsc --noEmit -p tsconfig.spec.json → passed
npm run lint                           → passed
npm run check:ts-max-loc               → passed
npm run build:main                     → passed
npm run test:quiet                     → 1,804 files / 19,186 tests passed
```

Focused service coverage finished at 44/44 tests. Earlier focused batches covered the registry,
instance lifecycle/removal and ID reuse, history restore, trusted IPC/preload, renderer state, and
the header control. Three independent gates found and drove fixes for audit atomicity, in-flight
success/failure attribution, UI state/copy, and missing lifecycle coverage. A fourth genuinely
fresh completion gate reviewed the final code and returned `VERDICT: PASS` with no actionable
findings.

Real rebuilt-app checks remain pending in
[2026-08-26-session-scoped-computer-use-autonomy_plan_livetest.md](./2026-08-26-session-scoped-computer-use-autonomy_plan_livetest.md).
