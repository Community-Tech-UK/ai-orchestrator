# Control Center route snapshot exception — remediation plan

Status: implementation ready for queue verification (2026-10-31); not independently verified or closed.

Source: the Settings exception recorded as branch-local LT-723 in
[the host-process/fence live test](2026-10-16-host-process-tools-and-fence-switch_livetest.md#evidence-run--2026-10-27).
The [Local AI report](2026-10-27-control-surface-route-snapshot_plan.md) records the same executing
constructor failure as LT-790. The coordinator's combine decision applies: one implementation,
with both reports' navigation checks retained. LT-723 also identifies an unrelated migration
failure on another branch; this change does not renumber or close register entries.
No separate specification is linked by either report.

## Implementation status

- [x] Retain the original dashboard → Settings reproduction and fresh-error-only receipt in
  `evidence/2026-10-27-host-process-tools/settings-route-repro.json`.
- [x] Pin the absent live-child snapshot before changing production code: real Angular router
  activation reproduces the same TypeError for Settings, Local AI, Automations and a nested route.
- [x] Instrument the exact lifecycle boundary: the shell's live first child has no snapshot
  immediately before outlet activation, while `route.snapshot.firstChild` already exists.
- [x] Make the smallest lifecycle-safe change: walk the complete `ActivatedRouteSnapshot` tree
  from `this.route.snapshot`; retain synchronous initialization, NavigationEnd updates,
  deepest recognized child selection, Settings help suppression and subscription teardown.
- [x] Add and run focused direct-load and navigation regressions, including active navigation,
  page headings, contextual help, unknown leaf metadata, shell reuse and shell recreation.
- [x] Run worker static checks, lint, size/UI checks, main/renderer production builds and committed
  generators. Final command results are recorded in the evidence receipts below.
- [ ] Queue verifier: run the full suite and independent task-completion gate; confirm the final
  diff and acceptance criteria before the coordinator closes this document.

Live Electron navigation checks from both reports are deferred to
[the combined live checklist](2026-10-27-control-surface-route-snapshot-remediation_livetest.md).
They remain unverified; focused router tests use real routing and shell templates but placeholder
feature content, and do not replace Electron/preload integration checks.

## As-built notes — 2026-10-31

All code changes are confined to the assigned worktree on
`queue/2026-10-27-control-surface-rou-2dbc08`:

- `src/renderer/app/shared/control-surface/control-surface-shell.component.ts:131`: start from the
  shell snapshot and traverse snapshot children, reading each node's own data. There is no catch,
  error suppression, optional snapshot guard, new scheduling or route selection fallback.
- `src/renderer/app/shared/control-surface/control-surface-shell.component.spec.ts:56`: real router
  regressions run with zoneless change detection and the application's shell/route metadata.
  A temporary RxJS error collector is restored in `finally`; every collected error fails the test.
  Original component checks are retained, with the mock supplying the complete snapshot tree.

Angular's installed router source confirms the ordering: `createNode` creates live descendants
before `ActivateRoutes.activateRoutes` calls the parent outlet and only then activates children
(`node_modules/@angular/router/fesm2022/_router-chunk.mjs:2123`, `:2300`). Snapshot traversal uses
the public recognized tree and does not depend on private future-snapshot fields.

Verification and cleanup receipts, the report and integrity seal are in
[`evidence/2026-10-31-control-surface-route-snapshot/`](evidence/2026-10-31-control-surface-route-snapshot/report.md).
The full suite is deliberately reserved for the queue verifier, per worker instructions.
The renderer production build passes with its existing initial-bundle size warning.
Generator runs produce no tracked changes. Renderer wording review: All clear.

This plan and the related active report remain untracked in the root checkout. Neither is
copied into the worktree, committed or renamed. The queue coordinator owns final verification,
closure and integration. No independent PASS is claimed by this worker.
