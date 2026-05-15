# AI Orchestrator Improvement Opportunities (Cross-Project Deep Dive)

This document summarizes concrete improvements for `ai-orchestrator` based on code and workflow patterns from neighboring projects in this workspace (`opencode`, `t3code`, `openclaw`, and `nanoclaw`).

## How this was derived

- Reviewed `ai-orchestrator` build/test/provider/alias architecture and guardrails.
- Compared with peer projects' package scripts, architecture boundaries, and plugin/provider surfaces.
- Prioritized recommendations by: impact, implementation risk, and time-to-value.

## Priority recommendations

| Priority | Improvement | Why it matters | Borrowed from |
|---|---|---|---|
| P0 | Replace ESLint+Prettier-heavy flow with `oxlint` + `oxfmt` (staged rollout) | Major speedup in lint/format loop with low migration risk | `opencode`, `t3code`, `openclaw` |
| P0 | Add Turborepo task graph and cache for build/typecheck/test | Current `verify` is fully sequential and uncached | `opencode/turbo.json`, `t3code/turbo.json` |
| P0 | Generate `src/main/register-aliases.ts` from source-of-truth path config | Removes a known runtime crash footgun from manual alias sync | Existing `ai-orchestrator` generator pattern + peer "generated baseline" habits |
| P1 | Retire legacy SDK `BaseProvider`; promote adapter contract as single provider API | Avoids dual abstractions and wrong integration surface | `t3code` provider SPI discipline |
| P1 | Add explicit provider metadata (`supportsMultipleInstances`) and registry enforcement | Prevents invalid duplicate driver/provider instances | `t3code/apps/server/src/provider/ProviderDriver.ts` |
| P1 | Add import-boundary checks for plugin/extension architecture | Blocks accidental cross-layer imports that erode architecture over time | `openclaw` boundary scripts |
| P2 | Introduce `tsgo` in parallel with `tsc` for typecheck performance | Faster typechecking path with safe side-by-side validation | `openclaw` and `opencode` |
| P2 | Move completed plan docs out of root into structured docs path | Reduces repo-root noise and improves discoverability | `openclaw`/`opencode` release/doc hygiene |

## Detailed recommendations

### 1) Tooling speed lane: `oxlint` + `oxfmt`

**Current (`ai-orchestrator`)**
- `lint` uses `ng lint`.
- Type-aware ESLint and Angular linting increase CI/local turnaround.

**Peer pattern**
- `opencode` root scripts: `lint: oxlint`.
- `t3code` root scripts: `lint: oxlint`, `fmt: oxfmt`.
- `openclaw` root scripts: `lint` and `format` wrappers around oxlint/oxfmt family.

**Improvement**
- Add `oxlint` and `oxfmt`.
- Run in parallel with current linting for one release cycle.
- Keep Angular-specific rules either as targeted ESLint fallback or migrate to custom oxlint plugin (as done in `t3code` with its own plugin package).

**Expected impact**
- Faster feedback loops and reduced CI cost.

---

### 2) Build graph and cache: add Turborepo

**Current (`ai-orchestrator`)**
- `verify` script chains nine commands sequentially (`lint`, `typecheck`, `typecheck:spec`, verification scripts, tests, native rebuild, smoke check).
- No caching/orchestration layer.

**Peer pattern**
- `opencode/turbo.json`: typed tasks with outputs and dependency graph.
- `t3code/turbo.json`: dependency-aware task graph with `^build`/`^typecheck` semantics.

**Improvement**
- Introduce `turbo.json` for `build:*`, `typecheck`, `test`, and `verify:*` lanes.
- Start with `packages/contracts` and `packages/sdk` as cache-friendly foundations.

**Expected impact**
- Better CI parallelism, stable local incremental runs, and future-proofing as workspace grows.

---

### 3) Remove alias drift risk by codegen

**Current (`ai-orchestrator`)**
- `AGENTS.md` documents a critical runtime trap: `@contracts/schemas/*` aliases must stay synced across:
  - `tsconfig.json`,
  - `tsconfig.electron.json`,
  - `src/main/register-aliases.ts`,
  - `vitest.config.ts`.
