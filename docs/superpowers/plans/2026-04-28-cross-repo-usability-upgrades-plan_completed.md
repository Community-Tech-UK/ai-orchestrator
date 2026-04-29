# Cross-Repo Usability Upgrades Plan

**Date:** 2026-04-28
**Status:** Completed on 2026-04-29
**Design:** `docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md`

## Goal

Implement the valid ideas extracted from the six comparison memos as focused waves. Each wave should be independently useful, testable, and grounded in existing AI Orchestrator services.

## Global Rules

- Read the full files listed in each wave before editing.
- Prefer existing stores, IPC services, and singleton patterns.
- Keep platform work scoped to the user-facing gaps in the design spec.
- Do not duplicate completed provider runtime or cross-repo remediation work.
- After code changes, run:
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - targeted Vitest specs for touched code
- For multi-file TypeScript changes, run the full affected test suite where practical.

## Wave 1: Command Registry And Overlay Foundation

**Detailed design:** [`docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design_completed.md`](../specs/2026-04-28-wave1-command-registry-and-overlay-design_completed.md)

**Outcome:** Commands have enough structured metadata for aliases, help, ranking, applicability, and actionable errors. A reusable overlay shell exists for command and future pickers.

### Files To Read First

- `src/shared/types/command.types.ts`
- `src/shared/validation/ipc-schemas.ts`
- `src/main/commands/command-manager.ts`
- `src/main/commands/markdown-command-registry.ts`
- `src/main/ipc/handlers/command-handlers.ts`
- `src/renderer/app/core/state/command.store.ts`
- `src/renderer/app/features/commands/command-palette.component.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.html`
- Existing command specs under `src/main/commands/__tests__/`

### Tasks

- [x] Extend `CommandTemplate` with `aliases`, `category`, `usage`, `examples`, `applicability`, `disabledReason`, and `rankHints`.
- [x] Extend markdown command frontmatter parsing for the new fields.
- [x] Add structured command resolution result types: exact, alias, fuzzy, ambiguous, none.
- [x] Update `CommandManager.executeCommand` and IPC handlers to return actionable errors and candidates.
- [x] Add alias collision diagnostics for built-in, custom, and markdown commands.
- [x] Build a reusable renderer overlay shell component for grouped, ranked, keyboard-driven result lists.
- [x] Refactor command palette onto the overlay shell.
- [x] Replace `/help` text-only behavior with categorized command help.
- [x] Update slash suggestions to show aliases, categories, usage, and disabled reasons.
- [x] Add command usage/frecency tracking in renderer storage or an existing lightweight store.

### Tests

- `src/main/commands/__tests__/command-manager.spec.ts`
- `src/main/commands/__tests__/markdown-command-registry.spec.ts`
- command IPC handler specs
- command store/palette component specs if present, or add focused tests for ranking and unknown slash behavior

### Exit Criteria

- Unknown slash command produces nearest matches.
- Alias execution works from both palette and composer.
- Ambiguous aliases are blocked with clear diagnostics.
- `/help` shows categorized command metadata.

## Wave 2: Navigation, Pickers, And Prompt Recall

**Outcome:** Operators can switch sessions quickly, recall prompts safely, and use consistent pickers.

### Files To Read First

- `src/shared/types/keybinding.types.ts`
- `src/renderer/app/core/services/keybinding.service.ts`
- `src/renderer/app/core/services/action-dispatch.service.ts`
- `src/renderer/app/features/instance-list/instance-list.component.ts`
- `src/renderer/app/features/instance-list/project-group-computation.service.ts`
- `src/renderer/app/core/state/instance.store.ts`
- `src/renderer/app/core/services/draft.service.ts`
- `src/renderer/app/core/services/new-session-draft.service.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.ts`

### Tasks

- [x] Add `select-visible-instance-1` through `select-visible-instance-9` keybinding actions.
- [x] Implement visible live-instance order resolver based on the project rail's current grouping/filtering.
- [x] Wire `Cmd/Ctrl+1..9` to select visible instances without stealing plain text input.
- [x] Add prompt history storage per instance and project.
- [x] Implement cursor-aware Up/Down or `Ctrl+R` recall without clobbering active drafts.
- [x] Add a session picker mode to the overlay shell with frecency ranking.
- [x] Add a model/agent picker mode only after overlay shell ranking is proven by command/session pickers.
- [x] Debounce project rail filtering and shared picker filtering.

### Tests

- keybinding service tests
- instance list ordering tests
- input panel prompt history tests
- project rail filtering tests

### Exit Criteria

- Numeric hotkeys select what the user can see in the rail.
- Prompt recall preserves unsent drafts.
- Large project rails do not recompute on every keystroke without debounce.

