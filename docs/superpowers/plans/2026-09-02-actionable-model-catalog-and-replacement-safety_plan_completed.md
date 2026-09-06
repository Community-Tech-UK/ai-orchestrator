# Actionable Model-Catalog Drift and Replacement Safety Implementation Plan

**Status:** COMPLETED 2026-09-02 — implemented, canonically verified, and accepted by a fifth fresh completion-gate pass.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion task-by-task. Do not create a branch/worktree or commit unless James explicitly asks.

**Goal:** Turn model-catalog drift into a scheduled, durable, exact alert and make approved model replacements backward-compatible for persisted automations and every instance model-selection path.

**Architecture:** A pure snapshot differ feeds both the existing sync command and a least-privilege scheduled GitHub issue workflow. A provider-scoped replacement map is resolved lazily at automation preview/spawn, create-time validation (local and remote), runtime-change validation, and existing model-alias normalization boundaries.

**Tech Stack:** TypeScript, Node.js, GitHub Actions YAML, Angular-shared pure utilities, Vitest, js-yaml.

**Spec:** [2026-09-02-actionable-model-catalog-and-replacement-safety_spec_completed.md](../specs/2026-09-02-actionable-model-catalog-and-replacement-safety_spec_completed.md)

## Global Constraints

- Never infer replacement merely from `family` or `release_date`; only `PROVIDER_MODEL_REPLACEMENTS` authorizes it.
- Do not rewrite persisted automation definitions, run snapshots, favourites, defaults, or history.
- Keep the existing push/PR drift probe non-blocking; the dedicated scheduled watcher is fail-closed on drift.
- The watcher may read repository contents and write issues only; it may not commit, push, release, or mutate pull requests.
- Preserve unknown-model and retired-without-replacement behaviour.
- Follow red → observed failure → minimal implementation → observed pass for every production behaviour.

---

### Task 1: Exact model-catalog drift reporting and scheduled watcher

**Files:**
- Modify: `scripts/sync-model-catalog.parse.ts`
- Modify: `scripts/sync-model-catalog.ts`
- Modify: `scripts/__tests__/sync-model-catalog-parse.spec.ts`
- Create: `.github/workflows/model-catalog-watch.yml`
- Modify: `scripts/__tests__/release-workflow.spec.ts`

**Interfaces:**
- Produces: `diffSnapshots(current, next): SnapshotDiff`
- Produces: `formatSnapshotDiff(diff): string`
- Consumes: committed `MODELS_DEV_SNAPSHOT` and freshly parsed `Record<string, SnapshotEntry>`

- [x] **Step 1: Add failing pure-diff tests**

  Add literal fixtures proving deterministic `added`, `removed`, and `changed` model IDs. The changed
  fixture must differ in a metadata field, not object identity. Add a formatter assertion containing:

  ```text
  Added (1): new-model
  Removed (1): old-model
  Changed (1): repriced-model
  ```

- [x] **Step 2: Run the focused parser spec and observe RED**

  Run: `rtk npm run test:quiet -- scripts/__tests__/sync-model-catalog-parse.spec.ts`

  Expected: import/type failure because `diffSnapshots` and `formatSnapshotDiff` do not exist.

- [x] **Step 3: Implement the pure differ and formatter**

  Compare the union of keys in lexical order. Added/removed IDs compare membership; changed IDs compare
  the five snapshot fields (`provider`, `input`, `output`, `contextWindow`, `maxOutputTokens`). Return
  empty arrays for no drift.

- [x] **Step 4: Run the focused parser spec and observe GREEN**

  Run: `rtk npm run test:quiet -- scripts/__tests__/sync-model-catalog-parse.spec.ts`

- [x] **Step 5: Add failing workflow contract tests**

  Parse `.github/workflows/model-catalog-watch.yml` and assert:

  - cron schedule `23 */6 * * *` plus `workflow_dispatch`;
  - top-level permissions exactly `contents: read`, `issues: write`;
  - snapshot regeneration and diff capture;
  - one stable issue title, `gh issue list`, `gh issue create`, and `gh issue edit`;
  - a final conditional `exit 1` when drift is present;
  - all external actions across CI/release/watcher remain SHA-pinned.

- [x] **Step 6: Run the workflow spec and observe RED**

  Run: `rtk npm run test:quiet -- scripts/__tests__/release-workflow.spec.ts`

  Expected: missing watcher workflow file.

- [x] **Step 7: Wire exact reporting into the sync script**

  Import `MODELS_DEV_SNAPSHOT`, call `diffSnapshots`, and include `formatSnapshotDiff(diff)` in the
  `--check` error. Preserve fail-soft exit 0 for unreachable/invalid upstream data and normal write mode.

