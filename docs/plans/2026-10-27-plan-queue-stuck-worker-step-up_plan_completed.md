# Plan Queue: hand a stuck worker's document to a stronger model — plan

Status: implemented and verified 2026-10-27; live checks deferred to [the livetest doc](2026-10-27-plan-queue-stuck-worker-step-up_plan_livetest.md). See "As built" at the end.

Spec: [2026-10-27-plan-queue-stuck-worker-step-up_spec_completed.md](2026-10-27-plan-queue-stuck-worker-step-up_spec_completed.md).
Read the spec first; this plan does not repeat its reasons.

**For James:** when a cheap worker (for example Haiku) fails its checks in every round it is given, the queue
hands the document to a stronger model you pick (for example Opus) instead of stopping. Each document is handed
over at most once. It is off until you choose it on the Plan Queue page. Checkers still come from a different
maker. The last step is a real run against a scratch repository with the rebuilt app.

## Before starting

- [x] **Uncommitted Plan Queue work from another session.** On 2026-10-27, about 33 Plan Queue files were
  changed and not committed (account rules, run handover, verifier selection; see
  `2026-10-27-plan-queue-account-rules_plan_completed.md`). That includes `plan-queue.schemas.ts`,
  `plan-queue-routing.ts`, `plan-queue-item-flow.ts`, `plan-queue-spawn.ts`, `plan-queue-tools.ts`,
  `plan-queue-tool-operations.ts`, `plan-queue-run-routing-change.ts` and the routing panel. Build on the working
  tree as it stands. Never stash, reset or revert it. If that work is still uncommitted when this starts, say so
  in the as-built notes; the final commit must not take in that session's files unless they are committed first.
- [x] Read in full: the spec, `plan-queue-item-flow.ts`, `plan-queue-routing.ts`, `plan-queue-spawn.ts`,
  `plan-queue-run-routing-change.ts`, `plan-queue-store.ts`, `plan-queue-prompts.ts`, `plan-queue-messages.ts`,
  `plan-queue-tool-operations.ts`, `src/main/mcp/plan-queue-tools.ts`, `plan-queue-verifier-select.ts`,
  `plan-queue-recovery.ts`, `plan-queue-run-hold.ts`, `packages/contracts/src/schemas/plan-queue.schemas.ts`, the
  routing panel and item list components, and their specs. Also read `docs/prompt-engineering-house-style.md`,
  `docs/screen-and-wording-guide.md`, and `2026-10-25-plan-queue-ranked-routing_plan_completed.md` for the last
  routing change's shape.
- [x] Baseline before any edit: `npm run test:quiet -- src/main/plan-queue src/renderer/app/features/plan-queue src/main/mcp`.
  Record any failures that were already there.

## Naming

Code uses `stepUp` (routing field), `step_up` (MCP arguments), `steppedUpAt` / `stepped_up_at` (item record),
and `planQueueSteppedUp` (spawn metadata). The screen says "If a worker gets stuck" and "Handed to a stronger
worker".

## Step 1. Contracts (`packages/contracts/src/schemas/plan-queue.schemas.ts`)

- [x] `PlanQueueRoutingSchema`: add `stepUp: PlanQueueRouteChoiceSchema.optional()`, with a doc comment (one
  choice; absent = stop and wait for James).
- [x] `PlanQueueStartArgsSchema`: add `step_up: PlanQueueRouteChoiceArgsSchema.optional()`.
- [x] `PlanQueueControlArgsSchema` set-routing `routing`: add `step_up: PlanQueueRouteChoiceArgsSchema.optional()`.
- [x] `PlanQueueItemDtoSchema`: add `steppedUpAt: z.number().int().nullable().optional()`.
- [x] Update the comment on `DEFAULT_PLAN_QUEUE_CONFIG.maxRounds` only if one is added; nothing else changes here.
- [x] Contract tests: a routing value with and without `stepUp` parses, an unknown field is still refused (strict),
  and start/control args accept `step_up`.

## Step 2. Persistence

- [x] `src/main/orchestration/loop-schema.ts`: migration `025_plan_queue_item_step_up`:
  `ALTER TABLE plan_queue_items ADD COLUMN stepped_up_at INTEGER;` with a comment saying why. Check the highest
  version on disk first. If another session added a migration 025, use the next free number.
- [x] `plan-queue.types.ts`: `PlanQueueItem.steppedUpAt?: number | null`.
- [x] `plan-queue-store.ts`: read and write the column wherever `worker_provider` / `worker_model` are handled (row
  type, insert/update statement, `rowToItem`).
