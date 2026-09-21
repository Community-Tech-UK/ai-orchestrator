# Architecture quality Phase 5 — local diagnostic tooling

Status: completed
Date: 2026-09-16
Parent: `docs/plans/2026-09-15-architecture-quality-remediation_plan.md`

## Scope

Add warn-only local gates. Do not fail CI. Do not bump Angular in this plan.

## Implementation notes

- 5.1 `scripts/check-knip.js` runs `npx knip` with a timeout and exits 0 unless `KNIP_STRICT=1`. Wired as `npm run check:knip`. `knip.json` scopes the scan to `src/`, `packages/*/src`, and `scripts/`, ignoring iOS build trees, benchmarks, and generated preload.
- 5.2 `scripts/check-circular-deps.js` / `npm run check:circular` already exists from an earlier increment.
- 5.3 Biggest unspecced files were already covered before this increment (loop-coordinator, instance-lifecycle, instance-manager, browser-gateway-service).
- 5.4 Angular stays on the current 22.1.x patch split (app 22.1.5 / CLI 22.1.7). A dedicated bump PR is out of scope here.
- 5.5 Console lint for `src/main` landed with Phase 1.

## Verification

`npm run check:knip` and `npm run check:circular` are warn/diagnostic. Canonical gates still apply for the code changes in sibling phases.