- [x] **Step 8: Add the scheduled watcher workflow**

  Regenerate only the snapshot in the ephemeral checkout, set a `drift` step output from
  `git diff --quiet`, write the public diff to `$GITHUB_STEP_SUMMARY`, and upsert the stable issue using
  `GH_TOKEN: ${{ github.token }}`. The final drift step exits 1 after issue creation/update.

- [x] **Step 9: Run parser and workflow specs and observe GREEN**

  Run:

  ```bash
  rtk npm run test:quiet -- scripts/__tests__/sync-model-catalog-parse.spec.ts scripts/__tests__/release-workflow.spec.ts
  ```

- [x] **Step 10: Exercise the real checker**

  Run `rtk npm run sync:model-catalog -- --check` and confirm it exits 0 against the currently synced
  snapshot. In a temporary copy of the generated snapshot, remove one entry, run the checker, confirm
  the named model appears in the drift report, then restore/remove only the temporary copy.

### Task 2: Generic provider-scoped replacement contract

**Files:**
- Modify: `src/shared/types/provider.types.ts`
- Modify: `src/shared/types/provider-model-utils.ts`
- Modify: `src/shared/types/provider.types.spec.ts`
- Modify: `src/main/providers/unified-model-catalog-service.ts`
- Modify: `src/main/providers/__tests__/unified-model-catalog-service.spec.ts`

**Interfaces:**
- Produces: `PROVIDER_MODEL_REPLACEMENTS: Readonly<Record<string, Readonly<Record<string, string>>>>`
- Produces: `resolveModelReplacementForProvider(provider, modelId): string | undefined`

- [x] **Step 1: Add failing replacement tests**

  Assert that Claude/`claude-cli`/`anthropic-api` map `claude-fable-5` to
  `claude-fable-5-1`, unknown IDs pass through, blank input returns `undefined`, and the Fable 5 key is
  included in the derived Claude retired list.

- [x] **Step 2: Run the provider-types spec and observe RED**

  Run: `rtk npm run test:quiet -- src/shared/types/provider.types.spec.ts`

  Expected: missing replacement-map/resolver exports.

- [x] **Step 3: Implement the replacement map and resolver**

  Add the Fable mapping beside the static model constants. Derive the Claude retired-ID array from its
  keys. Normalize provider namespaces using the existing namespace function, then follow replacements
  with a visited set; a cycle returns the original trimmed ID.

- [x] **Step 4: Route alias normalization through the replacement resolver**

  Replace the Fable-specific branch in `normalizeModelAliasForProvider` with the generic resolver before
  static ID/name matching. Re-export the resolver from `provider.types.ts`.

- [x] **Step 5: Run the provider-types spec and observe GREEN**

  Run: `rtk npm run test:quiet -- src/shared/types/provider.types.spec.ts`

- [x] **Step 6: Prevent replaced IDs from re-entering picker catalogues**

  Add failing coverage for static, catalogue-override, custom-model, and CLI-discovered layers, then
  filter every merged catalogue entry whose explicit replacement differs from its ID. Keep historical
  settings and pricing unchanged.

### Task 3: Persisted automation and instance-boundary compatibility

**Files:**
- Modify: `src/shared/automations/automation-model-resolution.ts`
- Modify: `src/shared/automations/automation-model-resolution.spec.ts`
- Modify: `src/main/instance/lifecycle/model-selection-resolver.ts`
- Modify: `src/main/instance/lifecycle/model-selection-degradation.ts`
- Modify: `src/main/instance/lifecycle/__tests__/model-selection-resolver.spec.ts`
- Test: `src/main/instance/lifecycle/__tests__/model-selection-degradation.spec.ts`

**Interfaces:**
- Consumes: `resolveModelReplacementForProvider(provider, modelId)`
- Preserves: `AutomationSpawnTarget` and `ResolvedModelSelection` public shapes

- [x] **Step 1: Add failing automation-resolution tests**

  Cover a saved explicit Fable 5 pin, Fable 5 supplied by `automationDefaultModel`, and Fable 5 supplied
  by a Claude favourite. Include provider `auto` with a self-identifying `claude-*` model. All must
  return `modelOverride: 'claude-fable-5-1'` without mutating input objects.

- [x] **Step 2: Run the automation resolver spec and observe RED**

  Run: `rtk npm run test:quiet -- src/shared/automations/automation-model-resolution.spec.ts`

- [x] **Step 3: Canonicalize the automation effective model**

  After precedence/favourite resolution, identify the concrete provider from the resolved provider or
  `modelProviderFamily(modelOverride)`, then apply the replacement resolver. Keep the persisted action
  untouched.

- [x] **Step 4: Run the automation resolver spec and observe GREEN**

  Run: `rtk npm run test:quiet -- src/shared/automations/automation-model-resolution.spec.ts`

