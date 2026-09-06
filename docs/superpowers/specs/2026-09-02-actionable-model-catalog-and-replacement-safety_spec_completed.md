# Actionable Model-Catalog Drift and Replacement Safety

**Status:** COMPLETED 2026-09-02 — implemented, canonically verified, and accepted by a fifth fresh completion-gate pass.
**Date:** 2026-09-02
**Implementation plan:** [2026-09-02-actionable-model-catalog-and-replacement-safety_plan_completed.md](../plans/2026-09-02-actionable-model-catalog-and-replacement-safety_plan_completed.md)

## Problem

The existing model-catalog drift check detected the Fable 5.1 registry change, but it ran only on
push/PR, converted drift into a generic non-blocking warning, and created no durable work item. The
runtime models.dev merge could surface the new ID, but neither models.dev nor AIO expressed the
product decision that Fable 5.1 replaced Fable 5.

Separately, persisted model IDs can outlive a provider model. Existing automations, remembered
defaults, favourites, agents, remote spawns, and session changes must not forward an explicitly
replaced ID to a CLI and fail with `model not found`.

## Required Behaviour

1. AIO checks models.dev on a six-hour schedule independently of ordinary pushes and pull requests.
2. Drift produces a durable, deduplicated GitHub issue containing the exact generated snapshot diff
   and remediation instructions; the scheduled workflow fails until the drift is reviewed.
3. The existing push/PR drift probe remains non-blocking, but its script output identifies added,
   removed, and metadata-changed model IDs.
4. Replacement decisions are explicit and provider-scoped. AIO must not infer replacement solely
   from family names or release dates because providers intentionally retain selectable versions.
5. The replacement resolver supports future replacements through one declarative map and resolves
   replacement chains defensively without looping.
6. Fable 5 maps to Fable 5.1. Replaced IDs are automatically treated as retired picker entries while
   historical pricing remains available.
7. Saved automation definitions and run snapshots remain unchanged for auditability. Their effective
   model is canonicalized at preview/spawn time, including explicit pins, automation defaults, and
   favourite fallbacks.
8. Create-time model resolution canonicalizes replacements before local catalogue validation and
   before the remote-worker early return. Runtime model changes do the same before validation.
9. A recognized replacement is not reported as an unavailable-model degradation and never falls
   through to an unrelated provider default.
10. Unknown IDs and retired IDs without an explicit replacement retain current behaviour.

## Architecture

### Catalogue watcher

`scripts/sync-model-catalog.parse.ts` owns a pure snapshot diff function and formatter. The existing
sync script imports the committed snapshot, compares it with the freshly parsed registry, and prints
the exact added/removed/changed IDs when drift exists.

A dedicated `model-catalog-watch.yml` workflow runs every six hours and on manual dispatch. It
regenerates the snapshot in its ephemeral checkout. When the file changes, it writes the diff to the
job summary, creates or updates one open `Model catalog drift detected` issue, and deliberately fails
the scheduled run. It does not guess curation or automatically promote a model.

### Replacement compatibility

`PROVIDER_MODEL_REPLACEMENTS` lives beside the curated provider catalogue. Keys are historical IDs;
values are their approved canonical replacements. `resolveModelReplacementForProvider()` normalizes
provider namespaces and follows the map transitively with a visited-set cycle guard.

The replacement resolver is applied at three boundaries:

- `normalizeModelAliasForProvider`, covering existing general model-normalization callers;
- automation spawn-target resolution, so renderer preview and main runner agree;
- create-time and runtime-change validation, including remote execution.

Replacement is lazy. Database rows, automation action JSON, run snapshots, and usage history keep the
original ID; only the effective execution model changes.

Before publishing the unified picker catalogue, all static, models.dev, override, custom, and
CLI-discovered entries are checked against the replacement map. A replaced ID is omitted regardless
of which layer reported it, while its approved replacement remains selectable.

## Failure and Security Behaviour

- models.dev network/schema failure leaves the scheduled workflow failed without creating a false
  drift issue; the runtime remains fail-soft as today.
- The workflow receives only `contents: read` and `issues: write`; it cannot commit, push, release, or
  modify pull requests.
- Issue content contains only the generated public catalogue diff and workflow-run URL.
- A cyclic replacement declaration returns the original ID rather than choosing an arbitrary target.

## Verification

- Pure diff tests cover additions, removals, and metadata changes with deterministic ordering.
- Workflow parsing tests prove the schedule, least-privilege permissions, deduplicated issue update,
  exact diff capture, and fail-on-drift behaviour.
- Replacement tests cover Fable 5, namespace aliases, automation pins/defaults/favourites, local
  validation, remote validation, runtime changes, and unknown IDs.
- Run focused tests after each red/green cycle, then the canonical TypeScript, lint, LOC, build-main,
  and full quiet-suite gates.
- A fresh independent agent must return `VERDICT: PASS` before completion is claimed.

## Non-goals

- Automatically deciding that every new family member replaces every old one.
- Rewriting persisted automation/history rows.
- Automatically committing generated snapshots or opening model-promotion PRs.
- Changing the six-hour runtime models.dev refresh cadence.

## As Built

The implementation matches all ten required behaviours. Five independent completion-gate passes
found and drove fixes for inherited object keys, malformed replacement registries, catalogue-layer
leakage, bounded issue lookup, and prototype-shaped snapshot IDs. The fifth fresh pass returned
`VERDICT: PASS` with no unresolved actionable finding. Focused coverage passes 176 tests; TypeScript,
spec TypeScript, lint, LOC, Electron main/preload build, catalogue sync, workflow syntax, and diff
hygiene gates pass. A full pinned-Node suite also passed 20,575 tests during the final review cycle;
later concurrent runs showed only an unrelated loop-handler flake that passed independently.
