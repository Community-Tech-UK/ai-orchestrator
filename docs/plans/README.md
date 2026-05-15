This directory holds planning and specification documents for the AI Orchestrator project.

## Active plans

Files directly in `docs/plans/` are active: they describe work that is either in progress or scheduled. Unfinished plans should remain untracked (not committed) until fully implemented. Once a plan is fully implemented and verified, rename it by appending `_completed` to the base name before committing (e.g. `my-feature-plan.md` becomes `my-feature-plan_completed.md`).

## Completed plans

`docs/plans/completed/` contains closed planning documents. A file moves here (via `git mv`) once:
1. All implementation work described in the plan is done and verified.
2. The file has been renamed with the `_completed` suffix.

No file in `completed/` should ever be edited to add new requirements. If follow-up work is needed, create a new dated plan file in `docs/plans/` instead.

## Naming conventions

- Active: `YYYY-MM-DD-feature-name.md` or `feature-name.md`
- Completed: `feature-name_completed.md` (moved to `completed/`)
- Big-change plans: `bigchange_<topic>_completed.md`
