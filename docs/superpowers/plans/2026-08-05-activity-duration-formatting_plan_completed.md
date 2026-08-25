# Activity Duration Formatting Implementation Plan

**Status:** Completed and independently verified on 2026-08-05

**Spec:** [2026-08-05-activity-duration-formatting_spec_completed.md](../specs/2026-08-05-activity-duration-formatting_spec_completed.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long-running activity-status durations readable by switching from total minutes to hours and days at natural boundaries.

**Architecture:** Extend the existing pure formatter inside `ActivityStatusComponent`; retain the component's inputs, timer, and visibility rules. Add a component-level spec that fixes the clock and asserts rendered elapsed labels.

**Tech Stack:** Angular 22 standalone components, TypeScript, Vitest, Angular TestBed

## Global Constraints

- Do not alter the three-second visibility delay or active-status logic.
- Use `Nh Nm` from exactly one hour and `Nd Nh Nm` from exactly 24 hours.
- Omit seconds once hours are displayed.
- Preserve unrelated work in the dirty checkout.
- Do not commit unless James explicitly asks.

---

### Task 1: Long-duration activity labels

**Files:**
- Create: `src/renderer/app/features/instance-detail/activity-status.component.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/activity-status.component.ts:21-30`

**Interfaces:**
- Consumes: `ActivityStatusComponent` inputs `status`, `activity`, and `busySince`
- Produces: rendered `.elapsed-time` text using seconds, minutes, hours, or days according to elapsed duration

- [x] **Step 1: Write the failing component tests**

Create the component through `TestBed`, set `status` to `busy`, fix `Date.now()`, and assert literal rendered values for `59s`, `59m 59s`, `1h 0m`, `1d 19h 50m`, and `1d 0h 0m`.

- [x] **Step 2: Run the focused spec and verify the new long-duration cases fail**

Run: `npm run test:quiet -- src/renderer/app/features/instance-detail/activity-status.component.spec.ts`

Expected: the sub-hour cases pass while hour/day cases fail because the formatter still emits total minutes and seconds.

- [x] **Step 3: Implement hour and day formatting**

After computing whole minutes, return `${hours}h ${remainingMinutes}m` for durations under 24 hours and `${days}d ${remainingHours}h ${remainingMinutes}m` from 24 hours onward. Keep the current seconds and minutes branches unchanged.

- [x] **Step 4: Re-run the focused spec**

Run: `npm run test:quiet -- src/renderer/app/features/instance-detail/activity-status.component.spec.ts`

Expected: all cases pass without warnings or errors.

- [x] **Step 5: Run the canonical repository gates**

Run in order:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

Expected: every command exits zero.

Evidence (2026-08-05): the focused spec passed 3/3; both TypeScript configs,
lint, the TypeScript LOC ratchet, and `build:main` exited zero. The initial
unsharded `test:quiet` run exhausted a Vitest worker's 4 GB Node heap without
an assertion failure. The documented four-way shard fallback then passed all
1,730 files and 18,020 tests (4,471 + 4,376 + 4,524 + 4,649).

- [x] **Step 6: Obtain independent completion review**

Dispatch a fresh agent that uses `task-completion-gate` and reviews the working-tree diff against this spec. Resolve every actionable finding and repeat with another fresh reviewer until the verdict is `PASS`.

- [x] **Step 7: Close the documentation lifecycle**

Record as-built details and verification evidence, update the spec link, rename this file to `2026-08-05-activity-duration-formatting_plan_completed.md`, and rename the spec to `2026-08-05-activity-duration-formatting_spec_completed.md`.

## As-Built Notes

- Added component-level coverage for sub-minute, sub-hour, one-hour, pre-day,
  24-hour, and screenshot-scale durations.
- Extended only the existing local `formatElapsed` helper; inputs, template,
  activity state, timer cadence, and teardown are unchanged.
- All focused and canonical checks passed using the full-suite shard fallback
  recorded above.
- Fresh completion gate: `VERDICT: PASS`, no findings or escalation.
- During verification, another session advanced `HEAD` and included the two
  source files in commit `fa22e01e`; this task did not create or amend that
  commit. The completed documents remain untracked.
