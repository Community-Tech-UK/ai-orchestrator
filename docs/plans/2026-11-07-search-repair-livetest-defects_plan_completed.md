# Fix the three defects found by the search-repair live checks

Status: complete in source, 7 November 2026; installed-app checks are in
[the live-test document](2026-11-07-search-repair-livetest-defects_plan_livetest.md). James approved
fixing all three ("Yes, go ahead").

Source: [search and memory repair live checks](2026-11-06-search-and-memory-repair_plan_livetest.md),
register entries [LT-729](livetest-remediation-register.md#lt-729),
[LT-730](livetest-remediation-register.md#lt-730) and [LT-731](livetest-remediation-register.md#lt-731).

## 1. LT-729: the code index follows git's own ignore rules

Problem: `CodeIndexManager.loadIgnoreRules` reads only the workspace root's `.gitignore`, so files
ignored by nested `.gitignore` files, `.git/info/exclude` or the global excludes file are indexed and
can be added as code context. Measured on the live index: 22% of this repo's chunks, 94% of
`~/work/communitytech`, 10–11% of three other projects.

Change:

- New `src/main/codemem/code-index-ignore-rules.ts` builds the rules. In a git work tree it asks git
  for the untracked files it ignores (`git ls-files --others --ignored --exclude-standard --directory
  -z`) and matches those exact paths and folders, plus `DEFAULT_CODE_INDEX_IGNORES`. Outside git, or
  if git cannot run, it keeps today's rules (defaults plus the root `.gitignore`), logging a warning
  only for unexpected git failures.
- `CodeIndexManager.loadIgnoreRules` uses it, sharing one result per workspace for a few seconds,
  because `applyFileChange` reloads the rules for every changed file.
- The watcher, reconciler and walk take a small `{ ignores(path) }` interface rather than the
  `ignore` package's type.
- Already-indexed ignored files are dropped by the existing reconcile, which removes manifest entries
  the walk no longer returns. It runs at index-worker start and in the periodic scan.

Could break: tracked files that match an ignore pattern are now indexed in git workspaces, as git
treats them. Non-git workspaces are unchanged.

Checks: unit tests for nested `.gitignore`, `.git/info/exclude`, a folder entry, a file created after
the rules were cached, a non-git folder, and reconcile removing a file that became ignored. Then
measure the live-index `git check-ignore` counts on a copy of the index after a reconcile.

## 2. LT-730: wrong built-in skills added by meaning

Problem: `skill-match` for bge-small is 0.62. Two real messages scored 0.629 and 0.639 against
unrelated skills and had them injected; the only right live match scored 0.670.

Change: choose the rule from evidence, not the three live points. Score real typed messages, which
should almost never get a built-in skill, plus the 34 curated prompts, against the built-in skill
descriptions with the production embedder, and compare floors (and, if it helps, a margin over the
second-best skill). Blind-label any real message that would still fire. Update `skill-match` and its
comment in `src/main/rlm/embedding/embedding-model.ts` with the measured result.

Checks: the evaluation log; the two live false positives score below the new floor; existing
skills-loader tests.

## 3. LT-731: the Linux release smoke closes its own display

Problem: `scripts/packaged-startup-smoke.js` wraps the app in `xvfb-run -a` when `DISPLAY` is unset.
The app relaunches itself and the first process exits 0, so `xvfb-run` stops its display and the real
app dies.

Change: the script no longer starts a display. On Linux without `DISPLAY` it fails at once with a
message to run it under `xvfb-run -a node scripts/packaged-startup-smoke.js`, and the release
workflow's Linux smoke step does exactly that.

Checks: unit tests for the Linux launch command and the missing-display error;
`release-workflow.spec.ts`; then the release job's Linux x64 steps in a clean
`node:24.22.1-bookworm` container on the Windows PC with the new smoke command.

## Added during the work: a cancelled warm reconcile was never retried

The live index had `cancel_requested = 1` on three workspaces, including this repo, set during
the warm-up timeouts after the 09:15 restart on 7 November. The warm reconcile clears the flag, but
`index-worker-main.ts` marked the workspace reconciled before the reconcile ran, so a reconcile
cancelled part-way was never retried, and the periodic scan's reconcile returned at once on the
flag. LT-729's clean-up of already-indexed files depends on that reconcile, so a cancelled one now
re-arms: the next warm clears the flag and reconciles again.

## As built

- LT-729: `src/main/codemem/code-index-ignore-rules.ts` (new), `code-index-manager.ts` (rules
  cached per workspace for 5 s), `code-index-watcher.ts` and `code-index-reconciler.ts` (take the
  `CodeIndexIgnoreRules` interface), `index-worker-main.ts` (retry after a cancelled reconcile).
  A workspace that its enclosing repository ignores (git answers `./`) uses the non-git rules.
  A change to an indexed file that git now ignores removes it from the index
  (`CasStore.hasManifestEntry`, new), added after the independent review noted that a file indexed
  in the first seconds of a build burst would otherwise stay until the next reconcile.
  Tests: `code-index-ignore-rules.spec.ts` (5), a cold-index-then-reconcile test and a
  drop-on-change test in `code-index-manager.spec.ts`, and a cancelled-reconcile retry test in
  `index-worker-main.spec.ts`; each fails with the old behaviour.
- LT-730: `skill-match` for bge-small raised from 0.62 to 0.68 in `embedding-model.ts`, with the
  measured reasons; a test keeps it above the highest wrong-skill score seen on real messages.
- LT-731: `getLaunchCommand` refuses a headless Linux launch with the command to use instead, and
  `release.yml` runs the Linux smoke as `xvfb-run -a node scripts/packaged-startup-smoke.js`.
  Tests updated in `packaged-startup-smoke.spec.ts` and `release-workflow.spec.ts`.

## Evidence

- LT-729, on an APFS copy of the live index (`_scratch/lt729/reconcile.log`): one reconcile per
  workspace with the new code removed 1,305 files from 12steps (4 s), 9,897 from communitytech
  (23 s) and 8,056 from this repo (42 s, after clearing the copied cancel flag). `git check-ignore`
  then found 0 ignored chunks of 20,805, 5,354 and 106,151. Ordinary search on this repo
  (`_scratch/lt729/search-eval.log`): right file in the top 10 69.0% → 67.5% and 60.2% → 59.7%,
  top 3 53.8% → 53.8% and 47.1% → 48.1%. The one relevant file removed no longer exists on disk;
  the rest of the movement most likely comes from the same reconcile re-indexing 2,824 files that had
  changed since they were indexed; it was not separated.
- LT-730 (`_scratch/lt730/eval.log`): the production embedder reproduced the three live scores
  (0.629, 0.642 against 0.639 recorded, 0.670). On 1,549 distinct real user messages, 591 of them
  300 characters or less: at 0.62, 42 short and 606 long messages would get a built-in skill. Of
  the 16 short ones scoring 0.645 to 0.674, judged by hand, 13 were wrong. At 0.68, one short
  message matches (`please fix the underlying testss` → `test-stabilizer`, right) and 8 long ones
  (7 browser-worker briefs → `ui-audit`, 1 Plan Queue answer → `docs-sweep`). The purpose-written
  prompts keep 10 of 34 right matches, none wrong, no off-topic fire. The check 6 dashboard prompt
  (0.670) no longer adds `visual-redesign`; no tested value kept it without also adding wrong
  skills. The evaluation uses built-in skills only, as production injects only those; user skills
  that would outrank a built-in make the real rate lower, not higher.
- LT-731, on the Windows PC on 7 November: the release job's Linux x64 steps at commit bdf416f21 in
  a clean `node:24.22.1-bookworm` container started with `--init` (`npm ci`, `npm run build`,
  `npm run electron:build -- --linux AppImage --x64 --publish never`, all exit 0). With `DISPLAY`
  unset, `xvfb-run -a node scripts/packaged-startup-smoke.js`, the new workflow command, exited 0
  with `Packaged startup smoke passed (linux)` as root and as the non-root `node` user, and no Xvfb
  or app process was left. With `DISPLAY` set the old and new scripts launch the app identically, so
  the pushed commit tests the new command. Earlier the same day the workflow's previous command
  failed both ways. The container, clone and image were removed and Docker Desktop stopped again.

## Known limits

- A git repository nested inside a workspace is listed by the outer repository as one untracked
  folder, so its own ignore files are not read. This was already true.
- Skill matching by meaning now rarely fires; triggers and slash commands remain the main way in.

## Gates

Final run on the finished code (`_scratch/gates-lt729/summary.txt`): `tsc --noEmit`,
`typecheck:spec`, `lint`, `check:ts-max-loc`, `check:ui-hints`, `build:main` and `build:renderer`
exit 0. Full suite: 46,687 of 46,692 tests passed; the 5 failures are all in
`scripts/remote-checks/checks.spec.ts`, an untracked file another session is writing (its module and
neighbours are modified in the tree), which passes 15 of 15 when run alone and passed in the first
full run (46,611 of 46,611) before the follow-up change. Two independent reviews returned
`VERDICT: PASS`; the first review's note about files indexed early in a build burst was fixed and
re-reviewed.

## Deferred live checks

Moved to [the live-test document](2026-11-07-search-repair-livetest-defects_plan_livetest.md):
the live index losing its ignored files after a rebuild, a day of skill matches at the new floor,
and the first real Linux release run.