## Wave 3: Workflow, Resume, History, And Recovery

**Outcome:** Workflow transitions, session search, resume, interrupt, and compaction recovery become explicit user-facing flows.

### Files To Read First

- `src/main/workflows/workflow-manager.ts`
- `src/main/workflows/workflow-persistence.ts`
- `src/shared/types/workflow.types.ts`
- `src/main/workflows/__tests__/workflow-*.spec.ts`
- `src/main/history/history-manager.ts`
- `src/shared/types/history.types.ts`
- `src/renderer/app/core/state/history.store.ts`
- `src/main/session/session-recall-service.ts`
- `src/shared/types/session-recall.types.ts`
- `src/main/session/session-continuity.ts`
- `src/main/instance/lifecycle/interrupt-respawn-handler.ts`
- `src/renderer/app/features/instance-detail/display-item-processor.service.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.html`

### Tasks

- [x] Add `WorkflowTransitionPolicy` with allow, overlap, auto-complete, and deny outcomes.
- [x] Integrate transition policy into workflow start paths without changing template semantics.
- [x] Add conservative natural-language workflow/skill suggestions through prompt suggestion or command overlay.
- [x] Extend history/search IPC to return snippets, project scope, source filters, time filters, and pagination.
- [x] Reuse `SessionRecallService` for cross-subsystem recall instead of creating a second index.
- [x] Add resume picker actions: latest, by id, switch to live, fork new, restore from fallback.
- [x] Model interrupt and recovery boundaries as explicit display items.
- [x] Add compaction/recovery summaries that show reason, before/after counts, and fallback mode.

### Tests

- workflow policy unit tests
- workflow manager integration tests
- history manager search tests
- session recall tests
- display item processor tests for interrupt/compaction boundary rendering
- history store/rail restore tests

### Exit Criteria

- Starting a workflow while another is active yields a deterministic policy result.
- History search can find transcript snippets across current/all projects.
- Resume by id and resume latest are available from command palette.
- Interrupt and compaction boundaries remain visible after restore.

## Wave 4: Output, Clipboard, Theme, And Terminal Drawer

**Outcome:** Common operator surfaces behave consistently and prepare for richer terminal workflows.

### Files To Read First

- `src/renderer/app/features/instance-detail/output-stream.component.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.html`
- `src/renderer/app/core/services/markdown.service.ts`
- all renderer files using `navigator.clipboard.writeText`
- `src/renderer/app/core/state/settings.store.ts`
- `src/renderer/app/app.component.ts`
- `src/main/workspace/editor/external-editor.ts`
- `src/main/providers/activity-state-detector.ts`

### Tasks

- [x] Add a renderer `ClipboardService` for text, JSON, and image-copy status where applicable.
- [x] Replace direct `navigator.clipboard.writeText` calls with the service in output, verification, history rail, RLM, settings, and code search.
- [x] Add a shared copy success/error UI contract.
- [x] Add a live `matchMedia('(prefers-color-scheme: dark)')` listener with cleanup when theme is `system`.
- [x] Extract link detection for file paths, URLs, and command output into a shared utility.
- [x] Scope terminal drawer requirements: tabs, split panes, working directory defaults, transcript link detection, and lifecycle cleanup.
- [x] Implement terminal drawer only after the service boundary is clear. The boundary/scaffold is delivered here; real `node-pty`/`xterm` hosting remains explicitly deferred to Wave 4b.

### Tests

- clipboard service tests
- affected component tests for copy status
- settings store test for system theme listener
- link detection utility tests
- terminal drawer tests when implemented

### Exit Criteria

- Copy behavior is consistent across all renderer surfaces.
- OS theme changes update the app when theme mode is `system`.
- Terminal drawer has an explicit backend/frontend boundary before UI work starts.

## Wave 5: Orchestration HUD And Verification Verdicts

**Outcome:** Multi-agent runs are easier to understand, and verification results have a canonical verdict before raw details.

### Files To Read First

- `src/renderer/app/features/instance-detail/child-instances-panel.component.ts`
- `src/main/orchestration/child-result-storage.ts`
- `src/main/orchestration/child-diagnostics.ts`
- `src/shared/types/agent-tree.types.ts`
- `src/main/session/agent-tree-persistence.ts`
- `src/main/orchestration/orchestration-activity-bridge.ts`
- `src/main/orchestration/role-capability-policy.ts`
- `src/shared/types/verification.types.ts`
- `src/main/orchestration/review-prompts.ts`
- `src/renderer/app/features/verification/results/verification-results.component.ts`
- `src/renderer/app/features/verification/results/verification-results.component.html`
- `src/renderer/app/core/state/verification/verification.types.ts`

