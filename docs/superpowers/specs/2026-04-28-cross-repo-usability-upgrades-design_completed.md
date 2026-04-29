# Cross-Repo Usability Upgrades Design

**Date:** 2026-04-28
**Status:** Completed on 2026-04-29
**Source memos consumed:** `copilot-oh-my-codex.md`, `copilot-t3code.md`, `copilot-hermes.md`, `copilot-claw-code.md`, `copilot-opencode.md`, `copilot.md`

## Child specs (per-wave detailed designs)

This program-level design covers the four tracks at a high level. Each wave gets its own detailed child design that is authoritative for its implementation:

| Wave | Tracks covered | Child design |
|---|---|---|
| 1 | A (foundation: command registry, overlay shell, frecency) | [`2026-04-28-wave1-command-registry-and-overlay-design_completed.md`](./2026-04-28-wave1-command-registry-and-overlay-design_completed.md) |
| 2 | A (navigation, pickers, prompt recall) | [`2026-04-28-wave2-navigation-pickers-prompt-recall-design_completed.md`](./2026-04-28-wave2-navigation-pickers-prompt-recall-design_completed.md) |
| 3 | B (workflow, resume, history, recovery) | [`2026-04-28-wave3-workflow-resume-history-recovery-design_completed.md`](./2026-04-28-wave3-workflow-resume-history-recovery-design_completed.md) |
| 4 | D (output, clipboard, theme, terminal drawer) | [`2026-04-28-wave4-output-clipboard-theme-terminal-design_completed.md`](./2026-04-28-wave4-output-clipboard-theme-terminal-design_completed.md) |
| 5 | C (orchestration HUD, verification verdicts) | [`2026-04-28-wave5-orchestration-hud-verification-verdicts-design_completed.md`](./2026-04-28-wave5-orchestration-hud-verification-verdicts-design_completed.md) |
| 6 | D (doctor, diagnostics, updates, operator artifacts) | [`2026-04-28-wave6-doctor-diagnostics-updates-artifacts-design_completed.md`](./2026-04-28-wave6-doctor-diagnostics-updates-artifacts-design_completed.md) |
| 7 | (integration & quality gates) | [`2026-04-28-wave7-integration-quality-gates-design_completed.md`](./2026-04-28-wave7-integration-quality-gates-design_completed.md) |

## Goal

Turn the useful ideas from the six Copilot comparison memos into implementable AI Orchestrator work without duplicating capabilities that already exist in the app. The resulting work should improve daily operator speed, session recovery, command discoverability, orchestration visibility, and diagnostic confidence while staying inside the current Electron + Angular + TypeScript architecture.

## Validation Method

The memos were checked against the current codebase and relevant roadmap docs before writing this spec. The validation read included:

- `docs/architecture.md`
- `docs/superpowers/specs/2026-04-16-ai-orchestrator-cross-repo-improvements-design.md`
- `docs/superpowers/plans/2026-04-20-ai-orchestrator-cross-repo-remediation-plan_completed.md`
- `docs/superpowers/plans/2026-04-27-unified-orchestration-master-plan_completed.md`
- `src/shared/types/command.types.ts`
- `src/main/commands/command-manager.ts`
- `src/main/commands/markdown-command-registry.ts`
- `src/renderer/app/core/state/command.store.ts`
- `src/renderer/app/features/commands/command-palette.component.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.html`
- `src/renderer/app/core/services/keybinding.service.ts`
- `src/shared/types/keybinding.types.ts`
- `src/main/workflows/workflow-manager.ts`
- `src/main/workflows/workflow-persistence.ts`
- `src/shared/types/workflow.types.ts`
- `src/main/history/history-manager.ts`
- `src/renderer/app/core/state/history.store.ts`
- `src/main/session/session-recall-service.ts`
- `src/main/session/session-continuity.ts`
- `src/main/orchestration/child-result-storage.ts`
- `src/main/orchestration/child-diagnostics.ts`
- `src/shared/types/agent-tree.types.ts`
- `src/main/session/agent-tree-persistence.ts`
- `src/main/orchestration/role-capability-policy.ts`
- `src/main/orchestration/permission-registry.ts`
- `packages/contracts/src/types/provider-runtime-events.ts`
- `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`
- `src/main/providers/provider-instance-manager.ts`
- `src/main/instance/instance-lifecycle.ts`
- `src/main/instance/lifecycle/interrupt-respawn-handler.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.html`
- `src/renderer/app/features/instance-detail/display-item-processor.service.ts`
- `src/renderer/app/core/state/settings.store.ts`
- `src/renderer/app/features/instance-list/instance-list.component.ts`
- `src/main/providers/provider-doctor.ts`
- `src/main/bootstrap/capability-probe.ts`
- `src/renderer/app/features/settings/cli-health-settings-tab.component.ts`
- `src/main/cli/cli-update-service.ts`

