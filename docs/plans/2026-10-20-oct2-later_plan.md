# Oct-2 later (P2): useful, not before the rest

## Status

On main: no.

Verification round 1 re-audited (20 Oct 2026): BLOCKED_PREREQUISITES, not ready for completion verification.
Phase A is now in progress in its owning queue worktree but not integrated; B-F still report "Not started".
This checkout remains at base `542f1f690` with no implementation diff; Phase A's checkout guard is absent and its old
shared cost-repair cutoff remains. No feature code changed; 0 of 26 subitems newly implemented, all remain open,
including the verifier's pause, compaction-label and component/menu findings. Decisions 1(a) and 12(a) are answered;
the recorded prerequisite-audit decision explicitly preserves A-F ordering. Resume only after the coordinator supplies
the verified, integrated prerequisites and their required running-app evidence. Baseline checks are recorded in the
history; baseline green does not establish feature readiness. Full suite and independent verification remain with
the coordinator. Evidence, finding dispositions and per-item status:
[`2026-10-20-oct2-later_history.md`](2026-10-20-oct2-later_history.md). Keep this plan active; do not promote or rename it.

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

## Step 1. L11: "Pause new work" extends the existing pause (Decision 12)

Harness already has `PauseCoordinator` (`src/main/pause/pause-coordinator.ts`: `{isPaused, reasons, pausedAt}`, persisted),
whose pause refuses every message (`instance-manager.ts` `sendInput`, steer and revival paths) and has a title-bar toggle
(`pause-toggle.component.ts`) that James never sees because `pauseFeatureEnabled` is off ("Enable network pausing"). What it
lacks is a quiet skip where new work starts: the plan queue, loops and automations would start a session and then have its
first message refused, which the queue turns into a set-aside. If Decision 12 is (a):
1. Add a manual reason to `PauseCoordinator` and quiet checks at every start-of-work point (queue scheduler, loop round start,
   automation fire, wake-ups): skip and log, never fail. Running work finishes.
2. Show the existing toggle whenever a manual pause is possible, independent of the network-pause master switch. One chip:
   "Paused: <reason>. [Resume]". Tooltip: "Stops new loop rounds, queue jobs, scheduled runs and wake-ups from starting.
   Anything already running finishes."
3. An optional sentinel file in the data folder (and an `aio-mcp` command) engages it when the window is stuck.

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
5. Close A6.6: OpenCode 2.0.28+ no longer cuts silent streams at five minutes.
6. Planner note: the first list's `opencode/packages/opencode/…` citations resolve only on `origin/v1`.

---

## Final verification

Canonical seven (`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, `npm run build:renderer`, `npm run test:quiet`); fresh-eyes completion gate (a new agent using the `task-completion-gate` skill), repeated until `VERDICT: PASS`.
Eyes-on checks go to `2026-10-20-oct2-later_livetest.md` (Windows PC; if it is down, stop and tell James, never fall back to the Mac).

## Finishing

Rewrite the Status block as an as-built summary, rename the history file `_history_completed.md`, then rename this file `_completed` last. Commit only when James asks.
