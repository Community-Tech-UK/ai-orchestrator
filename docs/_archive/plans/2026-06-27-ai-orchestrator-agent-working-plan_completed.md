# AI Orchestrator Agent Working Plan

**Date:** 2026-06-27

**Goal:** Make changes in `/Users/suas/work/orchestrat0r/ai-orchestrator` safely, with enough investigation, scoped edits, and real verification before calling anything done.

## Current Baseline

- Repo is an Electron 40, Angular 21, and TypeScript 5.9 application.
- Main areas:
  - `src/main/` contains Electron and Node services, providers, orchestration, IPC, and persistence.
  - `src/renderer/` contains the Angular UI.
  - `src/shared/` contains shared types and validation.
  - `src/preload/` contains the IPC bridge.
  - `packages/contracts/` contains contract schemas, channels, and types.
- The current worktree already has uncommitted goal and command related changes. Treat them as user-owned unless explicitly asked to modify them.

## 1. Intake And Scope

- Confirm the requested outcome: bug fix, feature, refactor, review, docs, packaging, or release work.
- Identify whether credentials are needed.
- If credentials are needed, check project-local references first, then `/Users/suas/work/creds`.
- Never print secret values, tokens, OAuth details, certificates, private keys, or passwords.
- Do not commit, push, deploy, or modify server-side code unless explicitly asked.

## 2. Investigation Before Editing

- Read the full relevant files before changing anything.
- Trace imports, callers, IPC boundaries, schemas, tests, and shared types.
- Prefer `rg` and `rg --files` for discovery.
- For architecture context, use `docs/architecture.md`.
- For `bigchange_*.md` documents:
  - Read the plan fully.
  - Check whether parts are already implemented.
  - Implement incrementally.
  - Verify each phase before moving on.

## 3. Pre-Edit Plan

Before code changes, state:

- Files likely to change.
- Why those files are involved.
- Expected behavior change.
- What could break.
- Which tests or checks will cover the change.

## 4. Implementation Rules

- Follow existing repo patterns.
- Prefer TypeScript type safety and existing abstractions.
- Use `const` unless reassignment is required.
- Use generic constructor arguments where appropriate:

  ```ts
  const cache = new Map<string, Entry>();
  ```

- Avoid unnecessary variable type annotations when inference is clear.
- Remove unused imports.
- Keep changes tightly scoped.
- Do not refactor unrelated areas.
- Do not alter user-owned uncommitted changes unless necessary for the task.

## 5. Integration Checks

For main-process changes:

- Confirm singleton initialization where needed.
- Confirm IPC handlers are registered.
- Confirm event listeners are wired.
- Confirm startup and shutdown lifecycle is covered.

For IPC or contract changes:

- Update schemas, types, and channels together.
- If adding `@contracts/schemas/...` or `@contracts/types/...` subpaths, keep these in sync:
  - `tsconfig.json`
  - `tsconfig.electron.json`
  - `src/main/register-aliases.ts`
  - `vitest.config.ts` if tests import the new subpath.

For Electron or native dependency changes:

- After Electron version changes, run `npm run rebuild:native`.
- For new non-N-API native modules, update both native rebuild and ABI verification scripts.

## 6. Verification Gates

After code changes, run at minimum:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
```

Also run targeted tests for modified behavior.

After multi-file or cross-boundary changes, run broader checks:

```bash
npm run test
npm run verify:ipc
npm run verify:exports
npm run check:contracts
```

For larger work, use:

```bash
npm run verify
```

## 7. UI Work

For Angular and frontend changes:

- Follow standalone component, `OnPush`, and signals-based patterns.
- Match existing UI conventions.
- Verify in the actual UI when behavior or layout changes.
- Check text wrapping, responsive layout, and overlapping elements.
- Avoid landing-page style treatment for app and tool surfaces.

## 8. Testing Strategy

- Prefer focused failing tests before implementation when changing behavior.
- Run the specific test first.
- Then run typecheck and relevant suites.
- Do not fix by weakening tests unless the behavior expectation is genuinely wrong.
- For singleton tests, use `_resetForTesting()` patterns where available.

## 9. Completion Criteria

A task is only complete when:

- All requested items are handled.
- Relevant files were read before editing.
- Changes compile.
- Lint passes or any remaining issue is explicitly reported.
- Relevant tests pass.
- Imports and exports resolve.
- Any incomplete work is clearly listed.
- Final response includes an explicit status checklist.

## Status Checklist

- Converted the provided repo instructions into an operational plan: done.
- Checked `package.json` scripts against the plan: done.
- Checked `docs/architecture.md` for repo structure: done.
- Noted existing uncommitted work without modifying it: done.
- Saved this plan as a markdown file: done.