- `scripts/check-contracts-aliases.ts` detects drift but does not prevent it.
- `src/main/register-aliases.ts` currently hard-codes many exact aliases.

**Improvement**
- Add generator script for `register-aliases.ts` from a single source (tsconfig paths + contracts exports).
- Run generator in `prestart`/`prebuild`, similar to existing channel generation flow.
- Keep drift check as a guard, but against generated output.

**Expected impact**
- Eliminates a known DMG/startup crash class while keeping validation strict.

---

### 4) Consolidate provider authoring surface

**Current (`ai-orchestrator`)**
- Two `BaseProvider` abstractions exist:
  - modern runtime/event-stream abstraction in `src/main/providers/provider-interface.ts`,
  - legacy class still exported in `packages/sdk/src/providers.ts`.

**Risk**
- External/provider plugin authors can target the wrong abstraction.

**Peer pattern**
- `t3code` provider SPI explicitly decodes config at registry boundary and keeps one driver contract.

**Improvement**
- Keep `packages/sdk/src/providers.ts` for types only.
- Remove/deprecate exported legacy `BaseProvider` class.
- Make `@sdk/provider-adapter` the canonical extension surface.

**Expected impact**
- Cleaner extension story and less internal contract confusion.

---

### 5) Enforce instance semantics with provider metadata

**Current (`ai-orchestrator`)**
- Provider instance multiplicity rules are mostly implicit/conventional.

**Peer pattern**
- `t3code` includes `supportsMultipleInstances?: boolean` in provider metadata and enforces at registry time.

**Improvement**
- Add capability/metadata flag for multi-instance safety.
- Reject invalid duplicate-instance startup early with actionable diagnostics.

**Expected impact**
- Fewer runtime edge-case failures and clearer provider onboarding rules.

---

### 6) Add explicit import boundary checks

**Current (`ai-orchestrator`)**
- `verify:architecture` checks inventory drift, but not strict import boundaries across all desired seams.

**Peer pattern**
- `openclaw` has robust boundary scripts (`check-extension-plugin-sdk-boundary.mjs`, multiple lint rules) that actively block disallowed imports.

**Improvement**
- Add boundary checks for:
  - no `renderer -> src/main` direct import leaks,
  - no extension/plugin reach-through to internal `src/main/**`,
  - no relative import escapes outside plugin package roots.
- Implement via `madge` + custom script (or dependency-cruiser).

**Expected impact**
- Architecture stays modular as plugin and provider ecosystems expand.

---

### 7) Adopt `tsgo` incrementally

**Current (`ai-orchestrator`)**
- Typecheck runs multiple `tsc --noEmit` passes.

**Peer pattern**
- `openclaw` and `opencode` use `@typescript/native-preview` (`tsgo`) lanes.

**Improvement**
- Add side-by-side `tsgo` command.
- Compare diagnostics with existing `tsc` lane for one release cycle, then decide on primary lane.

**Expected impact**
- Faster typechecking and cleaner scaling for large TS codebases.

---

### 8) Repository/documentation hygiene

**Current (`ai-orchestrator`)**
- Many completed plans/specs and change docs remain at repo root.

**Improvement**
- Move completed planning artifacts to `docs/plans/completed/`.
- Maintain a canonical `CHANGELOG.md` for release-visible deltas.
- Keep root focused on entrypoint docs and operational files.

**Expected impact**
- Easier navigation, clearer release history, and lower maintenance overhead.

## Suggested first sprint (1 week, low risk)

1. Add `oxlint` + `oxfmt`, run alongside existing lint.
2. Add `turbo.json` and migrate `typecheck` + `test` task orchestration.
3. Implement `register-aliases.ts` generation and hook into `prebuild`/`prestart`.
4. Remove legacy `BaseProvider` class export from SDK surface (keep type exports).
5. Add boundary/import-cycle check into `verify:architecture`.

## Notes on scope

- Keep existing strengths unchanged (contracts package, provider event envelopes, orchestration subsystems, drift-detection scripts).
- Larger shifts (daemon split, broad plugin-sdk barrel expansion, Effect-TS in supervisor/failover subsystems) should be tracked as separate specs before implementation.
