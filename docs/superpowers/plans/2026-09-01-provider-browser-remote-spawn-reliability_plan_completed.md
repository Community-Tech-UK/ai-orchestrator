# Provider Browser and Remote Spawn Reliability Plan

Status: completed 2026-09-20. Repository-wide closure is no longer blocked: the spec typecheck, the LOC ratchet and the full suite are all green on this tree. No live check is deferred.

Spec: [2026-09-01-provider-browser-remote-spawn-reliability_spec_completed.md](../specs/2026-09-01-provider-browser-remote-spawn-reliability_spec_completed.md)

## Implementation

1. Add failing Browser Gateway configuration and lifecycle tests for Cursor eager tool injection.
2. Add failing `run_on_node` tests for shared-tab rejection and readiness propagation.
3. Add failing model-selection and create-path tests for remote model isolation.
4. Implement a shared provider compatibility rule for Browser Gateway deferral.
5. Add a central `run_on_node` shared-browser boundary check, await `readyPromise`, and clarify MCP tool descriptions.
6. Add remote-aware model resolution that ignores coordinator defaults and catalogue validation while preserving explicit/agent models.
7. Run focused tests, canonical verification, and a fresh independent completion-gate review. Fix and repeat until it passes.

## Risk and Coverage

- Eager Cursor schemas increase initial tool tokens; this is intentional and covered by effective-mode tests.
- Prompt classification must reject only explicit shared Browser Gateway/existing-tab requests, not ordinary managed browser tests; positive and negative tests cover the boundary.
- Awaiting readiness makes `run_on_node` slower but changes its result from optimistic to truthful; rejection and success tests cover this.
- Remote model isolation changes implicit model selection only for forced/placed remote execution; explicit model tests and existing local precedence tests cover regressions.

## Verification

- Focused Vitest files for browser MCP config, lifecycle browser MCP, run-on-node support/wiring, model selection, and instance creation.
- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- `npm run check:ts-max-loc`
- `npm run build:main`
- `npm run test:quiet`
- Fresh `task-completion-gate` review.

No commit or branch operation is authorised by this plan.

## As-Built Status (2026-09-01)

- Cursor and Codex now receive eager Browser Gateway tools through one shared provider-capability rule; supported clients retain deferred loading.
- `run_on_node` rejects coordinator-owned Browser Gateway, shared/existing logged-in tab, concrete `browser.*` tool, and literal `browser.*` family requests before creating an instance. Explicit worker-managed Chrome remains allowed.
- `run_on_node` now awaits provider readiness and propagates worker startup failures.
- Remote instance creation no longer inherits coordinator remembered/global models or validates explicit remote models against the coordinator catalogue.
- Direct tool descriptions and dynamic MCP search hints now distinguish coordinator Browser Gateway from worker-managed Chrome.

Task-scoped verification is green: 11 focused files / 212 tests, main TypeScript, lint, `build:main`, and task-scoped `git diff --check`. A third fresh completion-gate review returned `VERDICT: PASS` with no task-owned findings after two earlier reviews identified regressions that were fixed.

**Closure note (2026-09-20).** The three blockers recorded above are resolved and were re-checked directly rather than taken on trust: `npx tsc --noEmit -p tsconfig.spec.json` exits 0 (it needs an 8 GB heap — the default OOMs the compiler, which is what made this look like a type error), `npm run check:ts-max-loc` exits 0 including `browser-gateway-action-guard.ts` and `browser-page.component.ts`, and `npm run test:quiet` passes 2167 files / 25734 tests. The repository-wide gates are clean, so the rename condition is met.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.