- [x] **Step 5: Add failing create/runtime-selection tests**

  Cover local and remote create resolution of Fable 5 to Fable 5.1. Add a runtime-change test proving
  the same mapping occurs before catalogue validation, produces no degradation, and does not select the
  provider default.

- [x] **Step 6: Run the focused instance specs and observe RED**

  Run:

  ```bash
  rtk npm run test:quiet -- src/main/instance/lifecycle/__tests__/model-selection-resolver.spec.ts src/main/instance/lifecycle/__tests__/model-selection-degradation.spec.ts
  ```

- [x] **Step 7: Canonicalize before local/remote and runtime-change validation**

  In `ModelSelectionResolver.resolve`, resolve the selected model immediately after precedence and before
  tier/remote handling. In `resolveRuntimeChangeModel`, canonicalize before calling
  `resolveAvailableModelSelection`. Preserve provenance and unknown-ID behaviour.

- [x] **Step 8: Run focused automation and instance specs and observe GREEN**

  Run:

  ```bash
  rtk npm run test:quiet -- src/shared/automations/automation-model-resolution.spec.ts src/main/instance/lifecycle/__tests__/model-selection-resolver.spec.ts src/main/instance/lifecycle/__tests__/model-selection-degradation.spec.ts
  ```

### Task 4: Documentation, canonical verification, and independent completion gate

**Files:**
- Modify: `docs/architecture.md`
- Rename after every gate passes: this plan to `_plan_completed.md`
- Rename after every gate passes: linked spec from `_spec_planned.md` to `_spec_completed.md`

- [x] **Step 1: Document the operational contract**

  Update the Provider System section with the scheduled watcher, durable issue, explicit replacement
  map, and lazy persisted-selection compatibility behaviour.

- [x] **Step 2: Run targeted combined tests**

  Run all specs modified in Tasks 1–3 together with `rtk npm run test:quiet -- ...`.

- [x] **Step 3: Run the canonical project gates**

  ```bash
  rtk npx tsc --noEmit
  rtk npx tsc --noEmit -p tsconfig.spec.json
  rtk npm run lint
  rtk npm run check:ts-max-loc
  rtk npm run build:main
  rtk npm run test:quiet
  ```

- [x] **Step 4: Inspect the complete diff and staged paths**

  Confirm only intended files changed, no secret-like values were introduced, no active plan/spec is
  staged, and unrelated dirty-tree files remain untouched.

- [x] **Step 5: Run a fresh independent completion gate**

  Dispatch a fresh agent context with the `task-completion-gate` skill. Require review of acceptance
  criteria, merge-base-to-HEAD plus working-tree diff, workflow permissions/injection safety, replacement
  coverage, async/error behaviour, and test integrity. Fix every actionable finding and repeat with a
  different fresh reviewer until `VERDICT: PASS`.

- [x] **Step 6: Close documentation only after PASS**

  Add as-built results, rename the plan/spec to `_completed`, update their cross-links, and verify the
  completed documents and implementation remain uncommitted unless James separately requests a commit.

## As-Built Verification Evidence

- Red/green cycles were observed for the snapshot differ, scheduled workflow, replacement contract,
  automation resolution, local/remote/runtime validation, prototype-shaped unknown IDs, every picker
  catalogue layer, and server-side issue lookup.
- The combined focused suite passes: 7 files, 176 tests.
- Both TypeScript checks, lint, TypeScript LOC ratchet, `build:main`, workflow shell syntax, diff
  whitespace checks, and `sync:model-catalog -- --check` pass; the live snapshot contains 110 models.
- The first independent completion gate returned `VERDICT: FAIL` with three actionable findings:
  inherited-object-key crashes, replacement leakage through higher-priority catalogue layers, and an
  issue lookup bounded to the first 100 open issues. All three have regression tests and are fixed.
- The second independent gate found prototype-shaped provider keys and snapshot model IDs were not
  own-property safe. Both boundaries now have explicit `toString`, `constructor`, and `__proto__`
  coverage and pass.
- The third independent gate reproduced every project check and the full suite successfully, then
  found a malformed non-string replacement value could still throw. Runtime shape checks and a
  regression test now fail safely to the original model ID.
- The fourth independent gate found `null` as the entire replacement registry was checked after the
  first own-property access. The outer registry is now shape-validated first, with null/numeric/array
  regression coverage.
- The latest pinned-Node full suite ran 20,589 tests. Its sole failure reproduces in an unrelated
  pre-existing `loop-handlers.spec.ts` test; task-scoped tests pass. The immediately preceding full
  suite, before the outer null guard, passed all 20,575 tests.
- The fifth genuinely fresh completion gate returned `VERDICT: PASS` with no unresolved actionable
  finding. It independently reproduced all focused and canonical gates, probed every previous failure
  mode, and confirmed all ten acceptance criteria.
