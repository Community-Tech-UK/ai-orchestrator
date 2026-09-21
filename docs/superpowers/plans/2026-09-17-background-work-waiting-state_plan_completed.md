# Background Work Waiting State and Resume Reliability Plan

**Status:** Completed 2026-09-17. Live checks that need the rebuilt packaged app are deferred to [2026-09-17-background-work-waiting-state_plan_livetest.md](2026-09-17-background-work-waiting-state_plan_livetest.md).

**Follows:** [2026-08-29-provider-async-work-hibernation_plan_completed.md](2026-08-29-provider-async-work-hibernation_plan_completed.md) (registry, continuation and hibernation guards already built).

## Problem

James asked for a distinct rail indicator when a session is idle but waiting on
background work, and reported that such sessions often die or never resume until
he nudges them.

Evidence gathered 2026-09-17:

1. Session `c6czs5jux` (Claude): a Bash call hit its 120s timeout at 00:02 UTC and
   Claude CLI moved it to the background (`bv3kogvto`). The turn ended and the
   instance went `idle`. The job hung (Bitwarden locked). Nothing noticed; James
   sent `?` at 00:17 to wake it.
2. The async-work parser only recognises `run_in_background: true` and the text
   `Command running in background with ID:`. Local transcripts show ~210
   timeout-moved commands (`Command did not complete within its Ns timeout and
   was moved to the background (ID: …)`) that the registry never saw, so those
   sessions had no hibernation inhibitor.
3. A live probe of the current Claude CLI (`--print --output-format stream-json
   --input-format stream-json --verbose`, captured in `_scratch/bgprobe/`) shows
   task lifecycle arrives as `system` messages: `task_started`
   (`is_backgrounded`, `owned_by_subagent`, `task_type`), `task_updated`
   (`patch.is_backgrounded`), `background_tasks_changed` (authoritative list),
   `task_progress`, and `task_notification` (`status`). The app only parsed a
   `<task-notification>` tag in user text, so terminal events never fired and
   explicit background work stayed registered until process exit.
4. The CLI resumes by itself after a task notification while idle (new `init`,
   `result.origin.kind === "task-notification"`; 351 of 358 idle notifications in
   local transcripts). Once terminal events parse, the app's own continuation
   would duplicate that turn unless it becomes a fallback.
5. The registry state never reaches the renderer, so an idle-but-waiting session
   renders exactly like a finished one.

## Tasks

- [x] 1. Parse Claude `system` task messages (start, backgrounded, snapshot,
  progress, terminal, provider-resumed) and the timeout-moved result text.
  Ignore subagent-owned tasks.
- [x] 2. Registry: record start time, apply authoritative snapshots, emit a
  change event with count and oldest start time, dedupe terminal events by
  work id and status.
- [x] 3. Continuation: only for notifications that arrive while idle; wait a
  grace period and skip when the provider resumed on its own.
- [x] 4. Stall check-in: one automatic check-in when an idle session has had no
  activity for 10 minutes while background work is still registered.
- [x] 5. Publish `backgroundWork` (count, since) through the instance state
  update and IPC serialisation to the renderer store.
- [x] 6. Renderer: distinct rail indicator and header label for idle sessions
  waiting on background work.
- [x] 7. Focused tests, canonical verification checklist, fresh-eyes gate.

## As built

- `ClaudeBackgroundTaskTracker` in `src/main/cli/adapters/claude-cli-async-work.ts` parses Claude's
  `system` task messages; the adapter feeds it from the `system` case and resets it on exit. The
  tool-result regex also matches the timeout-moved wording.
- `InstanceAsyncWorkRegistry` records start times, applies snapshots, emits `work:changed` and
  `work:provider-resumed`, and dedupes terminals by work id and status.
- `InstanceAsyncWorkContinuation`: terminals arriving mid-turn are left to the CLI (evidence: a live
  mid-turn probe, plus transcript analysis showing the notification is absorbed, dropped because the
  model already read the output, or turned into a later turn). Idle terminals wait 15s and yield to
  `provider-resumed`. One stalled-work check-in per work set after 10 minutes of idle silence. Both
  automatic sends are held while the app is paused or a loop owns the session.
- `InstanceAsyncWorkPublisher` forwards changes via `InstanceManager.queueInstanceUpdate`;
  `InstanceStateManager.queueUpdate` writes `backgroundWork` onto the live instance (LT-160 pattern)
  and the renderer batch.
- Renderer: `backgroundWork` on the store types, batcher, both store merges and the list
  deserialiser; rail ring (`provider-background-waiting`) and header halo (`background-waiting`).
- `scripts/check-ts-max-loc.ts`: `claude-cli-adapter.ts` ceiling 2064 -> 2071.

## Verification

- Canonical checklist green on the final code: both `tsc --noEmit` configs, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`
  (25,002 tests), plus the later update-batcher spec (mutation-checked).
- Isolated dev app, real Claude (Haiku) session, two runs: indicator shown during the job, cleared
  after, CLI self-resumed, no duplicate continuation. Screenshots in `_scratch/bgwork-live/`.
- Fresh-eyes gate: four independent reviews; findings fixed (subagent snapshot ordering, stop during
  grace, pause/loop gate on the fallback continuation, live-object write-through test, batcher spec);
  final review VERDICT: PASS.
