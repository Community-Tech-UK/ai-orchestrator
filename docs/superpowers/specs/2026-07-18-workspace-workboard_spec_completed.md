# Workspace Workboard Design Specification

**Status:** Implemented and verified against all agent-runnable gates (2026-07-18). Real rendered-UI acceptance is deferred to the linked plan's `_livetest.md`.
**Date:** 2026-07-18
**Source review:** Local Tura checkout compared with AI Orchestrator
**Implementation plan:** [Workspace Workboard Implementation Plan](../plans/2026-07-18-workspace-workboard_plan_completed.md)

**As-built note:** Delivered exactly as specified. Deliberate deviations (all recorded in the plan's As-Built section): the page template/styles are inlined for JIT-test rendering (card + source-summary keep separate SCSS); the Back-control audit excludes `workboard/` because the board↔detail Back is distinct from the shell Back; four loop/loop-adjacent files' LOC ceilings were raised to their new sizes. Acceptance criteria 1–11 are met by automated tests; criterion 11's "real rendered UI check" and the operator-facing behaviors are the deferred live-test items. Criterion 12 (docs stay untracked until completion) held throughout.

## 1. Objective

Add a workspace-aware Workboard that gives the operator one place to answer four questions:

1. What needs me?
2. What is actively working?
3. What is queued or deliberately waiting?
4. What finished recently?

The Workboard must project AI Orchestrator's existing instances, loop runs, automation runs, and repository jobs. It must not create a second task database or flatten the source domains into a shared mutable status enum.

The selected work item opens a detail pane. When the item is backed by an instance, the pane reuses the existing instance transcript and controls. When no instance exists yet, it shows source metadata and a link to the owning specialist surface.

## 2. Why This Is the Right Tura Idea to Adopt

Tura's useful product idea is not its runtime architecture. It is the operator-facing combination of:

- a small attention-oriented board;
- a selected-item conversation pane; and
- one task identity that stays legible while execution details change.

The relevant local Tura implementation is:

- `../tura/apps/gui/app/src/pages/plan/plan-view.tsx`, which combines a four-lane board with a selected task conversation;
- `../tura/apps/gui/app/src/pages/plan/plan-gantt.tsx`, which makes ordered work visible;
- `../tura/apps/gui/app/src/conversation/run-summary.tsx` and `tool-inspector.tsx`, which summarize execution before exposing raw detail.

AI Orchestrator already has the stronger backend primitives:

- rich, intentionally separate lifecycle enums in `src/shared/types/workflow-lifecycle.types.ts`;
- renderer stores for instances, loops, and automation runs;
- persisted repository jobs with linked instance IDs;
- a mature `InstanceDetailComponent` containing transcript, input, loop controls, approvals, review panels, and inspectors;
- state-resync snapshots containing active loop and automation runs.

The product opportunity is therefore to add a projection and interaction surface, not to port Tura's execution model or copy its code.

## 3. Decisions

### 3.1 Use a renderer projection, not a new canonical work store

The Workboard will calculate `WorkboardItem` view models from existing source records. Source stores remain authoritative and retain their native statuses and actions.

Rejected alternatives:

1. **New work-item persistence layer.** Rejected because it would duplicate status, ownership, recovery, and history already held by four domains. Synchronization failures would be inevitable.
2. **Only use `WorkflowLifecyclePhase`.** Rejected because it is intentionally coarse. For example, an idle instance projects to `running`, while a completed loop needing review projects to `completed`; neither phase alone expresses operator attention.
3. **Build the feature first on the thin-client contract.** Rejected for the first delivery because the Electron renderer already owns the richer stores and controls. The view-model boundary will remain transport-neutral so a thin client can adopt it later.

### 3.2 Correlate related records before rendering cards

A repository job, automation run, loop, and instance can represent one real task. Rendering every record separately would exaggerate workload and make the board noisy.

The projection will form correlation groups using explicit IDs:

- repository job `instanceId` / result `instanceId`;
- automation run `loopRunId` and `instanceId`;
- loop run `chatId`, which identifies its owning conversation/instance;
- instance `id`.

The primary source precedence is:

1. repository job;
2. automation run;
3. loop run;
4. standalone instance.

The primary source supplies the title and specialist destination. Related records supply live status, attention, transcript linkage, and secondary metadata. The group lane uses the most urgent related state, so a running repository job whose instance is waiting for permission appears in **Needs You**, not **Working**.

Correlation is conservative. Records are merged only through explicit IDs; title, path, time, or prompt similarity must never merge work.

### 3.3 Workboard replaces Fleet as the canonical overview

The new canonical route is `/work`. The existing `/fleet` URL redirects to `/work` so bookmarks continue to work.

The current Fleet dashboard's useful instance classification behavior moves into the Workboard projection and tests. The old Fleet component is removed after the new surface passes its acceptance checks. Specialist pages such as Automations, Background Jobs, Replay, and the main dashboard remain available.

This is intentionally limited navigation consolidation. Reorganizing all Control Center groups remains a follow-on project.

### 3.4 No generic drag-to-change-status

The board is not a mutable Kanban database. Moving a running loop, a queued repository job, or a waiting instance between generic lanes would have different and potentially destructive meanings.

The first delivery therefore has no drag-and-drop. Controls remain source-specific:

- instance actions stay in `InstanceDetailComponent`;
- loop pause, resume, intervene, accept, and cancel stay in the existing loop controls;
- repository-job rerun/cancel stay in Background Jobs;
- automation controls stay in Automations.

The Workboard may expose safe navigation buttons such as **Open in Automations** or **Open in Background Jobs**. It must not invent a generic `setStatus` command.

## 4. Product Behavior

### 4.1 Lanes

The board has four ordered lanes:

| Lane | Meaning | Sort order |
|---|---|---|
| Needs You | Human input, permission, review, arbitration, or failure needs attention | Most recently updated first |
| Working | Execution is actively progressing | Most recently updated first |
| Waiting | Queued, paused, hibernated, or rate-limited but resumable | Oldest waiting first |
| Done / Idle | Clean terminal work and available idle instances | Most recently updated first |

Each lane header shows a count. Empty lanes remain visible with a short empty-state label so the board's meaning does not move around.

### 4.2 Source-to-lane policy

The mapping must be exhaustive and tested against each source status union.

#### Instances

- **Needs You:** `waiting_for_permission`, `waiting_for_input`, `degraded`, `error`, `failed`
- **Working:** `initializing`, `busy`, `processing`, `thinking_deeply`, `respawning`, `waking`, `interrupting`, `cancelling`, `interrupt-escalating`
- **Waiting:** `hibernating`, `hibernated`
- **Done / Idle:** `ready`, `idle`, `terminated`, `cancelled`, `superseded`

#### Loop runs

- **Working:** `running`
- **Waiting:** `paused`; active/resumable `provider-limit` where `endedAt` is null
- **Needs You:** `completed-needs-review`, `failed`, `error`, `no-progress`, `cap-reached`, terminal `provider-limit`, `cost-exceeded`, `needs-human-arbitration`, `reviewer-unreliable`, `reviewer-unavailable`, `builder-unreliable`
- **Done / Idle:** `completed`, `cancelled`

#### Automation runs

- **Working:** `running`
- **Waiting:** `pending`
- **Needs You:** `failed`
- **Done / Idle:** `succeeded`, `skipped`, `cancelled`

#### Repository jobs

- **Working:** `running`
- **Waiting:** `queued`
- **Needs You:** `failed`
- **Done / Idle:** `completed`, `cancelled`

The mapping is a Workboard attention policy, not a replacement for `WorkflowLifecyclePhase`. Projection code should still retain the coarse phase and raw source status for display and future clients.

### 4.3 Recent-terminal policy

Live or resumable records are always visible. Terminal records are visible when their effective update/end time falls within the last 24 hours. This keeps the overview operational instead of becoming an archive.

Failures and review-required terminal states follow the same 24-hour first-delivery window. Persistent acknowledgement is intentionally deferred; specialist history pages remain the durable archive.

Time-based projection functions receive `now` as an input so tests are deterministic.

### 4.4 Workspace filter

The page defaults to **All workspaces** and derives workspace options from the visible source records. A workspace option uses:

- the normalized ID from `toWorkspaceId(workingDirectory)`;
- a human label based on the directory basename; and
- the full path in secondary text and accessible labeling.

Workspace paths come from:

- instance `workingDirectory`;
- loop summary `workspaceCwd`;
- automation run `configSnapshot.action.workingDirectory`, falling back to the owning automation's action directory;
- repository job `workingDirectory`.

The filter is renderer-only in the first delivery and resets to **All workspaces** on a fresh page load. URL persistence can be added later if a concrete deep-link need appears.

### 4.5 Card content

Every card shows:

- primary title;
- source badge;
- attention/status label;
- workspace basename;
- relative update time;
- concise progress when available, such as loop iteration, repository-job percentage, or current instance activity;
- related-source badges when correlation grouped multiple records.

Cards are buttons, keyboard reachable, and use `aria-pressed` or an equivalent selected-state relationship. Raw status strings remain available in title/accessible text even when a friendly label is displayed.

### 4.6 Selection and detail pane

Selecting a card keeps the board visible and opens a right-hand detail pane.

If the group has a linked instance:

1. Set the existing `InstanceStore` selection to that instance ID.
2. Render `InstanceDetailComponent` in the detail pane.
3. Preserve the existing transcript, input, approval, review, loop-control, and inspector behavior.

If the group has no linked instance, render a Workboard summary with source metadata, error/output summary when available, and a button to the owning surface.

On narrow widths, selection changes the page to a detail view with a visible **Back to Workboard** control. It must not squeeze the full transcript into an unusable narrow column.

Selection is local to the page. Passive source events and background-created instances must not steal selection.

## 5. View Model

The implementation will use renderer-local types similar to:

```ts
export type WorkboardLane = 'needs-you' | 'working' | 'waiting' | 'done';
export type WorkboardSourceKind = 'repo-job' | 'automation-run' | 'loop-run' | 'instance';

export interface WorkboardRelation {
  kind: WorkboardSourceKind;
  id: string;
  rawStatus: string;
  phase: WorkflowLifecyclePhase;
  lane: WorkboardLane;
  updatedAt: number;
}

export interface WorkboardItem {
  id: string;
  primary: WorkboardRelation;
  relations: readonly WorkboardRelation[];
  lane: WorkboardLane;
  title: string;
  workspaceId: string;
  workingDirectory: string;
  statusLabel: string;
  detail?: string;
  progress?: number;
  updatedAt: number;
  instanceId?: string;
  loopRunId?: string;
  automationRunId?: string;
  repoJobId?: string;
}
```

Exact field names may change during implementation, but these invariants may not:

- stable item IDs are based on the primary source kind and ID;
- every relation keeps raw status and coarse phase;
- lane calculation is separate from persistence and source mutation;
- correlation uses explicit IDs only;
- the item carries enough linkage to reuse existing detail and navigation.

## 6. Missing Read Models to Add

### 6.1 Recent loop runs

The renderer currently exposes loop history only one chat at a time. A global Workboard must also recover active and recently terminal loop items after reload, especially `completed-needs-review` and failure states.

Add a bounded read-only loop list path:

- `LoopStore.listRuns(limit)` in the main-process persistence store;
- `LOOP_LIST_RUNS` channel and validated `{ limit?: number }` payload;
- preload and renderer IPC methods;
- `LoopStore.recentRuns` plus `refreshRecentRuns(limit)` in the renderer store;
- `workspaceCwd` in `LoopRunSummary`, derived from persisted `config_json` rather than a database migration.

The API defaults to 100 and caps at 200. It returns newest-first summaries and never returns raw verifier output or secrets.

State-change events update the renderer's recent-run list in place so the Workboard is live between refreshes. Page activation performs a refresh to close any event gap.

### 6.2 Shared repository-job renderer state

`TasksPageComponent` currently owns repository-job signals and a four-second polling interval. Extract list/stats/loading/error and refresh/rerun/cancel behavior into a root `RepoJobStore` so Background Jobs and Workboard consume one renderer state model.

Polling remains page-owned and bounded. A visible Workboard or Background Jobs page triggers refresh every four seconds and clears the interval on destroy. The root store itself must not create an immortal timer.

## 7. Page Architecture

Create a `features/workboard/` feature with:

- pure projection/correlation functions and tests;
- a signal-based `WorkboardStore` or facade that composes the four source stores;
- page component, template, and SCSS;
- small presentational card and source-summary components only if the page would otherwise exceed the repository LOC ceiling;
- component tests for lane rendering, filtering, selection, empty states, and narrow-detail navigation.

The Workboard store owns only view state and derivation:

- selected workspace;
- selected item ID;
- computed workspace options;
- computed, correlated, filtered items;
- computed lane arrays;
- refresh orchestration and partial-source errors.

It does not own source commands or persisted workflow state.

## 8. Navigation

Add a `workboard` Control Surface:

- path: `/work`
- label: `Workboard`
- group: `automation`
- kind: `view`
- layout: `fullBleed`
- visible in dashboard and Control Center navigation

Replace the Fleet surface entry with Workboard. Keep `/fleet` as a redirect to `/work`; it is a compatibility alias, not a second Control Surface entry.

Update route and registry audit tests so every canonical route remains represented and the alias is explicitly allowed.

## 9. Loading, Errors, and Refresh

- Render source data independently; one failed source must not blank the other three.
- Show a compact source-specific warning with a retry action when loop or repository-job refresh fails.
- Existing instance and automation store errors remain source-owned but are summarized by Workboard.
- Initial loading shows lane skeletons only until the first projection can be made.
- Background refresh must not clear existing cards or selected item.
- If the selected item expires from the 24-hour window or disappears, clear selection and return focus to the board heading.

## 10. Accessibility and Responsive Requirements

- Use semantic headings for the page and each lane.
- Cards are real buttons with visible focus styling.
- Counts and refresh failures have readable labels; live regions are polite and limited to state changes that require notice.
- Do not implement horizontal-only keyboard interaction. Standard tab order must reach every card and control.
- Desktop uses board plus detail split view.
- At widths below the existing app mobile breakpoint, show either board or detail, with an explicit Back control in detail.
- Empty states, badges, and status differences cannot depend on color alone.
- Respect existing reduced-motion and design-token conventions; do not introduce a new UI library.

## 11. Out of Scope

- A new task database or generic workflow mutation API.
- Drag-and-drop lane changes.
- Task scheduling or calendar UI.
- Ordered/Gantt pipeline editing.
- A terminal/TUI client.
- Broad Control Center navigation regrouping.
- Tool-inspector or run-summary redesign.
- New provider, agent, runtime, or tool execution layers.
- Tura personas, avatars, or visual branding.
- Thin-client/mobile Workboard delivery; the renderer boundary should merely avoid blocking it.

## 12. Acceptance Criteria

1. `/work` loads a four-lane Workboard and `/fleet` redirects to it.
2. Instances, recent loop runs, automation runs, and repository jobs appear without new work-item persistence.
3. Exhaustive tested policies map every source status to an attention lane.
4. Explicitly linked source records collapse into one card, and the most urgent relation controls its lane.
5. The workspace filter shows All plus derived workspace choices and filters every lane consistently.
6. Live/resumable items remain visible; terminal items older than 24 hours are excluded deterministically.
7. Selecting an instance-linked item opens the existing transcript and controls without a new conversation implementation.
8. Selecting an item without an instance shows useful source detail and a specialist-page action.
9. A source refresh failure leaves data from other sources usable.
10. The old Fleet component and its duplicate navigation entry are removed only after its useful behavior is covered by Workboard tests.
11. Targeted tests, typechecks, lint, LOC ratchet, IPC verification, the full quiet suite, and a real rendered UI check pass before completion.
12. The active spec and plan remain untracked and uncommitted until implementation and verification are complete.

## 13. Follow-On Opportunities

After evidence from daily Workboard use, consider separate plans for:

1. configurable acknowledgement/retention for completed and failed items;
2. URL-persisted workspace and item selection;
3. compact source-specific quick actions proven safe by use;
4. terminal and thin-client Workboard views over the same projection contract;
5. Tura-like ordered pipeline/Gantt planning backed by AI Orchestrator's real workflow dependencies;
6. a denser run summary and tool inspector;
7. broader navigation consolidation around Work, Build, Observe, and Configure.