## Summary Decisions

| Memo idea | Current repo truth | Decision |
| --- | --- | --- |
| Rich slash command registry: aliases, categories, help, usage, examples, contextual applicability | Commands exist, but `CommandTemplate` is thin. `CommandManager` resolves exact names only. Palette and slash suggestions are flat. | Keep. This is a real foundation gap. |
| Contextual command palette and reusable overlay shell | Palette exists, keybinding infrastructure exists, but no reusable ranked overlay primitive. | Keep. Build as a renderer foundation before adding more pickers. |
| Numeric hotkeys for visible instance switching | Keybindings support actions and contexts, but no `select-visible-instance-1..9` actions. | Keep. Implement against the visible project rail order. |
| Prompt history recall | Draft persistence and edit-last-message exist. There is no cursor-aware prompt history stack. | Keep. Scope to composer history first. |
| Workflow transition policy | `WorkflowManager` starts, completes, skips, cancels, and persists workflows, but active workflow transitions are implicit and throw on overlap. | Keep. Add a policy layer over the existing workflow runtime. |
| Natural-language workflow and skill activation | Prompt suggestions exist but are generic. Skill matching exists in main process. | Keep, but make it opt-in or suggestion-based for heavier workflows. |
| Better session search and resume picker | History search is metadata-only. `SessionRecallService` exists for cross-subsystem recall but is not the user-facing history search. | Keep. Extend and reuse the existing recall/history services. |
| First-class subagent threads | Child result storage, child diagnostics, agent tree schema v2, and activity bridge already exist. UI exposes basic child status only. | Keep as UI and lifecycle polish, not a new backend model. |
| Normalized verification verdict | Prompts ask reviewers for JSON, but shared result types and UI do not expose a single verdict contract. | Keep. Add a small typed result layer and UI chips. |
| Runtime prompt overlays | Instruction resolution exists and can merge AGENTS/Copilot/orchestrator files. There is no compact runtime overlay view for "what context did this agent get?" | Keep. Build as a read-only diagnostic surface. |
| Doctor flow | `ProviderDoctor`, startup capability probe, and CLI Health settings tab exist. Top-level remediation is only a banner plus settings tab. | Keep as surface integration, not new probes from scratch. |
| CLI update pill | CLI update service exists in settings. No global update indicator was found. | Keep, scoped to CLI updates only unless app auto-update is added separately. |
| Terminal drawer and split panes | No reusable terminal drawer or xterm/pty-backed UI was found. Provider output is chat/transcript based. | Keep as a larger feature behind a separate implementation wave. |
| Shared clipboard UX | Clipboard calls are duplicated in output, verification, history rail, RLM, settings, and attachments. | Keep. Add one renderer clipboard service and notification contract. |
| Live system theme sync | System theme is applied once through `matchMedia(...).matches`; there is no listener for OS theme changes. | Keep. Small renderer fix. |
| Debounced large-list filtering | Project rail filter updates synchronously through a computed list. | Keep. Apply to project rail and shared pickers. |
| Package extraction, provider runtime unification, generated IPC, role model, transactional spawn, recovery semantics | Existing completed remediation docs and current provider runtime contracts already cover much of this. Role capability policy and provider event envelopes exist. | Do not duplicate. Preserve only residual operator-facing follow-ups. |
| AGENTS mutation, MCP-backed state server, wholesale CLI internals | These do not fit the app architecture or are already handled by instruction/config systems. | Do not port. |

## Track A: Command, Palette, Overlay, And Navigation

### Current State

- `CommandTemplate` lacks `aliases`, `category`, `usage`, `examples`, `applicability`, `disabledReason`, `rankHints`, and structured errors.
- Markdown commands parse a small frontmatter set only: name, description, hint, model, agent, subtask.
- `/help` is a built-in text command, not a command browser.
- The palette is a flat command list filtered by name and description.
- The input composer shows up to 8 prefix-matched slash suggestions and sends a normal message if no exact command is found.
- Keybindings support contexts, actions, sequences, and `when` conditions, but visible instance number actions are not defined.