- [x] `plan-queue-messages.ts` `itemToDto`: `steppedUpAt: item.steppedUpAt ?? null`.
- [x] Tests: migration upgrade test in the existing loop-schema migration spec (an older database gains the column,
  existing rows read `null`), and a store round-trip.

## Step 3. Routing (`plan-queue-routing.ts`, `plan-queue-run-routing-change.ts`, `plan-queue-tool-operations.ts`)

- [x] `PlanQueueRoutingOverride`: add `stepUp?: PlanQueueRouteChoice`.
- [x] `resolveRunRouting`: the saved `stepUp` wins; else `override.stepUp`. Add `'step-up'` to `setAside` when a
  per-run choice is set aside. Validate it with `assertRouteChoice(stepUp, 'worker', …)` (label it "Plan Queue
  step-up worker" in the reason; widen `assertRouteChoice`'s role/label minimally rather than duplicating it),
  normalise it, include it in `assertWorkerCopilotSeat`, and call `assertCheckersCanDiffer([...workers, stepUp], verifiers)`
  so explicit checkers must be able to judge it too.
- [x] `assertRoutingInstalled`: include `routing.stepUp`.
- [x] `describeRouting`: return a third line, `stepUp` ("stop and wait" when absent). Update every caller
  (`plan-queue-run-routing-change.ts` message, `plan-queue-tool-operations.ts` `runSummary`) so the parent's
  "James changed this run's …" message includes it.
- [x] `queueWorkerChoices`: when `config.metadata.planQueueSteppedUp === true` and the run has `routing.stepUp`,
  return `[stepUp]` with the same never-auto-pick handling as the worker list. Otherwise behave as today. This
  covers every respawn path, because they all go through `spawnWorker` → `spawnQueueInstance`.
- [x] `changeRunRouting`: pass `stepUp` through the same way as `workers` (the panel's and the parent's full edit
  replaces it; absent clears it).
- [x] `plan-queue-tool-operations.ts`: map `args.step_up` in `start` and in `toControlPayload` for set-routing,
  using `routeChoiceFromArgs`.
- [x] Tests (`plan-queue-routing.spec.ts`, `plan-queue-run-routing-change.spec.ts`, `plan-queue-tool-operations.spec.ts`):
  precedence (saved wins, per-run set aside and reported); refusals (not installed, never-auto-pick, never-use
  account, explicit checkers that cannot judge the step-up, Copilot seat on the never-use list); stepped-up spawn
  takes `stepUp`, an ordinary spawn takes the worker list, a stepped-up spawn on a run without `stepUp` takes the
  worker list; `describeRouting` text.

## Step 4. The handover (`plan-queue-item-flow.ts`, `plan-queue-prompts.ts`)

`plan-queue-item-flow.ts` is on the file-size allowlist at 706 lines (limit with slack: 756). Keep the additions
there small and put the prompt in `plan-queue-prompts.ts`.

- [x] `plan-queue-prompts.ts`: `buildStepUpPrompt(ctx, failedRounds, findings)`. Built as
  `buildResumePrompt(ctx, 'an earlier worker could not get this past the checker')` plus the findings in a
  `verifier_findings` data block (reuse the renderer in `buildFixPrompt`; extract a shared helper) plus: "An
  earlier, cheaper attempt did not pass after N verification rounds. Its work is on your branch. Treat it as a
  starting point: keep what is right, fix or redo what is not." Follow the house style (role first, data
  delimited, task last). Prompt tests in `plan-queue-prompts.spec.ts`.
- [x] `finishVerification`, at the `round >= run.config.maxRounds` branch: if `run.config.routing?.stepUp` is set
  and `!item.steppedUpAt`, call a new private `stepUp(item, round, verdict)` and return. Otherwise park as today.
  When the item has already been stepped up, the park detail starts "Still failing after the step-up worker's N
  verification round(s): …".
- [x] `stepUp(item, round, verdict)`, under the item lock already held:
  1. `await this.stopInstance(item.workerInstanceId)` when set. The worker is between turns here (the checker
     has just finished), and its round was checkpointed at turn end.
  2. Save first (the row is written before the side effect it authorises): `steppedUpAt: now`, `round: 0`,
     `erroredRounds: 0`, `verdict`, `workerInstanceId: null`, then transition to `fixing` with
     `detail: "Handed to a stronger worker (<describe stepUp>) after N failed checks."`.
  3. `await this.spawnWorker(saved, buildStepUpPrompt(…), null)`.
  4. `this.host.notifyParent(run, …)`: one message naming the document, the step-up choice and the rounds.
