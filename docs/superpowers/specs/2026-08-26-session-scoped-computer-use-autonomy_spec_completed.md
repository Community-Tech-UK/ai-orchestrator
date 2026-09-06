# Session-Scoped Computer Use Autonomy ("Super YOLO") — Specification

**Status:** COMPLETED (2026-08-27). Implemented and independently gated; rebuilt-app checks are
deferred to the livetest document linked from the completed plan.
**Implementation plan:** [2026-08-26-session-scoped-computer-use-autonomy_plan_completed.md](../plans/2026-08-26-session-scoped-computer-use-autonomy_plan_completed.md)
**Date:** 2026-08-26
**Owner:** James

## 1. Problem

`computerUseAutonomyLevel` (shipped 2026-08-26) is a **global** setting. To let an agent drive
Harness's own UI — the thing that unblocks several pending livetest checks — the only lever today is
setting it globally to `unrestricted`.

That is the wrong shape for the capability, for one specific reason. Harness's own window renders
the Computer Use grant approvals and the browser approval prompts. Global `unrestricted` means
**every** agent in **every** session, indefinitely, can click them. Each such click is recorded as an
ordinary approval, so the grant table and browser audit keep reporting human decisions that no human
made. The elevation becomes ambient and invisible after the fact.

James's proposal — *"maybe I can manually put a session into super-yolo mode"* — fixes exactly that.
An elevation he sets on one session is a deliberate, attributable, bounded act.

## 2. Goal

Let James raise one session's Computer Use autonomy above the global default, deliberately, with the
elevation visible in the UI and attributable in the audit log, and gone when the session ends.

## 3. Non-goals

- Changing the global `computerUseAutonomyLevel` semantics or its default (`trusted`).
- Changing OS-level TCC. Accessibility and Screen Recording still need a human at the macOS prompt.
- Changing the existing CLI `yoloMode` (tool-call auto-approval). This is a separate axis: `yoloMode`
  governs the provider CLI's own permission prompts, this governs desktop control. The name
  "super YOLO" is James's shorthand, not a coupling.

## 4. Design

### 4.1 A per-instance override, resolved against the global default

Add `computerUseMode?: ComputerUseAutonomyLevel` to `Instance`, following the established
`browserToolsMode` convention where **`undefined` means "the global setting decides"**.

Resolution is a pure function, mirroring `resolveBrowserToolsMode()`:

```ts
resolveComputerUseAutonomy(perInstance, globalLevel) => perInstance ?? globalLevel
```

The override may raise or lower the effective level. A session override of `guarded` while the
global is `unrestricted` is accepted and recorded. This spec's purpose is elevation, but a plain
override in either direction is less surprising and lets the user deliberately constrain one
session without changing the global default.

### 4.2 Registry, not spawn state

`DesktopGatewayService` holds no instance state, exactly like `SpawnConfigBuilder`. Use the
established registry pattern (`hardened-mode-scoping.ts`, `browser-tool-scoping.ts`,
`contained-execution-scoping.ts`):

- `setInstanceComputerUseMode(instanceId, mode | undefined)`
- `getInstanceComputerUseMode(instanceId)`
- `removeInstanceComputerUseMode(instanceId)`
- `_resetComputerUseScopingForTesting()`
- bounded at `MAX_ENTRIES = 1000` with LRU-ish eviction, as its three siblings are.

`InstanceManager` already clears the sibling registries on removal at
`instance-manager.ts:674`; this one joins that line.

### 4.3 No respawn needed

Unlike `yoloMode` — which changes CLI spawn arguments and therefore requires a respawn or a queued
apply-on-idle — this setting is read by the desktop gateway **per decision**
(`DesktopGatewayService.autonomyLevel()`). Toggling it takes effect on the very next Computer Use
call, mid-turn, with no session disruption. The UI should say so.

### 4.4 The elevation is not persisted

`computerUseMode` lives in the in-memory registry and on the live `Instance`. It is **not** restored
by `history-restore-coordinator`, and a restarted app comes back at the global default.

This diverges from `browserToolsMode`, deliberately. This is a self-approval-capable elevation: it
should require a fresh human act after a restart rather than silently surviving one. The cost is
re-arming a session after a restart, which is a click.

**Resolved decision (D1):** do not persist. James requested implementation of the linked plan, and
the plan's documented recommendation was selected under the project's decision-autonomy rule.

### 4.5 Attribution

Two requirements, because the entire point is that the audit stays honest:

1. Every Computer Use audit row already carries `instanceId`. Add the resolved level **and its
   source** (`'global'` or `'session'`) to the metadata for any action that a lower level would have
   refused — the same shape already used for the existing denial rows.
2. Setting the override writes its own audit row: instance, previous level, new level, and that it
   came from the UI. Without this, a session elevation is itself unattributable, which would
   reproduce the problem at one level up.

### 4.6 Agents cannot elevate themselves

The IPC channel that sets the override is a **trusted-renderer** channel, like the existing
`copilot-account:*` domain. It is not exposed on the MCP tool surface, not settable via
`$AIO_MCP settings`, and not reachable from `orchestrator-tools`.

This is the load-bearing constraint. A session that can elevate itself is not session-scoped; it is
`unrestricted` with extra steps, and the audit trail would again describe a decision no human made.

### 4.7 Surface

A control beside the existing YOLO toggle in `instance-header.component.html:212`. It must:

- show the **effective** level and whether it came from this session or the global default;
- be visually distinct when elevated above the global default — this is the state where an agent can
  click the app's own approval prompts, and it should not be quiet;
- state that it takes effect immediately and ends with the session.

## 5. Acceptance

1. With global `trusted` and no override, a session resolves `trusted`.
2. With global `trusted` and a session override of `unrestricted`, that session resolves
   `unrestricted` and *other live sessions still resolve `trusted`*.
3. The Harness app is reachable at a session's `unrestricted` and denied in a sibling session at the
   same moment.
4. Toggling the override changes the next Computer Use decision with no respawn and no interruption
   to an in-flight turn.
5. Removing the instance clears the registry entry; a later instance reusing the id inherits nothing.
6. The override is unreachable from the MCP tool surface and from `$AIO_MCP settings set`.
7. Setting the override writes an audit row naming the previous and new level.
8. An action permitted only because of a session override is distinguishable in the audit log from
   one permitted by the global level.
9. After an app restart, a restored session is back at the global default (per D1).

## 6. Risks accepted

- A session at `unrestricted` can approve its own Computer Use and browser prompts. That is the
  point; §4.5 makes it attributable rather than preventing it.
- Two sessions can hold different levels simultaneously. Intended, and acceptance item 3 pins it.