### Design

Add a typed command metadata model that supports:

- `aliases`: short names such as `/h`, `/r`, `/v`.
- `category`: review, navigation, workflow, session, orchestration, diagnostics, memory, settings, custom.
- `usage`: canonical syntax and argument hints.
- `examples`: 1 to 3 concrete invocations.
- `applicability`: provider, selected instance state, working directory presence, feature flags.
- `disabledReason`: human-readable reason shown instead of silently failing.
- `rankHints`: recently used, project-local, provider-specific, and exact/alias match boosts.

Command resolution should return a structured result:

- `matched`: exact, alias, fuzzy, ambiguous, or none.
- `command`: resolved template when unique.
- `candidates`: near matches for ambiguity and unknown-command help.
- `error`: actionable text for the UI.

Build a reusable overlay shell used by:

- Command palette.
- Slash help browser.
- Teleport picker.
- Resume/session picker.
- Model/agent/session pickers later.

The overlay shell should own keyboard navigation, groups, empty states, hotkey labels, footer help, and frecency scoring hooks. Feature-specific stores should provide result items.

### Acceptance Criteria

- `/help` opens or renders categorized command help with aliases, syntax, examples, and disabled reasons.
- Unknown slash commands show nearest matches instead of silently becoming normal chat.
- Command palette can switch between command, session, file/symbol, and workflow modes without separate one-off modal logic.
- `Cmd/Ctrl+1..9` selects the nth visible live instance in the current project rail order and respects input focus rules.
- Composer history recall works at the prompt cursor and does not overwrite unsaved drafts.

## Track B: Workflow, Resume, History, And Recovery

### Current State

- Workflows have templates, phases, gates, persistence, restoration, and cleanup.
- Starting a workflow while one is active currently fails instead of applying a visible transition policy.
- History search scans only entry metadata in main and renderer.
- `SessionRecallService` indexes child results, diagnostics, automation runs, agent trees, and archived sessions, but is not yet the primary history search UI.
- Resume from history exists in the project rail. Resume by explicit id and "latest/switch/fork" quick actions are not first-class command/palette actions.
- Interrupt and respawn state is tracked with `interruptRequestId`, `interruptPhase`, `lastTurnOutcome`, `archivedUpToMessageId`, and continuity notices. Some transcript repair markers exist, but operator-visible interrupt boundaries are not consistently modeled as a first-class display item.
- Compaction boundaries and restore notices render in the output stream. There is no compact "what was summarized/recovered" summary view.

### Design

Introduce `WorkflowTransitionPolicy` as a small service adjacent to `WorkflowManager`. It should evaluate:

- current workflow execution and phase,
- requested template,
- requested source: slash command, NL suggestion, automation, manual UI,
- overlap category: compatible, incompatible, superseding, blocked.

The policy should return:

- `allow`,
- `allowWithOverlap`,
- `autoCompleteCurrent`,
- `deny`,
- `reason`,
- `suggestedAction`.

Natural-language activation should be conservative:

- Small tasks: suggest a slash command or skill.
- Medium tasks: suggest a workflow template and let the user confirm.
- Large/multi-agent tasks: route through orchestration preflight and show expected child count/provider implications.

History search should evolve into an advanced query service:

- plain text over transcript snippets,
- project scope: current project, all projects, no workspace,
- time filters: today, yesterday, last week, exact date ranges,
- source filters: history transcript, child result, child diagnostic, automation run, agent tree,
- result snippets with stable restore/resume actions.

Resume UX should support:

- resume latest,
- resume by session/thread id,
- switch to live if already restored,
- fork into a new session,
- show fallback mode: native resume, replay, transcript restore, or fresh restart.

Recovery display should add explicit display items for:

- interrupt requested,
- interrupt accepted/escalated,
- partial output preserved,
- respawn/resume result,
- compaction applied with before/after summary.

### Acceptance Criteria

- Starting a second workflow produces a deterministic policy result, not a generic throw.
- Advanced history search returns transcript snippets and can search across current/all projects.
- Resume picker can resolve exact ids, latest project thread, and already-live threads.
- Interrupt and compaction recovery states are visible in the transcript and searchable later.

## Track C: Orchestration And Verification Visibility

