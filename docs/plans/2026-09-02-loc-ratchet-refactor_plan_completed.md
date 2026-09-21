# LOC ratchet refactor

Status: completed 2026-09-20. All three batches implemented; the independent gate returned PASS and `npm run check:ts-max-loc` is green. No live check is deferred — this is a pure refactor with no runtime surface.
Date: 2026-09-02

## Goal

69 allowlisted TypeScript files sit over their recorded ceiling (within the +50 slack). Several are at the slack wall, so the next one-line edit fails CI. Extract cohesive chunks from the largest / tightest files and re-tighten those ceilings. No behaviour change.

## Targets

Files already being edited in this working tree (`loop-coordinator.ts`, loop diagnosis UI) stay untouched.

### Batch 1

| File | Current / ceiling | Extract |
| --- | --- | --- |
| `src/main/app/initialization-steps.ts` | 1009 / 959 (+50) | Late runtime steps (Loop store through Cross-project) |
| `src/main/instance/instance-manager.ts` | 2950 / 2900 (+50) | Input-context assembly + preflight helpers |
| `src/main/cli/adapters/copilot-cli-adapter.ts` | 1271 / 1221 (+50) | Copilot JSONL event types + parsers |
| `src/main/session/session-continuity.ts` | 1849 / 1799 (+50) | Migration + conversation-history normalization |
| `src/main/workspace/git/worktree-manager.ts` | 1090 / 1040 (+50) | Cross-worktree conflict helpers |

### Batch 2

| File | Current / ceiling | Extract |
| --- | --- | --- |
| `src/main/orchestration/orchestration-handler.ts` | 1550 / 1500 (+50) | Child task-report + structured-result handlers |
| `src/main/channels/channel-message-router.ts` | 2950 / 2902 (+48) | Project grouping + named-target resolution |
| `src/main/cli/adapters/codex-app-server-notification-adapter.ts` | 749 / 699 (+50) | item/started + item/completed handlers |
| `src/main/instance/instance-lifecycle.ts` | 3569 / 3522 (+47) | Unconfirmed-resume interpretation |

## Non-goals

- Do not raise ceilings except to document a genuine leftover after a failed split.
- Do not touch dirty loop-coordinator / loop HUD files.
- Do not create branches or worktrees.

## As-built

| File | Before | After | Extract |
| --- | --- | --- | --- |
| `initialization-steps.ts` | 1009 / 959 | 329 (dropped from allowlist) | `late-runtime-initialization-steps.ts` + `cross-project-initialization-step.ts` |
| `instance-manager.ts` | 2950 / 2900 | 2669 | `instance-input-contexts.ts` |
| `copilot-cli-adapter.ts` | 1271 / 1221 | 1155 | `copilot/copilot-stream-events.ts` |
| `session-continuity.ts` | 1849 / 1799 | 1713 | `session-continuity-state.ts` |
| `worktree-manager.ts` | 1090 / 1040 | 1034 | `worktree-conflict.ts` |
| `orchestration-handler.ts` | 1550 / 1500 | 1311 | `orchestration-handler-child-ops.ts` + `orchestration-command-signature.ts` |
| `channel-message-router.ts` | 2950 / 2902 | 2662 | `channel-project-resolver.ts` |
| `codex-app-server-notification-adapter.ts` | 749 / 699 | 470 (dropped from allowlist) | `codex/codex-notification-item-events.ts` |
| `instance-lifecycle.ts` | 3569 / 3522 | 3522 | `lifecycle/resume-attempt-interpretation.ts` |
| `session-handlers.ts` | 1095 / 1045 | 843 | `session-archive-handlers.ts` |
| `instance-messaging.store.ts` | 875 / 825 | 818 | `messaging-retry-disposition.ts` |
| `instance-communication.ts` | 2745 / 2696 | 2653 | `communication-completion-cost.ts` |
| `automations-page.component.ts` | 831 / 782 | 737 | `automation-form-mappers.ts` |
| `automation-runner.ts` | 885 / 837 | 749 | `automation-runner-terminal.ts` |
| `output-stream.component.ts` | 1345 / 1297 | 1290 | context-menu helpers + compaction-recovery copy |
| `claude-cli-adapter.ts` | 2191 / 2144 | 2064 | `claude-assistant-message.ts` |
| `llm-service.ts` | 1071 / 1024 | 682 (dropped from allowlist) | `llm-service-providers.ts` |
| `consensus-coordinator.ts` | 905 / 859 | 570 (dropped from allowlist) | `consensus-synthesis.ts` |

Allowlisted slack notices: 69 -> 64 after batch 1; batch 2 drops the notification adapter from the allowlist and re-tightens the other three. Batch 3 drops `llm-service.ts` and `consensus-coordinator.ts` from the allowlist and re-tightens the remaining slack-wall parents. New modules are all under the hard 700 cap.

The `loop-coordinator.ts` 3871 -> 3948 allowlist raise was already in this dirty tree before this refactor (transport-outage seam). It is not part of this extract.

## Verification

### Batch 1
- Targeted specs for each touched module: pass
- `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`: pass
- `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`: pass
- Related call-site specs (initialization-steps, copilot, session-continuity, instance-manager context deadline, worktree, Codex wiring): pass
- Full `npm run test:quiet`: the extract-owned wiring tests that first failed were updated to read `late-runtime-initialization-steps.ts` and now pass. Remaining full-suite reds on a later independent run were dirty-tree `loop-coordinator-branch-select.spec.ts` and `loop-coordinator-rpi.spec.ts`, not this extract. `scripts/__tests__/sea-build-repeatability.spec.ts` passed on that independent run.

### Batch 2
- Targeted specs (signature, child-ops, handler, project-resolver, channel-router, resume-interpretation, item-events, Codex app-server): 8 files / 190 tests pass
- `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`: pass
- `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`: pass
- Slack notices 64 -> 61 after dropping the notification adapter from the allowlist
- Full `npm run test:quiet`: 1 of 20736 failed — `loop-coordinator-auto-unstick.spec.ts` (dirty-tree loop work, not this extract)
- Independent completion-gate still in flight; do not rename this plan `_completed` until that gate returns PASS

### Batch 3
- Targeted specs for synthesis, form mappers, retry disposition, compaction copy, context menu, message collapse, session handlers, automation runner, Claude text-blocks, LLM sanitization: pass
- `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`: pass
- `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`: pass
- Slack notices 61 -> 52 after dropping `llm-service.ts` and `consensus-coordinator.ts` from the allowlist
- Independent completion-gate still required before `_completed`

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.
