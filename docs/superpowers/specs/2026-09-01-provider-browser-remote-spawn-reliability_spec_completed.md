# Provider Browser and Remote Spawn Reliability Spec

Status: completed 2026-09-20 — implemented, independently gate-reviewed (`VERDICT: PASS`), and green on the full canonical checklist. The repository-wide closure blockers recorded below are resolved: the spec typecheck, the LOC ratchet and the full suite all pass on this tree. Superseded text follows.

Superseded status: implemented and independently verified at task scope; repository-wide closure blocked

Implementation plan: [2026-09-01-provider-browser-remote-spawn-reliability_plan_completed.md](../plans/2026-09-01-provider-browser-remote-spawn-reliability_plan_completed.md)

## Problem

A live multi-provider workflow exposed four coupled reliability defects:

1. Cursor was given the deferred Browser Gateway surface even though its MCP client did not install tools revealed after `tools/list_changed`. Search and describe therefore advertised `browser.fill_credential`, but the tool was not callable.
2. `run_on_node` could be used for work that explicitly required the coordinator-owned Browser Gateway and existing extension-shared tabs. Remote agents receive only worker-managed Chrome automation, so the spawned agent could never satisfy that request.
3. `run_on_node` returned an initializing instance before the worker completed provider startup. A Copilot account-binding rejection therefore looked like a successful child that later vanished.
4. Remote instances inherited the coordinator's remembered provider model and validated it against the coordinator catalog. A valid-but-stale Antigravity selection for another machine was sent to the Windows worker and rejected there.

## Required Behaviour

- Cursor and Codex receive Browser Gateway tools eagerly until their clients can consume dynamic MCP tool-list changes.
- `run_on_node` rejects prompts that require Browser Gateway, extension-shared Chrome, or an existing logged-in/shared tab, and explains that the caller must stay on the coordinator and target the worker through Browser Gateway.
- `run_on_node` does not report success until the spawned instance's readiness promise resolves. Worker-side provider failures propagate to the caller.
- Remote placement uses only an explicit per-spawn or agent-pinned model. It does not inherit coordinator remembered/global defaults and does not validate an explicit remote model against the coordinator's local catalog.
- Tool descriptions distinguish worker-managed Chrome from coordinator-owned Browser Gateway tabs.

## Acceptance Criteria

- Browser MCP config and lifecycle tests prove Cursor and Codex are eager while compatible providers may remain deferred.
- `run_on_node` tests prove shared-tab requests fail before instance creation and managed browser requests still spawn.
- `run_on_node` tests prove readiness rejection reaches the caller and readiness success is awaited.
- Model-selection tests and create-path integration tests prove forced/placed remote sessions omit remembered/global defaults while preserving explicit models without coordinator-catalog degradation.
- Targeted tests and all canonical project gates pass.
- A fresh completion-gate agent returns `VERDICT: PASS` with no actionable findings.

## Non-goals

- Exposing coordinator Browser Gateway sockets directly to remote LLM processes.
- Automating login or credential entry outside the existing Browser Gateway approval boundary.
- Synchronising provider credentials or model catalogues between machines.

## Verification Status (2026-09-01)

All task-specific acceptance criteria are implemented. The exact focused suite passes 212 tests across 11 files; main TypeScript, lint, `build:main`, and task-scoped whitespace validation pass. A fresh independent completion-gate review returned `VERDICT: PASS` with no task-owned findings.

The canonical repository gates are not wholly green because unrelated concurrent Browser-approval/UI work currently breaks spec TypeScript and the LOC ratchet, with additional unrelated Browser/RLM/Node 26 failures in the prior full-suite attempt. The linked plan records the exact blockers, so this spec remains `_planned` and untracked rather than being falsely closed.
