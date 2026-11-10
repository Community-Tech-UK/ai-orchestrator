# Oct-2 later (P2): useful, not before the rest

## Status

On main: yes (this landing commit)
Code is on main (hand-merged); this queue round changed no code and found nothing left that code can do.
- Landed: 2.2-2.5, 3.1-3.7, 3.9, 4.1, 4.3, 5.1-5.6 (the "Plan: 2026-10-20-oct2-later (code only)" commit; 3.2 hubs in c58792194, 28c6a32ee, 1eaf35140). Step 1 belongs to the pause/workload owner plan.
- 2.1 not built in code: closing the five dead paused loops is a live data action on James's running app, recorded as livetest section 1.
- 4.2 closed as not applicable: `appTooltipTpl` is still used (`model-selection-panel.component.ts:168`, `instance-row.component.html:127`), so it stays.
- 10 Nov 2026 round: typecheck, typecheck:spec, lint, check:ts-max-loc and check:ui-hints pass; 7 targeted spec files (56 tests) pass. Full suite and verdict are the coordinator's.
- Open: the live checks in [the livetest list](2026-10-20-oct2-later_livetest.md). The plan stays active until they pass.
- Round evidence: [history](2026-10-20-oct2-later_plan_history_3569b6aac09a5fc3ee0c5a209c029e4091dc35755fd6162f5d4deb513d5c4990_completed.md), "Queue round: 10 November 2026".

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items L11, L13, U13, H10, T15 items 2-7.
**Programme:** [A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) · [B](2026-10-20-oct2-phaseB-land-built-work_plan.md) ·
[C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) · [D](2026-10-20-oct2-phaseD-tokens_plan.md) ·
[E](2026-10-20-oct2-phaseE-calm-screen_plan.md) · [F](2026-10-20-oct2-phaseF-tooltips_plan.md) ·
[housekeeping](2026-10-20-oct2-housekeeping_plan.md) · later (this) · [decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## Ground rules

Same as the phase plans: read first; failing test first; current checkout only, no branch or worktree, never stage or stash
other sessions' work; file-size limits; no browser or desktop app on the Mac; commit only when James asks; keep the Status
block short.

**Settings keys:** `settings.types.ts` has about 4 lines of room (885/889): every new key in this plan goes in a separate
settings-types module that the main settings type extends, never in that file.

## Step 1. L11: Hold new work

Replaced by [Pause everything and workload](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-24-pause-everything-and-workload_plan_completed.md),
as authorized by decision 11(a) in its linked completed spec. The owner document remains in the root checkout;
it is not copied here. In this checkout the executing implementation is `src/main/global-pause/global-pause-service.ts`
(`hold`/`release`), `global-pause-bootstrap.ts` (startup restoration and `hold-new-work` sentinel),
`src/main/work-admission/work-admission.ts` and its queue/loop/automation callers (quiet admission),
`src/renderer/app/core/state/global-pause/work-control.component.*` (always-visible control), and
`src/main/mcp/orchestrator-tools-rpc-pause.ts` (restricted hold/release commands). The independent VPN pause stays separate.
This transferred scope will be checked against those runtime paths and focused tests, without rebuilding the owner plan.

## Step 2. L13: loop and queue odds and ends

1. Close the five dead "paused" loop runs (9 May, 17 May, 8 June, 10 June, 13 July) through the app's own close path, not
   by editing the database.
2. Show automatic nudges (`loop-idle-nudge.ts:60-95` tags them with `source`; the renderer has no handling) as collapsed,
   timestamped rows: "Harness nudge, 14:32: not done, 3 items open".
3. A "status-only turn" counter (no tool calls, short output) on the loop scorecard and queue round record.
4. Label Harness-written turns `[harness]`, not `[user]`, in the restart-compaction summariser's input
   (`restart-compaction.ts:15`). Count how often it happens first.
5. Mark queue sessions "unattended", so routine clarifications follow the 10 Oct decision-7 rule (go ahead with the
   recommendation and log it) instead of setting the job aside.

## Step 3. U13: smaller screen ideas

1. Session menu: everyday actions first, the rest folded (15 entries become about 9, "Copy ▸" holding transcript, ids and
   folder); `ContextMenuItem` gains `disabledReason` and `children`.
2. Navigation by hubs: about 12 sidebar destinations instead of 52, with sub-pages as tabs; pair with the first list's C10
   command palette.
3. Countdowns that tick on scheduled jobs and wake-ups ("in 14 min", "due now, waiting for the session to be idle").
4. A shortcut to jump to the next session that needs James; "Waiting for you to sign in" instead of "Initializing" during
   sign-in waits.
5. A delivery line on each message with an honest "delivery uncertain, not retried" state. Log failed sends first to size
   it (most send errors retry five times, two seconds apart, even when the message may have arrived).
6. A "Session facts" popover: slowest tools, failed tools, calls that never returned, compactions.
7. The context panel says "Available on demand, not loaded" for deferred tools, and "Unverified" instead of 0.
8. If an "Everyday" view ever hides tool rows, one short sentence before each group of tool calls.
9. Pause the 55 infinite animations (40 files) when not visible.

## Step 4. H10: smaller tooltip items

1. Rename the `title` input on six shared components (`empty-state`, `page-header`, `settings-card`, `danger-zone`,
   `prompt-modal`, `task-preflight-card`) to `heading`, and ban `title` on component tags.
2. Delete `appTooltipTpl` if it is still unused after the migration.
3. Build and version details (version, build, branch, commit, data folder, with copy) in Settings > About, beside Phase A's
   migration levels. The renderer title bar has no Harness name element to hang a tooltip on, and a new title-bar item would
   work against Phase E's calmer title bar.

## Step 5. T15 items 2-7: OpenCode

1. Deliver Harness's stable rules through OpenCode's `instructions` file list (a hash-named file under the data folder), not
   only in the first message, because OpenCode 2's summary prompt drops injected instructions. Add a start-up check: an
   unreadable instructions file is skipped silently.
2. Show the compaction summary OpenCode already sends, in the divider tooltip with "Show summary".
3. Count OpenCode helper sessions (`task`, `explore`); until they are counted, deny helpers for unattended OpenCode spawns.
4. A6.2's pruning does nothing on OpenCode 2: use `tool_output` caps and `compaction.buffer` for unattended spawns.
   MiMo threshold built in 2026-10-28-plan-queue-mimo-spend (Step 4).
5. Close A6.6: OpenCode 2.0.28+ no longer cuts silent streams at five minutes.
6. Planner note: the first list's `opencode/packages/opencode/…` citations resolve only on `origin/v1`.

---

## Final verification

Canonical seven (`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, `npm run build:renderer`, `npm run test:quiet`); fresh-eyes completion gate (a new agent using the `task-completion-gate` skill), repeated until `VERDICT: PASS`.
Eyes-on checks go to `2026-10-20-oct2-later_livetest.md` (Windows PC; if it is down, stop and tell James, never fall back to the Mac).

## Finishing

Rewrite the Status block as an as-built summary, rename the history file `_history_completed.md`, then rename this file `_completed` last. Commit only when James asks.

> Plan Queue parked work: `queue/2026-10-20-oct2-later-7fb996` — 3 commit(s), reason: round-limit.

> Plan Queue parked work: `queue/2026-10-20-oct2-later-6e21da` — 4 commit(s), reason: land-blocked.
