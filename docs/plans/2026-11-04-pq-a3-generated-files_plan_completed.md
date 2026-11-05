# Plan Queue programme: generated files no longer block promotion — implementation plan

**Status:** Draft, written 4 November 2026 as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md). It is queued as its own job. Nothing implemented yet.

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Evidence → Code facts (generated-file overlaps are refused at promotion)
- Phases → Phase 1 (step 1.2)
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

This step changes the code that sets aside and restores James's uncommitted edits during landing, so **data safety comes first**: never discard an edit to a file that is not generated, never use `git stash`, keep the existing backup-and-recover design in `plan-queue-doc-merge.ts` (read it whole, including its manifest and recovery paths) and add a crash-window test for every new write. Also read `scripts/run-git-hook.js` and `scripts/test-staged.js` (they share the generated-artifacts list, and the batched-checks plan edits that file: re-read it before editing). If the safe mechanism is not clear after reading, park with a `needs-james` style question rather than guess.

## Steps (copied verbatim from the programme plan)

- [ ] 1.2 **Generated files don't block promotion.**
  - **The rule.** Promotion goes ahead when every non-markdown overlap with the root's uncommitted changes is a file
    the repository's pre-commit hook regenerates. Markdown overlaps still go through the merge helper as today.
  - **Today's failure point.** `prepare` stops at the first non-markdown path (`plan-queue-doc-merge.ts:160`).
    That's why 5 of the 6 recorded cases, which mix the generated file with the register, were refused.
  - **One list of generated files.** It is shared with the hook, not copied. For this repository, move the hook's
    `GENERATED_ARTIFACTS` array (three files, `scripts/run-git-hook.js:8-12`) into a small JSON file that both the
    hook and Harness read. A repository without such a file gets no special handling.
  - **Mechanics are the phase plan's job,** for example: set the root copy aside, fast-forward, then regenerate in
    the root with the repository's generator.
  - **Constraints:**
    - James's own edits to files that aren't generated are never discarded.
    - Staged as well as unstaged copies are accepted (`plan-queue-doc-merge.ts:161` takes only ` M` and `??`).
    - No `git stash`.
    - Coordinate with the other readers and editors of that list: `scripts/test-staged.js:15` imports it, and the
      batched-checks plan's Step 8 edits `run-git-hook.js`.
  - **Tests:**
    - Overlap only on the generated file: it lands, and the root copy matches a fresh regeneration.
    - Generated file plus register: it lands, through the merge helper.
    - Generated file plus code: still blocked. M.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- Overlap only on a hook-generated file: promotion proceeds and the root copy matches a fresh regeneration.
- Generated file plus a markdown register: lands through the existing merge helper.
- Generated file plus real code: still blocked, with James's edits untouched.
- Staged and unstaged copies both handled; the generated-file list is one shared JSON file read by both the hook and Harness.
- Crash-window tests for each new write, and mutation checks of each new guard.
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

- [ ] Step 1.2 implemented, wired, tested and verified
- [ ] As-built notes written below

## As-built notes

Step 1.2 built 4 Nov 2026 in the queue worktree. The programme plan was not edited.

### What was built

- **One shared list.** `scripts/generated-artifacts.json` holds `artifacts` (the three files that were `GENERATED_ARTIFACTS`) and `generators` (the three npm script names, in hook order). `scripts/run-git-hook.js` now reads both: `GENERATED_ARTIFACTS` is still exported (so `scripts/test-staged.js` is unchanged) and the pre-commit generate steps are built from `generators`. The hook's pre-commit command list is identical to before (`run-git-hook.spec.ts` still pins it). `scripts/__tests__/run-git-hook.spec.ts` copies the runner on its own into `.git`, so it now copies the JSON beside it too.
- **Harness side.** New `src/main/plan-queue/plan-queue-generated-files.ts` reads `scripts/generated-artifacts.json` with `git show` at the base tip and at the landing tip (validated with Zod: relative paths only, npm-script-style generator names). A repository with no such file at either tip gets no special handling. A file counts as generated only when **both** tips list it (so a path the landing newly lists, or stops listing, is still treated as James's hand-written file). The list is read only when a non-Markdown overlap exists; a malformed list blocks with a clear reason.
- **Promotion.** `plan-queue-doc-merge.ts` (the existing resolver, called by `promoteIntegrationBranch`; `worktree-integration.ts` is unchanged, it was at 690 of 700 lines) now accepts a non-Markdown overlap if it is a generated file, in status ` M`, `M `, `MM` or `??`. Anything else (code, or a generated file that is added, deleted, renamed or conflicted in the root) still blocks, and every refusal happens in the read-only loop before anything is backed up or moved. Generated entries go into the same durable backup and manifest as documents (`kind: 'generated'`; `ours-N` holds the working-copy bytes), are set aside (`git checkout HEAD -- file` resets index and working copy together; untracked files move to `aside-N`), and the fast-forward runs. `finish()` then checks the root holds the landing's copy, runs the landing tip's generators in the root (`npm run <script>`, 2-minute limit each, same process-group runner as the landing hook) so the root copy matches a fresh regeneration including James's other uncommitted work, and removes the backup. A generator failure is logged and the committed copy stays (valid; the hook rebuilds at the next commit); it never undoes a promotion that already happened.
- **Rollback and recovery.** `undo()` writes the saved bytes back and re-stages the file if any copy had been staged. Boot and retry recovery use the same rules: before the fast-forward the saved copy is restored (and re-staged); after it, the generated file is put back to the committed copy if it differs (covers a half-written rebuild), because none of James's hand edits are in it any more. Old manifests (no `kind`) still parse as documents.
> Earlier journal sections moved to `2026-11-04-pq-a3-generated-files_plan_history_f82ceca4786c66087a26f3b267187316ea2a90f70ce95d575903da0ce37ba24f_completed.md`.
