# Hidden Automations — Implementation Plan

Spec: [2026-08-13-hidden-automations_spec_completed.md](./2026-08-13-hidden-automations_spec_completed.md)
Status: COMPLETED — 2026-08-19 (live-test deferred, see below)
Date: 2026-08-13

## As-built (2026-08-19)

On investigation, every item in Phases 1–7 was **already implemented** in the working tree before
this session started (most likely landed alongside the 2026-08-18 automation containment/retry
work). This session verified the implementation against the plan and spec line by line rather than
re-implementing it, found it complete and in several places more careful than the plan's literal
text, and ran the full gate set. No source files were changed.

Notable deliberate deviations from the plan's literal wording, both improvements:

- `history-manager.ts` does **not** carry `isHiddenAutomation` forward via `previousEntries` the
  way the plan sketched (unlike `isAutomation`). It is set only when the runner positively records
  a clean finish (`instance.metadata.automationRunSucceeded === true`), stamped by
  `automation-runner.ts`'s `markInstanceAutomationRunSucceeded` *before* archival can race
  ahead of a failure/kill signal. This closes a real race the plan didn't anticipate: without it, a
  hidden automation killed mid-run at app shutdown could archive as invisible. See the comment at
  `history-manager.ts:262` and `automation-runner.ts:541` for the full rationale.
- The rail's failure/wait status sets are the actual shared constants
  (`AUTOMATION_FAILURE_STATUSES` / `AUTOMATION_WAIT_STATUSES` in
  `src/shared/types/instance-status-policy.ts`, re-exported as `FAILURE_STATUSES` /
  `WAIT_STATUSES` from `automation-runner-snapshots.ts`), consumed by
  `isAutomationAttentionStatus()` in both the runner and
  `history-rail-filtering.ts`. The "Escape-hatch drift" risk the plan called out is mitigated by
  construction, not just convention.
- The editor checkbox (`automations-page.component.html:436`) additionally documents that the
  `hidden` flag does not apply to loop-action automations, since those sessions come from the loop
  engine and carry no automation provenance today — consistent with the `Automation.hidden` doc
  comment in `automation.types.ts`.

Verification performed (see "Gate results" below): targeted tests for every touched file in the
plan (automation store, migration, runner, history manager, rail builder, rail filtering, MCP
tool schema, tool impl) all pass; the four canonical typecheck/lint/LOC/build gates are green.
Item 20 (fresh-eyes completion gate) is deferred back to the orchestrator per the campaign's
standard flow — this session is the implementer, not the independent reviewer.

### Gate results (2026-08-19)

- `npx tsc --noEmit` — clean.
- `npx tsc --noEmit -p tsconfig.spec.json` — clean.
- `npm run lint` — all files pass linting.
- `npm run check:ts-max-loc` — ratchet passed; no file touched by this feature is over its ceiling.
- `npm run build:main` — clean, `dist/preload/preload.js` rebuilt.
- Targeted `npm run test:quiet` — 9 files, 148 tests, all passed:
  `automation-store.spec.ts`, `automation-runner.spec.ts`, `history-manager.spec.ts`,
  `automations-hidden-migration.spec.ts`, `project-rail-builder.service.spec.ts`,
  `history-rail-filtering.spec.ts`, `history-restore-helpers.spec.ts`,
  `orchestrator-automation-tools.spec.ts`, `automation-tool-impl.spec.ts`.
- Full suite deliberately not run in this session — reserved for the orchestrator's final pass per
  the campaign brief.

Work proceeds in the order below; each phase gets targeted tests before the next.

## Phase 1 — Types and persistence

1. `src/shared/types/automation.types.ts`
   - `Automation.hidden?: boolean`
   - `CreateAutomationInput.hidden?: boolean`, `UpdateAutomationInput.hidden?: boolean`
   - `AutomationConfigSnapshot.hidden?: boolean`
2. `src/main/persistence/rlm/rlm-migrations-041-045.ts` — migration
   `044_automations_hidden`:
   - `ALTER TABLE automations ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`
   - curated `UPDATE automations SET hidden = 1 WHERE name IN (<the 7 from the spec>);`
   - `down`: `UPDATE automations SET hidden = 0 WHERE ...` then `DROP COLUMN hidden`.
3. `automation-store-types.ts` — `hidden` on the row/record type.
4. `automation-store-records.ts` — row ↔ record.
5. `automation-store-mappers.ts` — record → `Automation`; snapshot build includes
   `hidden`.