- [x] `spawnWorker`: add `planQueueSteppedUp: true` to `metadata` when `item.steppedUpAt` is set. This one line is
  what makes crash respawn, restart recovery (`resumeAfterRestart` handles `fixing`), Pause/Resume and parked
  Resume keep the step-up choice.
- [x] `resume()`: leave `steppedUpAt` as it is, so a Resume of a stepped-up parked item continues on the step-up
  choice and cannot hand over a second time. Add a one-line comment saying so.
- [x] The detail written in step 2 is cleared by the next `turn-complete` transition. The lasting record is
  `steppedUpAt` (Step 5 shows it).
- [x] Tests (`plan-queue-item-flow` specs; follow the existing fakes in `plan-queue-coordinator.spec.ts` /
  `plan-queue-pause-control.spec.ts`):
  - FAIL at the round limit with `stepUp` set: the old worker is stopped, the item is `fixing` with rounds reset
    and `steppedUpAt` set, and the new session is created with `planQueueSteppedUp` and lands on the step-up route
    (through `spawnQueueInstance`).
  - The stepped-up worker FAILs its rounds: the item parks `round-limit`, there is no second handover, and the
    detail mentions the step-up.
  - No `stepUp`: parks exactly as today (existing tests stay green unchanged).
  - Each other park reason (`provider-limit`, `worker-error`, `verifier-unreliable`, `no-diverse-verifier`,
    `merge-conflict`, `cancelled`) never hands over.
  - **Crash window:** `steppedUpAt` saved, spawn throws or the app "restarts" before the spawn. Boot recovery
    (`resumeAfterRestart` on the `fixing` item) starts the step-up route, and no second handover happens.
  - Pause during the handover's spawn (`PlanQueueSpawnRunPaused`): the item is held, and Resume continues on the
    step-up route.
  - Resume of a parked, stepped-up item keeps the step-up route.
  - The checker after a handover is chosen against the step-up worker's recorded provider and model.
  - Mutation-check the two guards (`!item.steppedUpAt`, the metadata line): removing each must fail a test.

## Step 5. Screen (`src/renderer/app/features/plan-queue/`)

Read `docs/screen-and-wording-guide.md` first and apply its section 6 when reviewing. All components stay
standalone, OnPush and signal-based.

- [x] Routing panel: a third group, "If a worker gets stuck", with two radio options, "Stop and wait for me" and
  "Hand it to a stronger worker". The second shows one route editor (the existing `routeEditor` template) and a
  one-line note: "Used once per document, after its worker fails every check it is given. Checkers still come
  from a different maker." Add a `'stepUp'` route list (single entry, no Up/Down/Add) to the draft state,
  `cleanChoice`, dirty/reset handling and save, for both `saved` and `run` modes.
- [x] Panel validation mirrors the main process: explicit checkers must be able to judge the step-up choice
  (reuse the existing `sameProviderCheckerCanDiffer` check); a step-up identical to the only worker line
  (same provider and model) shows "This is the same as the worker, so handing over would change nothing."
- [x] Model box: attach a `<datalist>` of the selected provider's models from `PROVIDER_MODEL_LIST` (name as the
  label, id as the value) to every route editor's model input. Free text still works. Check how the renderer
  already reads the provider model list (there may be a catalog service that includes discovered models; prefer
  that over the static table if the panel can reach it).
- [x] Item list: when `item.steppedUpAt` is set, show "Handed to a stronger worker" plus the run's step-up choice
  (provider / model) under the row head.
- [x] Run list summary: show the step-up choice beside workers and checkers.
- [x] Component specs: panel round-trip (set, change, clear, save in both modes), the two validation messages,
  datalist options change with the provider, and the item-list line.
- [x] `npm run check:ui-hints`.

## Step 6. Tool descriptions and docs

- [x] `src/main/mcp/plan-queue-tools.ts`: add `step_up` to `plan_queue_start` and to set-routing's `routing`
  object. Description: "Provider, model and accounts a document is handed to once, when its worker fails every
  verification round. Used only when James saved no step-up choice on the Plan Queue page. Pass only when James
  asked." Update `max_rounds`'s description to "Verification rounds before an item is parked, or handed to the
  step-up worker when one is set."
- [x] Update the Plan Queue sections of `docs/architecture.md` and `docs/AIO_MCP_CLI.md` (wherever the
  ranked-routing change documented `workers`). Regenerate any committed generated inventory the gates require
  (for example `docs/generated/architecture-inventory.json`) only through its generator.

## Step 7. Verification

