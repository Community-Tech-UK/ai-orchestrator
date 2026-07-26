# New-session Fast toggle specification

Status: Completed and verified

Implementation plan: [2026-07-26-new-session-fast-toggle_plan_completed.md](../plans/2026-07-26-new-session-fast-toggle_plan_completed.md)

## Goal

Let a user choose Fast mode before starting a new Claude or Codex session from the welcome composer.

## Design

The draft toolbar gains a `FAST ON/OFF` button beside the existing YOLO control. It is visible only when the selected provider is Claude or Codex, matching the live-session header's support rule.

The button reads and writes `ProviderStateService`'s existing per-provider Fast preference. This makes the selection provider-scoped, restores it when the user switches back to a provider, and persists it through the existing `defaultFastModeByProvider` setting. `InstanceListStore` already resolves this same preference into the create payload, so no new IPC field, backend behavior, or draft persistence schema is required.

For a local-model target or any unsupported provider, the control is hidden and session creation continues to use the existing resolver behavior.

## Acceptance criteria

1. The new-session composer shows `FAST ON/OFF` for Claude and Codex.
2. The control is hidden for unsupported providers and local-model targets.
3. Clicking the control updates the selected provider's remembered Fast preference.
4. Switching between Claude and Codex displays each provider's remembered preference.
5. A newly created session receives the selected Fast value through the existing create path.
6. The control is keyboard accessible as a native button and exposes an explanatory title.

## Verification

- Focused renderer component tests cover visibility, state, and toggling.
- Existing and focused instance-list store tests cover create-payload forwarding.
- Canonical TypeScript, lint, LOC, and test gates run before completion.

## As built

- Added a native `FAST ON/OFF` button beside YOLO in the draft composer.
- Limited the control to Claude and Codex; unsupported providers and local-model targets hide it.
- Reused `ProviderStateService` for provider-scoped state and persistence.
- Kept the existing instance creation resolver as the only create-payload path.
- Added real-template tests for toggle behavior, provider switching, unsupported providers, and local-model targets, plus store coverage for the remembered Codex Fast value.
- Final canonical gates passed on 2026-07-26: production and spec TypeScript, lint, max-LOC, and the full quiet test suite.
- Independent completion gate returned `VERDICT: PASS` with no unresolved findings.
