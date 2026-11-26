# Mobile Active Session Filter Implementation Plan

> **For agentic workers:** Implement task-by-task with test-driven development. Do not create a branch or worktree, commit active planning documents, or disturb unrelated working-tree changes.

**Goal:** Add an accessible All/Active filter to the mobile Projects screen that matches desktop active-session semantics in both organization modes.

**Architecture:** A pure predicate in the mobile status module owns the desktop-aligned active status set. Project-list rows carry a view-model-only active flag, and the existing pure group filter combines state and text filtering before either project or chronological presentation.

**Tech Stack:** Angular 22 standalone components, TypeScript 6, signals, Vitest, SCSS.

**Status:** Completed and independently verified on 2026-07-26.

## As Built

- Added a desktop-aligned `isActiveSessionStatus()` predicate in the mobile status module.
- Added view-model-only active metadata and state-plus-search filtering that removes unmatched projects and history-only rows.
- Added a touch-sized, accessible All/Active segmented control shared by project and chronological organization modes.
- Added active-specific empty-state guidance without changing gateway DTOs, persistence, or session ordering.
- Verified the control at a 390×844 browser viewport; selection correctly transfers `aria-pressed` from All to Active.
- Verification evidence: 21 focused tests, 94 full mobile tests, mobile typecheck/lint/build, both root TypeScript checks, root lint, TypeScript LOC ratchet, and a cold full root suite of 15,877 tests all passed.
- Independent completion gate: `VERDICT: PASS`, no unresolved findings.

## Global Constraints

- Work on the current checkout; do not create a branch or worktree.
- Preserve unrelated dirty-tree changes.
- Follow TDD: observe focused tests fail before production edits.
- Keep the filter view-local; do not change gateway DTOs or persistence.
- Match the desktop active status list exactly.

---

### Task 1: Define mobile active-session semantics

**Files:**

- Modify: `apps/mobile/src/app/core/status.spec.ts`
- Modify: `apps/mobile/src/app/core/status.ts`

**Interfaces:**

- Produces: `isActiveSessionStatus(status: string): boolean`

- [x] **Step 1: Write the failing status-classification test**

Add one table-driven test asserting that all statuses named in the specification return `true` and terminal/error/hibernated statuses return `false`.

- [x] **Step 2: Run the focused test and verify RED**

Run from `apps/mobile/`:

```bash
rtk npx vitest run src/app/core/status.spec.ts
```

Expected: TypeScript/test failure because `isActiveSessionStatus` is not exported.

- [x] **Step 3: Implement the minimal predicate**

Add a readonly active-status set and:

```ts
export function isActiveSessionStatus(status: string): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 2: Filter mobile project groups by active state

**Files:**

- Modify: `apps/mobile/src/app/features/projects/project-list.view-model.spec.ts`
- Modify: `apps/mobile/src/app/features/projects/project-list.view-model.ts`

**Interfaces:**

- Produces: `SessionStateFilter = 'all' | 'active'`
- Produces: project-list session rows with `active: boolean`
- Changes: `filterProjectGroups(groups, query, stateFilter = 'all')`

- [x] **Step 1: Write failing view-model tests**

Extend fixtures with active idle/working sessions and inactive terminal/history sessions. Assert that:

- `active` keeps desktop-active live rows.
- `active` removes terminal live rows and history-only rows.
- Projects with no matching active rows disappear.
- Text search applies after state filtering and cannot restore inactive rows.

- [x] **Step 2: Run the focused test and verify RED**

Run from `apps/mobile/`:

```bash
rtk npx vitest run src/app/features/projects/project-list.view-model.spec.ts
```

Expected: active filtering assertions fail because the function currently accepts only text search and returns history rows.

- [x] **Step 3: Implement the minimal view-model change**

Create a private project row type extending `MobileSessionRowView` with `active: boolean`. Mark live rows with `isActiveSessionStatus(instance.status)` and history rows false. Apply state filtering before project/text matching, dropping groups with no state-matching rows.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 3: Wire the accessible quick filter into ProjectsComponent

**Files:**

- Modify: `apps/mobile/src/app/features/projects/projects.component.spec.ts`
- Modify: `apps/mobile/src/app/features/projects/projects.component.ts`
- Modify: `apps/mobile/src/app/features/projects/projects.component.scss`

**Interfaces:**

- Consumes: `SessionStateFilter`
- Consumes: `filterProjectGroups(groups, query, stateFilter)`
- Adds component signal: `stateFilter`

- [x] **Step 1: Write the failing component structure test**

Assert that the component source includes:

- `aria-label="Filter sessions by state"`
- All and Active buttons with `aria-pressed`
- `setStateFilter('all')` and `setStateFilter('active')`
- state filtering passed to the view-model
- `No active sessions` empty-state copy

- [x] **Step 2: Run the focused test and verify RED**

Run from `apps/mobile/`:

```bash
rtk npx vitest run src/app/features/projects/projects.component.spec.ts
```

Expected: assertions fail because the segmented control and state signal do not exist.

- [x] **Step 3: Implement the minimal component and styles**

Add the segmented control beside the heading, a `signal<SessionStateFilter>('all')`, a setter, active classes/`aria-pressed`, and pass the state into the shared group filtering used by both organization modes. Add touch-sized segmented-control styles and active-specific empty-state copy.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2 and expect PASS.

### Task 4: Verify and close

**Files:**

- Update and rename this plan to `2026-07-26-mobile-active-session-filter_plan_completed.md`
- Update and rename the linked spec to `2026-07-26-mobile-active-session-filter_spec_completed.md`

- [x] **Step 1: Run mobile verification**

Run from `apps/mobile/`:

```bash
rtk npx vitest run src/app/core/status.spec.ts src/app/features/projects/project-list.view-model.spec.ts src/app/features/projects/projects.component.spec.ts
rtk npm run typecheck
rtk npm run lint
rtk npm run build
```

- [x] **Step 2: Run repository canonical verification**

Run from the repository root:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

- [x] **Step 3: Run the independent fresh-eyes completion gate**

Have a genuinely fresh agent use the `task-completion-gate` skill to review the completed diff and acceptance criteria. Resolve every actionable finding and repeat until `VERDICT: PASS`.

- [x] **Step 4: Close documentation lifecycle**

Record as-built notes and current verification evidence, update the spec link to the completed plan filename, then rename both documents with `_completed`.