- [x] Focused: `npm run test:quiet -- src/main/plan-queue src/renderer/app/features/plan-queue src/main/mcp packages/contracts`.
- [x] Canonical gates, each separately: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`,
  `npm run test:quiet`.
- [x] Fresh-eyes gate: a fresh agent that did not implement this reviews the diff with the `task-completion-gate`
  skill. Fix every actionable finding and repeat until `VERDICT: PASS`.
- [x] Live checks (forced handover, restart during the step-up worker's turn, off by default) moved to
  [2026-10-27-plan-queue-stuck-worker-step-up_plan_livetest.md](2026-10-27-plan-queue-stuck-worker-step-up_plan_livetest.md).
- [x] Close-out per the lifecycle: update the as-built notes here and in the spec, rename this plan
  `_plan_completed.md` and the spec `_spec_completed.md`, and fix the links. Only then stage the work and the
  `_completed` documents. Leave the livetest doc untracked until its checks pass.

## Risks

- **Other session's uncommitted changes** in the same files (see "Before starting"). The main risk is mixing that
  work into this commit.
- **Cost surprise:** a handover starts an Opus session on a document that already spent Haiku rounds. It happens at
  most once per document and only when James turned it on. Per-item spend already shows on the row.
- **The plan and the stronger worker disagree with the cheap attempt:** the prompt lets the stronger worker redo
  work. The checker still judges the final branch, so nothing unverified lands.

## As built (2026-10-27)

All steps are implemented. Differences from the plan, and why:

- **The handover lives in its own module**, `src/main/plan-queue/plan-queue-step-up.ts` (`canStepUp`,
  `stepUpItem`), not as a private method on `PlanQueueItemFlow`. Item flow stays at 725 lines (inside its
  ceiling plus tolerance) and is being edited by another session at the same time. Item flow only gained
  the import, the call in the round-limit branch, the `planQueueSteppedUp` metadata in `spawnWorker`, a
  park detail that names the step-up worker, and a comment in `resume()`.
- **The step-up task is also saved as the item's pending instruction** (`buildStepUpInstruction`), and the
  prompt is `buildStepUpPrompt` = resume prompt + that instruction. A Pause between recording the handover
  and the new session starting then carries the task into the resume prompt, instead of a "round 0 of N"
  fix prompt rebuilt from the verdict.
- **Checker diversity for the step-up worker has its own refusal message** ("None of the chosen checkers can
  check the step-up worker…"), rather than appending the step-up to the worker list, which would have
  named it "worker choice N".
- `describeRouteChoice` was extracted from `describeRouting` so the handover message and status use the
  same wording. `describeRouting` returns a third `stepUp` line ("stop and wait" when unset).
- The store reads `steppedUpAt` only when the column is set, matching `workerProvider`, so existing item
  fixtures and older rows read unchanged. The DTO carries `steppedUpAt: null` for those.
- The parent message after a handover says when the step-up worker could not start (the item parked) instead
  of promising more rounds. Remaining narrow gap, accepted by the reviewer: a session that is created and
  then fails while starting parks a moment after the message is sent.
- Item rows say "Handed to a stronger worker (provider / model) after N failed check(s)"; N is the run's
  round limit, which is exactly when a handover happens. `plan_queue_status` adds `routing.stepUp` and
  `handedToStepUpAt` per item; the run list summary adds "If stuck: …".
- Model suggestions come from the shared `UnifiedCatalogStore` (static, models.dev, discovered and custom
  models), falling back to `PROVIDER_MODEL_LIST` until it loads.
- Migration 25 (`025_plan_queue_item_step_up`) was the next free number.
- The architecture inventory check passed without regeneration.

Verification on 2026-10-27:

- Focused: Plan Queue main, renderer, MCP and contract specs pass. The handover tests are the
  coordinator block "handing a stuck document to the step-up worker" (8 tests: handover and landing,
  no second handover plus Resume, no step-up, verifier-unreliable and worker-error, restart between
  record and spawn, Pause during the spawn, a step-up worker that cannot start). Mutation check: removing
  the `!item.steppedUpAt` guard failed 2 tests; removing the `planQueueSteppedUp` metadata failed 4.
- Gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer` all exit 0 (the renderer's
  initial-bundle budget warning predates this change at the same size). Full suite: `npm run test:quiet` passed 35,665 tests in 2,820 files; after the final parent-message change the Plan Queue main, renderer, MCP and contract specs were re-run (2,094 tests in 164 files, all passed).
- Fresh-eyes gate: an independent reviewer returned VERDICT: PASS with no actionable findings. Its one
  optional note, the parent message when the step-up worker cannot start, was fixed and re-reviewed: PASS.
- Working tree: another session's uncommitted Plan Queue work (account rules, verifier reliability) shares
  several of these files. None of its hunks were changed; a commit must take only this task's hunks.

