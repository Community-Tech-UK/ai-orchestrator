# Angular 22 Upgrade Implementation Plan

> **For agentic workers:** Track every checkbox in order. Do not create a branch or worktree, do not commit active plan/spec files, and preserve unrelated working-tree changes.

**Goal:** Upgrade the root Electron renderer and the Capacitor mobile application from Angular 21 to Angular 22 with compatible tooling and verified behavior.

**Architecture:** Treat the root and mobile Angular workspaces as two independently locked migration units. Apply official migrations and dependency alignment to each, then verify each unit before running repository-wide gates.

**Tech Stack:** Angular 22, Angular CLI/build tooling, TypeScript 6.0, Angular CDK, angular-eslint, ngx-echarts, npm, Electron 40, Capacitor 7, Vitest

## Global Constraints

- Angular packages resolve to the latest mutually compatible Angular 22 patch releases.
- TypeScript resolves within `>=6.0.0 <6.1.0`.
- Node support remains compatible with `^22.22.3 || ^24.15.0 || ^26.0.0`.
- RxJS remains within `^6.5.3 || ^7.4.0`.
- Preserve the zoneless renderer and all unrelated dirty-tree changes.
- Do not hand-edit generated npm lockfiles.

---

### Task 1: Establish baseline and migration inputs

**Files:**
- Read: `package.json`
- Read: `package-lock.json`
- Read: `angular.json`
- Read: `tsconfig*.json`
- Read: `apps/mobile/package.json`
- Read: `apps/mobile/package-lock.json`
- Read: `apps/mobile/angular.json`
- Read: `apps/mobile/tsconfig*.json`

- [x] Read architecture, Angular conventions, testing guidance, dependency manifests, workspace configuration, and recent history.
- [x] Record current installed versions and official Angular 22 compatibility requirements.
- [x] Run baseline root typechecks, lint, and renderer production build.
- [x] Run baseline mobile typecheck and production build.
- [x] Record the pre-existing root spec-typecheck failure separately.

### Task 2: Upgrade the root Angular workspace

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify only if generated or required: `angular.json`
- Modify only if generated or required: `tsconfig*.json`
- Modify only if required: Angular renderer sources touched by official migrations

- [x] Run `ng update @angular/cli@^22 @angular/core@^22 --allow-dirty` without automatic commits.
- [x] Review every migration-touched file against the pre-upgrade state.
- [x] Align CDK, angular-eslint, ngx-echarts, and TypeScript to Angular 22-compatible releases.
- [x] Run `npm install` and confirm `npm ls` reports no invalid Angular peers.
- [x] Run root application/spec typechecks, Angular lint, and renderer production build.

### Task 3: Upgrade the mobile Angular workspace

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/package-lock.json`
- Modify only if generated or required: `apps/mobile/angular.json`
- Modify only if generated or required: `apps/mobile/tsconfig*.json`
- Modify only if required: mobile sources touched by official migrations

- [x] Run `ng update @angular/cli@^22 @angular/core@^22 --allow-dirty` from `apps/mobile/` without automatic commits.
- [x] Review every migration-touched file.
- [x] Align `@angular/build` and TypeScript to Angular 22-compatible releases.
- [x] Run mobile `npm install` and confirm `npm ls` reports no invalid Angular peers.
- [x] Run mobile typecheck and production build.

### Task 4: Update active version references

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/angular-conventions.md`
- Modify only if still version-specific: `src/renderer/app/app.config.ts`

- [x] Change current Angular 21 references to Angular 22.
- [x] Leave historical completed specifications unchanged.
- [x] Search active files for stale current-version references.

### Task 5: Final verification and completion gate

**Files:**
- Update and rename: this plan
- Update and rename: linked specification

- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Run root renderer production build.
- [x] Run mobile typecheck and production build.
- [x] Dispatch a fresh agent using `task-completion-gate` and resolve every actionable finding until `VERDICT: PASS`.
- [x] Record as-built versions and verification evidence.
- [x] Rename the plan and specification to `_completed.md` only after every required item passes.

## As-Built Verification

- Root: Angular/CLI 22.0.8, CDK 22.0.6, TypeScript 6.0.3, `angular-eslint` 22.1.0, `typescript-eslint` 8.65.0, `ngx-echarts` 22.0.0, Vitest 3.2.7, Zod 4.3.6.
- Mobile: Angular/CLI/build 22.0.8 and TypeScript 6.0.3.
- Root application and spec TypeScript checks, lint, LOC ratchet, production build, dependency resolution, lockfile dry run, and production audit passed.
- Root renderer production build retains the pre-existing non-fatal initial-bundle budget warning.
- Mobile dependency resolution, lockfile dry run, typecheck, and production build passed.
- The final isolated full Vitest run passed 1,590 files and 15,862 tests with zero failures and one unrelated platform-conditional skip.
- The first fresh reviewer found an unintended Zod 4.4.2 lock bump; pinning application Zod to 4.3.6 fixed the regression. A second genuinely fresh reviewer returned `VERDICT: PASS` with no remaining findings.
