# Plan Queue programme: each project folder gets its own checklist (rest of 1.8) — implementation plan

**Status:** Implemented 4 November 2026 in the queue worktree, awaiting independent verification. Written as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md).

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Decisions → settings that decide authority are operator-only (Design → Linear source → Settings that decide authority)
- Phases → Phase 1 (step 1.8)
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Part of 1.8 is already built and merged: `src/main/plan-queue/plan-queue-default-gates.ts` gives a run the default seven gates only when the project defines the npm scripts. What remains is: (1) a saved per-folder checklist, stored as an operator-only setting (follow how `planQueueAccountRules` is defined: schema, `settings.types.ts`, defaults, metadata, `settings-control-policy.ts` including `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`, the bootstrap reader); (2) an editor for it on the Plan Queue page (read `docs/screen-and-wording-guide.md` and `docs/angular-conventions.md` first; follow the existing account-rules panel's structure; plain wording, no jargon); (3) the rule that a saved list overrides the `verifier_gates` and `post_merge_gate` a session passes to `plan_queue_start`, while a caller may add gates only when there is no saved list. The post-merge gate follows the same rule.

## Steps (copied verbatim from the programme plan)

- [x] 1.8 **Each project gets its own checklist.** *(Partly built, see the as-built note below.)* The seven canonical gates are the default only when the run's
  folder is this repository. Other folders use a saved per-folder list, edited on the Plan Queue page, or, when none
  is saved, the existing "run the repository's own documented checks" path (`plan-queue-prompts.ts:252-254`). The
  post-merge gate follows the same rule. A saved per-folder list overrides the `verifier_gates` and
  `post_merge_gate` a session passes to `plan_queue_start`, because post-merge commands run in a shell. A caller can
  add gates when there is no saved list, never replace a saved one. Lower impact: 5 runs outside this repo used this
  repo's list. S.
  *As built so far (4 Nov 2026):* only the default rule. `plan-queue-default-gates.ts` gives a run the default
  checklists only when the project defines every `npm run` script in them (and has a `tsconfig.json` for `tsc`);
  otherwise `verifierGates` and `postMergeGate` start empty, which sends the verifier to the project's documented
  checks. Used from `startRun`; a caller's `config` still overrides. **Not built:** the saved per-folder list, its
  operator-only setting and the Plan Queue page editor, and "a saved list beats caller gates".

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- The saved list is operator-only: neither `$AIO_MCP settings` nor any agent-reachable settings tool can change it (a test proves it).
- A saved list beats caller-supplied gates; with no saved list a caller's gates still work.
- The Plan Queue page edits the list per folder, with plain wording, and `npm run check:ui-hints` and `npm run build:renderer` pass.
- Renderer tests cover the new panel.
- Every bullet of the step text above is met, or this plan's as-built notes say plainly, with the reason, which part was not and what remains.

## Verification

Run the targeted tests for what you changed, then:

- `npx tsc --noEmit`
- `npm run typecheck:spec`
- `npm run lint`
- `npm run check:ts-max-loc`
- `npm run check:ui-hints`
- `npm run build:main`
- `npm run build:renderer`
- `npm run test:quiet`

(Known: three `scripts/__tests__` tests fail on this machine because the installed Vite is older than `package.json` asks for; that is an environment fault, not yours. Say so rather than hide it.)

## Checklist

- [x] Step 1.8 implemented, wired, tested and verified (worker-side; the independent verifier still has to pass it)
- [x] As-built notes written below

## As-built notes

Worker notes, 4 November 2026. Nothing deferred to a `_livetest.md`: every check below ran here.

**What was built**

- **Setting.** `planQueueFolderChecklists`: an array of `{ folder, verifierGates, postMergeGate }`. Schema `PlanQueueFolderChecklistsSchema` in `packages/contracts/src/schemas/plan-queue.schemas.ts` (each entry needs at least one command; one entry per folder, trailing slashes ignored). Wired like `planQueueAccountRules`: `settings.types.ts`, `settings-defaults.ts` (`[]`), `settings-metadata-review-network.ts` (hidden), `settings-surfacing.ts` (`bespoke`), and `settings-control-policy.ts` both as `readOnly(...)` and in `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`. That makes it the 27th operator-only anchor, so the anchor count in `orchestrator-settings-tools.spec.ts`, `docs/AIO_MCP_CLI.md` and `docs/llm/AIO_MCP_CLI_REFERENCE.md` went from 26 to 27, and the docs describe the new key.
- **The rule.** New `src/main/plan-queue/plan-queue-folder-checklists.ts` (`savedChecklistFor`, `resolveRunGates`, `readSavedFolderChecklists`). `PlanQueueCoordinator.startRun` (`plan-queue-coordinator.ts`, where `config` is built) gives a folder with a saved list exactly that list for both `verifierGates` and `postMergeGate`, over the defaults and over anything in `input.config`. With no saved list the caller's gates replace the defaults as before. `StartRunResult.checklistSetAside` is true when the caller passed gates the saved list replaced, and `plan-queue-tool-operations.ts` then adds a sentence to the `plan_queue_start` answer. The `verifier_gates` / `post_merge_gate` tool descriptions in `plan-queue-tools.ts` say a saved list wins. The coordinator reads the list through a new optional dep `folderChecklists` (default: the settings manager, read at each start), so there was no separate bootstrap reader to add; `plan-queue-bootstrap.ts` is unchanged because the default already is the live settings read. Gates are stored on the run's config at start, so editing the setting later affects only later runs.
- **Editor.** New `plan-queue-folder-checklists-panel` component (ts, html, scss, spec) under `features/plan-queue/components/`, shown in the Setup tab of the Plan Queue page under "Checks for each project folder", after the account-rules panel and following its structure (draft, Save, Reset to saved, real error on a failed save). One card per folder with two text boxes, one command per line: checks before a checker reviews the work, and checks after merging a moved main branch. "Add a project folder" takes a typed path with suggestions from open sessions' folders. Wording avoids "gate" and internal names; no icon-only controls or native titles.
- `docs/architecture.md` has a new "Checks for each folder" bullet in the Plan Queue section.

**Choices made (no question asked, as nothing here was ambiguous in the repo)**

> Earlier journal sections moved to `2026-11-04-pq-a4-folder-checklists_plan_history_c60c0ed5616308b6d693ca4a19ec0f04f62856f3049cd344baa30cb7c2a8fede_completed.md`.
