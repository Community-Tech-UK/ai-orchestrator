# Stop Tracking `.ao` Activity State Implementation Plan

> **For agentic workers:** Execute this plan inline. Do not commit or push unless James explicitly asks.

**Status:** Completed

**Goal:** Preserve local `.ao` runtime activity state while preventing Git from tracking or surfacing it as a repository change.

**Architecture:** Add a repository-owned ignore rule for the entire `.ao/` runtime directory, then remove the existing `.ao/activity.jsonl` entry from Git's index with `git rm --cached`. The working-tree file must remain untouched.

**Tech Stack:** Git ignore rules and Git index operations.

## Global Constraints

- Preserve `.ao/activity.jsonl` on disk.
- Do not inspect or expose the activity log's contents.
- Preserve all unrelated working-tree and index changes.
- Do not commit or push.

## Task 1: Ignore local `.ao` runtime state

**Files:**

- Modify: `.gitignore`

- [x] Add `.ao/` alongside the existing AI Orchestrator project-memory/runtime ignore rules.
- [x] Verify `git check-ignore -v --no-index .ao/activity.jsonl` resolves to the repository `.gitignore` rule.

## Task 2: Stop tracking the activity log without deleting it

**Files:**

- Index-only removal: `.ao/activity.jsonl`

- [x] Record that `.ao/activity.jsonl` exists locally before the index operation.
- [x] Run `git rm --cached -- .ao/activity.jsonl`.
- [x] Verify `.ao/activity.jsonl` still exists locally.
- [x] Verify `git ls-files --error-unmatch -- .ao/activity.jsonl` fails because the path is no longer tracked in the index.
- [x] Verify Git status shows the staged repository deletion and no untracked `.ao` entry.

## Completion

- [x] Record the verification evidence and as-built result.
- [x] Change status to Completed and rename this file with `_completed` before the extension.

## As Built and Verification Evidence

- Added `.ao/` to the repository `.gitignore` under AI Orchestrator local runtime state.
- `git check-ignore -v --no-index .ao/activity.jsonl` resolved to `.gitignore:61:.ao/`.
- `.ao/activity.jsonl` existed before and after `git rm --cached -- .ao/activity.jsonl`.
- `git ls-files --error-unmatch -- .ao/activity.jsonl` failed as expected, proving the path is absent from the index.
- Scoped Git status showed `D  .ao/activity.jsonl`, ` M .gitignore`, and `!! .ao/`; it did not show an untracked `.ao` entry.
- No application tests, typecheck, or lint were run because this change affects only Git tracking and ignore metadata, not runtime source or build inputs.
- No commit or push was performed.
