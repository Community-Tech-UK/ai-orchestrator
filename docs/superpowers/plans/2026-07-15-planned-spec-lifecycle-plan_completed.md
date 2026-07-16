# Planned Spec Lifecycle Implementation Plan

> **For agentic workers:** Implement this plan inline. Keep this file untracked until all work is verified, then rename it with `_completed` before it may be committed.

**Goal:** Make `_planned` an explicit transitional suffix for a spec after its implementation plan has been created.

**Architecture:** Update both global instruction sources and the repository-local instruction source with the same state model. Preserve `_completed` as the only terminal state that permits staging or committing a plan or spec.

**Tech Stack:** Markdown instruction files and Git status verification.

## Global Constraints

- Preserve unrelated work in the dirty repository.
- Do not stage, commit, or push.
- A newly created spec or plan must remain untracked while active.
- `_planned` means a corresponding implementation plan exists; it does not mean implementation is complete.
- Only `_completed` or a project-defined closed-state suffix such as `_archived` permits committing the workflow document.

---

### Task 1: Update lifecycle instructions

**Files:**

- Modify: `/Users/suas/.codex/AGENTS.md`
- Modify: `/Users/suas/.agents/AGENTS.md`
- Modify: `/Users/suas/work/orchestrat0r/ai-orchestrator/AGENTS.md`

- [x] Add the transition from `<name>_spec.md` to `<name>_spec_planned.md` when the implementation plan is created.
- [x] Require the planned spec to link to the active plan.
- [x] State that `_planned` is active, uncommitted, and not evidence of implementation completion.
- [x] Define the searchable filename meanings for unplanned specs, planned specs, active plans, and completed documents.
- [x] Preserve the existing `_completed` and `_livetest` rules.

### Task 2: Verify and close the plan

- [x] Compare the lifecycle wording across all three instruction files.
- [x] Confirm no unrelated repository paths were changed by this task.
- [x] Record the as-built result in this plan.
- [x] Rename this file to `2026-07-15-planned-spec-lifecycle-plan_completed.md` only after verification.

## As Built

Updated `/Users/suas/.codex/AGENTS.md`, `/Users/suas/.agents/AGENTS.md`, and the repository `AGENTS.md` with the same planned-spec lifecycle. A fresh assertion command confirmed that all three files require the spec-to-plan link, the `_spec_planned.md` transition, continued untracked/uncommitted status, and the final `_completed` transition. `git diff --check -- AGENTS.md` passed. No build or automated test suite was run because the change affects Markdown instructions only.