### Current State

- Child results and artifacts are persisted.
- Child diagnostics can summarize routing, status timeline, recent events/output, artifacts, and timeouts.
- Agent tree schema v2 includes role, spawn prompt hash, status timeline, heartbeat, last activity, result id, artifact count, routing, and spawn config.
- Renderer child panel shows child statuses and activity counts, but not the richer role/heartbeat/churn data.
- Role capability policy exists for parent, worker, reviewer, verifier, recovery, and automation roles.
- Verification prompts request JSON, but result storage/UI does not normalize a top-level verdict object.

### Design

Expose orchestration state as an operator HUD:

- leader/support/worker/reviewer/verifier role badges,
- active, stale, waiting, and failed children,
- last heartbeat and last activity,
- turn count and status churn,
- result/artifact availability,
- action shortcuts: focus child, copy prompt hash, open diagnostic bundle, summarize children.

Do not create a parallel child-thread backend. Use `AgentTreeSnapshot`, child diagnostics, child result storage, and orchestration activity events.

Normalize verification verdicts as a shared type:

- `status`: pass, pass-with-notes, needs-changes, blocked, inconclusive.
- `confidence`: numeric 0 to 1.
- `requiredActions`: string list.
- `riskAreas`: typed categories.
- `evidence`: references to model responses, files, or snippets.
- `rawResponses`: preserved for audit.

The UI should render the normalized verdict as a compact header above the existing detailed consensus display.

### Acceptance Criteria

- Child panel/HUD can identify stale children without reading logs.
- Verification results show one canonical verdict and required actions before raw model details.
- Existing result artifacts and diagnostics remain the source of truth.

## Track D: Operator Reliability And Local Tooling

### Current State

- `ProviderDoctor` and startup capability probing already run provider and subsystem checks.
- CLI Health settings tab can diagnose shadow installs and run update commands.
- Startup banner surfaces degraded startup checks but does not deep-link or guide remediation.
- Clipboard writes are duplicated across many renderer features.
- System theme does not live-update when OS theme changes while the app is open.
- No terminal drawer/split-pane feature is present.
- Lifecycle tracing exists in `src/main/observability/lifecycle-trace.ts`, but the broad local artifact/dev-runner/runbook workflow from the memos is not packaged as a single operator path.

### Design

Improve reliability surfaces without replacing existing services:

- Doctor entrypoint from startup banner and command palette.
- CLI update pill in the title bar or settings nav when update plans exist for installed CLIs.
- Shared renderer clipboard service with success/error state, fallback messaging, and optional toast integration.
- Live system theme listener with cleanup in `SettingsStore`.
- Terminal drawer as a larger feature: named tabs, split panes, link detection, and project/instance working directory defaults.
- Shared link detection utility for transcript, terminal, logs, and diagnostics.
- Config/command/skill diagnostics report that validates markdown command frontmatter, skill frontmatter/assets, instruction stack conflicts, and alias collisions.
- Local operator artifact: a JSONL or bundle export containing startup report, provider doctor results, command diagnostics, recent lifecycle trace, and selected session diagnostics.

### Acceptance Criteria

- Startup degraded banner can take the user to the exact Doctor/CLI Health problem area.
- Clipboard behavior is consistent across output, verification, history rail, RLM, settings, and attachments.
- Theme follows OS light/dark changes when the theme setting is `system`.
- Command/skill/config diagnostics catch invalid frontmatter and alias collisions before users discover them through failed commands.

## Non-Goals

- Do not replace the current provider runtime event envelope. It already exists in `packages/contracts/src/types/provider-runtime-events.ts` and the renderer consumes it.
- Do not create a second child-agent persistence model. Extend current child result, diagnostic, and agent-tree structures.
- Do not copy an external AGENTS mutation system into the app. Instruction resolution already supports AGENTS, Copilot instructions, orchestrator instructions, and custom instructions.
- Do not add an MCP-backed global state server as part of this work.
- Do not restart the completed cross-repo remediation program. This spec only captures still-relevant product and operator gaps.

## Recommended ship order

Strict order (informed by cross-cutting plan review):