6. `automation-store.ts` — INSERT/UPDATE column lists and the `SELECT` projections.

Check: `automation-store.spec.ts` round-trips `hidden` on create, update, and
snapshot; a migration test asserts up/down and that only the 7 named rows flip.

## Phase 2 — Spawn provenance

7. `automation-runner-snapshots.ts` — carry `hidden` through
   `automationFromSnapshot` / `automationShellFromRunSnapshot`.
8. `automation-runner.ts` — at both dispatch sites (~:267 first attempt, ~:805 retry)
   add `automationHidden: <snapshot>.hidden === true ? true : undefined` alongside the
   existing `automationId` / `automationRunId` metadata.

Check: `automation-runner.spec.ts` asserts the metadata is stamped on both paths and
absent for a visible automation.

## Phase 3 — Archive carry-over

9. `src/shared/types/history.types.ts` — `ConversationHistoryEntry.isHiddenAutomation?: boolean`.
10. `src/main/history/history-manager.ts` (~:260) — alongside `isAutomation`:
    ```
    isHiddenAutomation:
      instance.metadata?.['automationHidden'] === true
      || previousEntries.some((e) => e.isHiddenAutomation)
      || undefined,
    ```
    The `previousEntries` clause matters: restoring and re-archiving a thread drops
    the live instance's automation metadata, which is exactly the bug the existing
    `isAutomation` comment warns about.

Check: history-manager spec covers first archive and re-archival after restore.

## Phase 4 — Rail filtering

11. `project-rail-builder.service.ts`
    - `ProjectRailBuildInput.showHiddenAutomations: boolean`.
    - New predicate, kept separate from `isProjectRailHiddenInstance` /
      `hideFromProjectRail`:
      - live: hide when `metadata.automationHidden === true`, the toggle is off, and
        `instance.status` is **not** in the failure or waiting-for-human sets;
      - archived: hide when `entry.isHiddenAutomation`, the toggle is off, and
        `entry.status !== 'error'`.
    - The failure/wait status sets must match the runner's own
      `FAILURE_STATUSES` / `WAIT_STATUSES` semantics
      (`automation-runner-snapshots.ts`) so "the rail shows it" and "the run failed"
      cannot drift apart. Share the constant rather than re-listing statuses.

Check: `project-rail-builder.service.spec.ts` covers hidden-and-healthy (hidden),
hidden-and-failed (shown), hidden-and-waiting (shown), toggle-on (all shown),
and that a `hideFromProjectRail` probe session stays hidden with the toggle on.

## Phase 5 — Rail toggle

12. `instance-list.types.ts` — `SHOW_HIDDEN_AUTOMATIONS_STORAGE_KEY`.
13. `instance-list-preferences.ts` — `loadShowHiddenAutomations()` /
    `saveShowHiddenAutomations()`, default `false`, same try/catch shape as the
    neighbours.
14. `instance-list.component.ts` / `.html` — signal, persistence, and a toggle in the
    existing filter cluster; pass into the rail builder input.

## Phase 6 — IPC, MCP, editor

15. `src/shared/validation/ipc-schemas.ts` — `hidden: z.boolean().optional()` on the
    create/update automation schemas.
16. `src/main/automations/automation-tool-impl.ts` — expose `hidden` on
    `create_automation` and `update_automation`, with a description that says what it
    does (quiet in the rail, still visible on the Automations page, still shown on
    failure).
17. `automation-form-model.ts` + `automations-page.component.html/.ts` — a "Hidden"
    checkbox with help text stating the failure escape hatch, so the guarantee is
    visible at the point of choosing.

## Phase 7 — Verification

18. Targeted specs for every touched file.
19. Canonical checklist: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
    `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`,
    `npm run test:quiet`.
20. Fresh-eyes completion gate on the merge-base-to-HEAD diff; fix findings and
    re-gate until PASS.

## Risks

- **The curated migration is install-specific data in shipped code.** Accepted
  deliberately (see spec); it is name-keyed, reversible, and touches nothing else.
  Any automation renamed before the migration runs simply stays visible.
- **Escape-hatch drift.** If the rail's failure set and the runner's `FAILURE_STATUSES`
  diverge, a broken hidden automation goes silent. Mitigated by sharing the constant
  and by an explicit test.
- **Restore-and-re-archive losing the flag.** Mitigated by the `previousEntries`
  fallback, matching the existing `isAutomation` handling.

## Deferred to live test

See `2026-08-13-hidden-automations_livetest.md` — checks needing a real rebuilt app against
James's real `harness` profile and real automation firings.