### Tasks

- [x] Add derived child state fields for stale, active, waiting, failed, turn count, and churn count.
- [x] Expose role badges and heartbeat/last activity in the child panel.
- [x] Add compact orchestration HUD for parent sessions with child counts and attention states.
- [x] Add quick actions: focus child, open diagnostic bundle, copy prompt hash, summarize children.
- [x] Add shared `VerificationVerdict` type and schema.
- [x] Normalize current multi-verify results into the verdict contract while preserving raw responses.
- [x] Render verdict status, confidence, required actions, and risk areas above existing details.

### Tests

- child diagnostics tests
- agent tree persistence tests
- child panel component tests
- verification type/schema tests
- verification results component tests

### Exit Criteria

- A stale or failed child can be diagnosed from the UI without log diving.
- Verification output has one clear verdict and action list.
- Raw provider responses remain inspectable.

## Wave 6: Doctor, Diagnostics, Updates, And Operator Artifacts

**Outcome:** Existing diagnostic services become a cohesive operator flow.

### Files To Read First

- `src/main/providers/provider-doctor.ts`
- `src/main/bootstrap/capability-probe.ts`
- `src/renderer/app/app.component.ts`
- `src/renderer/app/app.component.html`
- `src/renderer/app/features/settings/cli-health-settings-tab.component.ts`
- `src/main/cli/cli-update-service.ts`
- `src/main/core/config/instruction-resolver.ts`
- `src/main/skills/skill-loader.ts`
- `src/main/skills/skill-registry.ts`
- `src/main/commands/markdown-command-registry.ts`
- `src/main/observability/lifecycle-trace.ts`

### Tasks

- [x] Add a Doctor route or overlay that combines startup capability report, provider doctor results, CLI Health, and browser automation health.
- [x] Deep-link degraded startup banner checks to the exact Doctor section.
- [x] Add a CLI update pill when installed CLIs have supported update plans.
- [x] Add command diagnostics: invalid frontmatter, alias collision, missing usage, duplicate names.
- [x] Add skill diagnostics: invalid frontmatter, missing assets/references/scripts, unreadable files.
- [x] Add instruction diagnostics: conflicting project AGENTS/orchestrator/Copilot instructions and broad-root scan warnings.
- [x] Add a local operator artifact export with startup checks, provider diagnoses, command/skill diagnostics, lifecycle trace excerpt, and selected session diagnostics.
- [x] Add a provider scaffold checklist or generator doc only if new provider work is active. (No new provider work was active for Wave 6.)
- [x] Add docs inventory generation only as a lightweight script or prebuild check, not a new docs platform. (Covered by Wave 7 audit tooling rather than a new docs platform.)

### Tests

- provider doctor tests
- capability probe tests
- CLI update service tests
- command/skill diagnostics unit tests
- app/startup banner tests
- artifact export tests

### Exit Criteria

- Degraded startup checks lead to a concrete remediation UI.
- CLI updates are discoverable outside the settings tab.
- Operator artifact export is usable for debugging provider/session issues.

## Wave 7: Final Integration And Quality Gates

**Outcome:** The work is coherent, tested, and documented.

### Tasks

- [x] Review all new IPC channels and update preload/domain wiring.
- [x] Verify any new contracts aliases are mirrored in all required config files.
- [x] Add runbook notes for Doctor, advanced search, command diagnostics, and orchestration HUD.
- [x] Add or update screenshots only after UI implementation is stable. Captured under `docs/runbooks/screenshots/wave-7/` from an isolated dev-renderer benchmark session; packaged validation is recorded separately.
- [x] Run full verification:
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - `npm run test`
- [x] Smoke-test palette, slash help, resume picker, Doctor, and child HUD. Interactive row-by-row evidence is in `docs/runbooks/wave-7-smoke-results.md`; package/build smoke is covered by `npm run localbuild` and `npm run smoke:electron`.

### Exit Criteria

- Every wave has tests or a recorded reason where UI-only manual verification is required.
- New command/search/resume/orchestration features are discoverable from the command palette.
- No comparison memo source file remains in the repo.

## Completion Evidence

Completed date: 2026-04-29.

- Code-level closure included the final CLI update pill shell mount and browser-mode provider event fallback needed for isolated renderer smoke validation.
- Automated gates are recorded in `docs/runbooks/wave-7-smoke-results.md`.
- UI screenshots and selector assertions are stored in `docs/runbooks/screenshots/wave-7/`.
- The runbooks under `docs/runbooks/` cross-link the relevant evidence for Waves 1-6.
- Packaged validation used `npm run localbuild` and `npm run smoke:electron`; no installed/running user app was controlled for screenshot capture.
