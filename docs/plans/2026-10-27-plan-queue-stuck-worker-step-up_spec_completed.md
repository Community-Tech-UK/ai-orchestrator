# Plan Queue: hand a stuck worker's document to a stronger model — spec

Status: implemented and verified 2026-10-27; live checks deferred (see the plan's livetest doc). As-built notes are in the plan.

Implementation plan: [2026-10-27-plan-queue-stuck-worker-step-up_plan_completed.md](2026-10-27-plan-queue-stuck-worker-step-up_plan_completed.md).

Requested by James on 2026-10-27: build the "Opus plans → Haiku implements → independent review" workflow
into AIO natively ("I think that's a sensible way of doing things"), then write the spec and the plan.

## Why

The way of working James wants:

1. A strong model (Claude Opus) investigates and writes a thorough `*_plan.md`.
2. A cheap model (Claude Haiku) implements it.
3. A checker from a different maker reviews each round and sends failures back.
4. When the cheap model gets stuck, a strong model takes over instead of the work just stopping.

Steps 1–3 already work in the Plan Queue (verified by reading the code on 2026-10-27; not run live):

- The queue picks up `*_plan.md` files from disk (`plan-queue-discovery.ts:72-73`). An Opus chat can also start the run
  itself with `plan_queue_start` and choose the workers (`plan-queue-tools.ts:103-118`).
- The worker can be any provider and model (`PlanQueueRouteChoiceSchema`, `plan-queue.schemas.ts:150-155`). The model
  reaches the session through `routeQueueSpawn` → `modelOverride` (`plan-queue-routing.ts:436-437`) → the model resolved
  in `instance-lifecycle.ts:1433,1651-1658`. Claude's "Haiku latest" (`haiku`) is Haiku 5.5: the 5.5 models are Claude
  Code's defaults (`2026-10-10-oct-housekeeping_plan_completed.md`, decision 16).
- A checker from a different maker judges each round (`plan-queue-verifier-select.ts:87`, `plan-queue-routing.ts:257-279`),
  and a FAIL sends the findings back to the same worker (`plan-queue-item-flow.ts:538-541`).

Step 4 does not exist. When the worker uses up its check rounds (`maxRounds`, default 3), the item parks as
`round-limit` and waits for James (`plan-queue-item-flow.ts:533-536`). Nothing in the queue, loops or routing ever moves
work to a stronger model after failures (loops: `loop-auto-unstick.ts` only re-prompts; the only mid-loop model change
is a quota downshift to Sonnet, `loop-quota-throttle.ts:78-95`).

Evidence the split is worth having: in the 10-task pilot of
[the plan/execute benchmark](2026-10-14-local-model-plan-execute-ab_plan.md), Opus planning + Sonnet coding solved
the same 3/10 as Opus alone, about 3× faster and cheaper per solved task (`pilot-decision.md`, 24 Oct). Haiku was not
tested. The research that plan cites also says a cheap executor recovers only part of the gap to the strong model, so
a handover path is what makes a cheap default safe.

## What changes

1. **A new "If a worker gets stuck" choice** in Plan Queue routing, beside Workers and Checkers:
   - **Stop and wait for me** — today's behaviour, and the default.
   - **Hand it to:** one provider / model / accounts choice (the same editor as a worker line), for example Claude,
     "Opus latest".

   Stored as `stepUp` on `PlanQueueRouting`. Precedence matches the other roles: James's saved choice wins; a per-run
   `step_up` from `plan_queue_start` applies only when the saved setting has none; `set-routing` can change it for a
   run. An agent passes it only when James asked.

2. **When it applies:** only when an item would park because it used up its check rounds (`round-limit`). Every other
   reason to stop keeps today's behaviour, because a stronger model would not fix it: usage limits, a worker that
   crashed or could not start, an unreliable or missing checker, merge or worktree trouble, James closing the session,
   or the worker asking a question.

3. **The handover:**
   - The current worker session is stopped. The branch and worktree stay exactly as they are; the work so far is
     already checkpointed on the branch.
   - A new worker session starts on the step-up choice. Its prompt is the normal resume prompt plus the checker's last
     findings and a plain statement that an earlier, cheaper attempt did not pass and is a starting point it may keep,
     fix or redo.
   - The round counters reset, so the stronger worker gets the run's full `maxRounds`.
   - It happens once per item. If the stronger worker also uses up its rounds, the item parks as `round-limit`, and
     the detail says the step-up worker was tried too.

4. **It survives restarts.** The item records when it was handed over (`plan_queue_items.stepped_up_at`, new loop
   migration). The record is written before the new session is started. Every later worker session for that item uses
   the step-up choice: respawn after a crash, app restart, Pause then Resume, and James's Resume of a parked item. If
   the run's step-up choice is removed later, the item falls back to the run's ordinary worker choices.

5. **Checkers are unchanged.** A checker must still come from a different maker than the worker it judges; Claude
   Opus cannot check Claude Haiku. This is deliberate and matches the fresh-eyes rule in James's instructions. When a
   run starts or its routing changes, an explicit checker list must also be able to check the step-up choice, or the
   run is refused with a plain reason, as it is for workers today. After a handover the checker is chosen against the
   step-up worker; this already happens because each round records what its worker ran on (migration 024).

6. **James can see it happened:**
   - The document's row on the Plan Queue page says it was handed to the stronger worker, with which provider and model
     and after how many failed checks.
   - The session that started the run gets one message saying so.
   - `plan_queue_status` and the run summary show the step-up choice and which items were handed over.

7. **Easier model choice.** The model box in the Plan Queue routing editor (workers, checkers, step-up) offers the
   chosen provider's known models as suggestions ("Haiku latest", "Opus latest" and so on). Free text still works.
   Today it is a blank box (`plan-queue-routing-panel.component.html:26-35`).

## Recommended setup (stated, not enforced)

Workers: Claude, "Haiku latest". If a worker gets stuck: Claude, "Opus latest". Checkers: automatic (Codex today).
Write the plan in an Opus chat. Nothing is turned on by default; James chooses this on the Plan Queue page.

## Out of scope

- Letting a same-maker model be the checker (see point 5).
- Loops and Campaigns. Loops run one model per iteration with no handover concept; the Plan Queue is the home for
  "plan once, implement, check".
- A thinking-level (effort) setting for queue workers. Neither the queue nor loops have one today.
- Handing over more than once, or for reasons other than used-up rounds.
- Choosing automatically which plans go to the cheap model.
- Changing the benchmark experiment. Adding a Haiku arm there is a separate spend decision for James.

## Acceptance

- A run with a step-up choice whose worker fails every check in its rounds hands the item to the step-up choice
  instead of parking, exactly once, and the stronger worker's sessions run on the step-up provider and model.
- The handover keeps the branch, the worktree contents and the document; nothing is lost, reverted or committed by it.
- After a handover, a crash, app restart, Pause/Resume and Resume of a parked item all continue on the step-up choice.
  Removing the step-up choice mid-run sends later respawns to the ordinary workers.
- No handover happens for any park reason other than `round-limit`, or when no step-up choice is set.
- Start and routing-change validation refuse a step-up choice that the chosen checkers cannot judge, that is on the
  never-auto-pick list (unless the run relaxes it), or whose accounts are on the never-use list, with plain reasons.
- The Plan Queue page can set, change and clear the step-up choice for the saved setting and for one run. The item
  row, the parent message, `plan_queue_status` and the run summary show a handover. The model box offers suggestions.
- Older stored runs and settings without `stepUp` behave exactly as today.
- All canonical gates pass, the focused tests cover the crash window between "handover recorded" and "new session
  started", and an independent fresh-eyes review passes.

## Compatibility

`stepUp` is optional everywhere. Settings and stored runs without it read as "Stop and wait for me". An older build
reading a newer settings file or run ignores the field. The new column is nullable, so older rows need no backfill.

## As built (2026-10-27)

Every point under "What changes" is implemented as described. Two details differ in form, not behaviour:
the handover code is its own module (`plan-queue-step-up.ts`), and the item row names the handover
with the run's round limit as the number of failed checks. `plan_queue_status` shows the step-up choice
in the run's routing and a `handedToStepUpAt` time on each handed-over item.

Compatibility caveat: older stored runs, rows and settings without `stepUp` behave exactly as before
(tested). The routing schema is strict, though, so an *older build* that validates a settings value
carrying `stepUp` may refuse it rather than ignore it. This only matters when an older build shares
the settings file after James sets a step-up choice.

