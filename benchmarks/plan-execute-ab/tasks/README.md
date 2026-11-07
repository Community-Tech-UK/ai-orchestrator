# Task bank provenance

`task-bank.json` holds the 10 pilot tasks (30 are planned for the full run; the
bank is extended with the same miner before Phase 3).

## How tasks were mined

1. `npx tsx runner.ts mine --repo-id <id> --since <date>` lists commits that
   changed at least one test file alongside at least one source file
   (`_scratch/plan-execute-ab/mining/candidates-*.json` keeps the raw lists with
   draft prompts and leakage checks).
2. Commits with outcome-describing subjects were preferred; vague batch commits
   were only used where the behaviour could be read from the diff and tests
   (AIO-06: subject "architecture refactor", prompt written from the change).
3. Each chosen task was verified with
   `npx tsx runner.ts verify-task --task-file <task.json> --setup …`:
   the commit's own tests, copied onto the parent tree, must **fail** there and
   **pass** on the commit itself. Evidence (parent/commit run logs and a
   verification.json with exit codes) is in
   `_scratch/plan-execute-ab/mining/<TASK-ID>/`.
4. Prompt texts describe the outcome only: no commit shas, no changed file
   names, no diff lines (`leakageCheck` enforces this; results are in the
   candidates files).

## Repository choice (decision 3)

The plan recommended `ai-orchestrator` plus one or two smaller repos in another
stack (a Python or PHP project). All 10 tasks were verified fail-on-parent /
pass-on-commit on 2026-10-14.

- **ai-orchestrator** (6 tasks) — the large TypeScript codebase in the plan.
- **12steps** (4 tasks) — a different product and scale (full-stack Angular web
  app with deploy scripts and i18n). Verification uses `pnpm install
  --prefer-offline` inside the throwaway export.

No local Python or PHP repository could serve the second arm, because none has
commit history pairing test changes with fixes: `token-usage-monitor` has a
pytest suite but no git history; `screenshot-api`, `property-manager`,
`communitytech-plugin` and `ca-district-shop` are PHP without test suites;
`guywp-elementor` is Python without tests. This is recorded so James can point
the miner at another repo (any local git repo works — the miner is
repo-agnostic) if he wants real stack diversity.

## Size mix

| Size | Rule | Tasks |
|---|---|---|
| small | 1 source file | AIO-01, AIO-02, 12ST-01, 12ST-02 |
| medium | 2–5 source files | AIO-03, AIO-04, AIO-05, 12ST-03 |
| large | >5 source files | AIO-06 (8), 12ST-04 (6) |

The plan asked for roughly one third each; recent history in both repos offered
only two coherent >5-file commits (the larger candidates are vague batch or
harvest commits), so the pilot bank is 4/4/2. The full run can widen the large
tier from the older history if James wants it.

## Open human step

James skims the 10 task texts (about 10 minutes) before the pilot. Nothing in
the bank is blocked on that skim — it is a review gate he asked for in the plan,
not a correctness requirement.

## Scoring notes

- Hidden tests are the commit's test files, held back from the coder and copied
  in at scoring time.
- Damage checks are repo typecheck + lint (approximating "existing tests near
  the touched files"; the hidden-test command runs each task's whole spec files,
  which include their pre-existing tests).
- 12ST-03's two Playwright e2e specs are excluded from hidden tests (they need
  a built app and browsers); the two unit specs are the scoring tests. Recorded
  in the task's `verification.notes`.