1. **Wave 1** — foundation. Command registry, overlay shell, hybrid frecency. Blocks Waves 2, 3, and 6.
2. **Wave 2** — consumes Wave 1 overlay shell + UsageStore. Cannot start until Wave 1 lands.
3. **Wave 4** — clipboard, theme, link detection. Renderer-only and isolated; can run in parallel with Wave 2 once Wave 1 has shipped.
4. **Wave 5** — orchestration HUD + verification verdicts. Lightweight UI composition over existing main-process surfaces. The "copy prompt hash" quick action consumes Wave 4's `ClipboardService` directly via `inject(CLIPBOARD_SERVICE)` — there is no `navigator.clipboard.writeText` stop-gap and no `WAVE-4-MIGRATE` markers. If Wave 4 has not landed when Wave 5 begins, **STOP and escalate** rather than introducing a temporary path; this preserves the single-clipboard-surface guarantee Wave 7 audits.
5. **Wave 3** — workflow transitions, advanced history search, resume picker, recovery display items. Phases 1–9 (backend) can ship before Wave 1 if needed; Phases 10–14 (UI) require Wave 1's `OverlayShellComponent` and an `[itemFooter]` projection slot (added as a Wave 1 follow-up commit if absent).
6. **Wave 6** — Doctor, diagnostics, updates, operator artifacts. Soft-depends on Wave 1 emitting command diagnostics; gracefully degrades behind `featureFlags.commandDiagnosticsAvailable`.
7. **Wave 7** — integration gate, runbooks, smoke test. Always last.

Parallel windows:

- Waves 4 and 5 may run in parallel after Wave 1 ships.
- Wave 3 backend phases (1–9) are independent of Wave 1 and may run in parallel with Wave 1 itself if needed.
- Wave 6 may begin in parallel with Wave 5 once Wave 1 has shipped.

## Risks

- Command metadata expansion touches shared types, IPC validation, markdown parsing, palette UI, slash suggestions, and tests. It should be a foundation wave.
- History transcript search can become expensive. Use indexed snippets and pagination before wiring it to global search UI.
- Terminal drawer can become a separate app inside the app. Keep it behind a discrete wave with explicit scope.
- Verification verdict normalization must preserve existing raw evidence. Do not discard provider-specific response details.
- Any new `@contracts/schemas/...` subpath must update `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts` if tests import it.
- Wave-to-wave clipboard dependency: Wave 5's "copy prompt hash" quick action consumes Wave 4's `ClipboardService` (via `inject(CLIPBOARD_SERVICE)`) as a hard prerequisite. There is no `navigator.clipboard.writeText` fallback in Wave 5 source; the recommended ship order pins Wave 4 before Wave 5 to make this safe. If for some reason Wave 4 slips, escalate rather than introducing a stop-gap path — that just shifts cleanup into Wave 7.
- Wave 3's resume picker requires an `[itemFooter]` projection slot on Wave 1's `OverlayShellComponent`. If absent, add it to Wave 1 (additive, backward-compatible) before Wave 3 Phase 10.
- Cross-wave persistence: Wave 1's `'usage-tracker'` and Wave 2's `'prompt-history'` electron-stores are intentionally separate namespaces. Future unification requires explicit migration.

## Status: Completed

Completed date: 2026-04-29.

Shipped waves:

- Wave 1: command registry, overlay shell, and frecency foundation.
- Wave 2: navigation pickers, numeric hotkeys, and prompt recall.
- Wave 3: workflow transitions, advanced history search, resume flows, and recovery display items.
- Wave 4: clipboard service, theme listener, link detection, and terminal drawer boundary.
- Wave 5: orchestration HUD, quick actions, and verification verdicts.
- Wave 6: Doctor, diagnostics, CLI update pill, and redacted operator artifacts.
- Wave 7: IPC audit, alias-sync auditor, cross-wave smoke tests, runbooks, package build, and Electron smoke checks.

Completion evidence:

- Full automated gates, package build, native ABI, IPC, contracts, exports, architecture inventory, and Electron smoke checks are recorded in `docs/runbooks/wave-7-smoke-results.md`.
- Interactive UI checklist evidence and screenshots are stored under `docs/runbooks/screenshots/wave-7/` with selector assertions in `docs/runbooks/screenshots/wave-7/smoke-evidence.json`.
- The interactive screenshots were captured from an isolated dev-renderer benchmark session to avoid controlling or replacing any installed/running user app; packaged validation is covered by `npm run localbuild` and `npm run smoke:electron`.
- No comparison memo source files remain in `docs/superpowers/`.

Operator runbooks delivered under `docs/runbooks/`.
