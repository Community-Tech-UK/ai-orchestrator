# AI Orchestrator Cross-Repo Improvement Plan

> **Status (2026-04-16): COMPLETE — merged into `main`.**
>
> All six workstreams were delivered in a single squash commit:
> `e6ff331 feat: complete WS1-WS6 improvement plan remediation` (author: James Lawrence, 2026-04-15).
> The commit is an ancestor of `main` (`main` = `a4eabfe Remote worker` at time of writing, one commit ahead of `e6ff331`).
>
> **Verification re-run on `main` 2026-04-16:**
> - `npx tsc --noEmit` → 0 errors
> - `npx tsc --noEmit -p tsconfig.spec.json` → 0 errors
> - `npm run verify:ipc` → 700/700/700 channels aligned across contracts, generated file, and legacy shim
>
> **Delivered, per exit criteria:**
> - **WS1** — `src/shared/validation/ipc-schemas.ts` reduced to a 14-line re-export of `@contracts/schemas`. Zero production imports of the shim. Guard test in `src/shared/validation/__tests__/no-legacy-imports.spec.ts`.
> - **WS2** — Seven modules extracted. New lifecycle modules: `src/main/instance/lifecycle/{deferred-permission-handler,plan-mode-manager,restart-policy-helpers}.ts`. Session extractions landed alongside.
> - **WS3** — Normalized provider runtime event contract at `packages/contracts/src/types/provider-runtime-events.ts`, wired into production via `emitNormalized` in `setupAdapterEvents`. Legacy `ProviderEvent` types marked `@deprecated`.
> - **WS4** — `plugin-manager.ts` now uses `PluginManifestSchema`; `skill-loader.ts` uses `SkillFrontmatterSchema`. Tests in `packages/contracts/src/schemas/__tests__/plugin-schemas.spec.ts` (402 lines).
> - **WS5** — Scenario harness at `src/main/providers/__tests__/scenario-harness.spec.ts` (13 tests / 8 scenarios) plus 74 normalizer tests.
> - **WS6** — Bootstrap module registry under `src/main/bootstrap/` with four domain modules (`infrastructure`, `learning`, `memory`, `orchestration`). Angular service extractions in the renderer per commit stat (6 services).
>
> **Residual observations (not part of the committed plan, captured here for future follow-up):**
> - `src/main/instance/instance-lifecycle.ts` is still ~3,538 lines and `src/main/session/session-continuity.ts` is ~1,485 lines. The seven modules that were extracted meet the letter of WS2 but several fat orchestration methods remain on the hot path (e.g., `createInstance` ≈ 566 lines, `changeModel` ≈ 264 lines, `respawnAfterUnexpectedExit` ≈ 197 lines). Deeper decomposition would be valuable but should be its own risk-scoped plan, not an extension of this one.
> - Commit note records 14 pre-existing test failures in codemem/memory SQLite env, unrelated to this series.
> - The remediation worktree at `../ai-orchestrator-remediation` on branch `remediation/contracts-migration` is now 0 commits ahead / 1 behind `main` and can be pruned with `git worktree remove` at your convenience.
>
> The text below is the original plan as written, preserved for reference.
>
> ---

> **For implementers:** Execute this plan in a fresh worktree. The primary `ai-orchestrator` working tree already has unrelated local edits and should not be used for the remediation series.

**Source of improvements:**
- Contract-first provider/orchestration boundaries from `../t3code`
- Deterministic parity and recovery harnesses from `../claw-code-parity`
- Extension SDK and contract-test patterns from `../openclaw`
- Thin-core self-registration patterns from `../nanoclaw`

**Goal:** Reduce architectural drag in AI Orchestrator by finishing the contracts migration, shrinking oversized coordination modules, normalizing provider runtime events, hardening extension boundaries, and adding deterministic recovery coverage.

**Architecture:** The work is organized into 6 workstreams plus a baseline phase. Each workstream should land as an isolated, reviewable PR with its own verification checkpoint. Workstreams are ordered by leverage and dependency, not by subsystem ownership.

**Tech Stack:** TypeScript 5.9, Angular 21, Electron 40, Zod 4, Vitest, better-sqlite3

**Constraints:**
- Do **not** rewrite the app around a new framework or runtime model
- Do **not** mix UI redesign into infrastructure-focused PRs
- Keep behavior changes narrow and measurable
- Prefer extraction and contract hardening over feature invention

**Verification after every workstream:**
```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```

**Additional verification when touching contracts or preload:**
```bash
npm run generate:ipc
npm run verify:ipc
```

---

## WS0: Baseline, Isolation, and Success Metrics

### Objective

Create a safe execution environment so improvement PRs do not mix with existing local edits or regress behavior silently.

### Files / Surfaces

- `README.md`
- `docs/architecture.md`
- `package.json`
- `scripts/verify-ipc-channels.js`
- `scripts/generate-preload-channels.js`

### Tasks

1. Create a fresh worktree dedicated to the remediation series.
2. Record a baseline run of the verification commands and save the output in the PR description or a work log.
3. Record the current high-risk files and module sizes so extractions can be measured against a baseline.
4. Confirm the intended merge order for workstreams before code changes begin.

### Exit Criteria

- A clean worktree exists for the project
- Baseline verification output is captured
- Each workstream has a named owner and merge order

---

## WS1: Finish the Contracts and IPC Migration

### Objective

Make `packages/contracts` the actual source of truth for channels, schemas, and transport types, instead of keeping the deprecated shim alive indefinitely.

### Primary Files

- `packages/contracts/src/index.ts`
- `packages/contracts/src/channels/`
- `packages/contracts/src/schemas/workspace.schemas.ts`
- `src/shared/validation/ipc-schemas.ts`
- `src/shared/types/ipc.types.ts`
- `src/main/ipc/handlers/`
- `src/main/ipc/ipc-main-handler.ts`
- `src/preload/generated/channels.ts`

### Tasks

1. Split `packages/contracts/src/schemas/workspace.schemas.ts` into domain-focused schema files such as:
   - `instance.schemas.ts`
   - `session.schemas.ts`
   - `provider.schemas.ts`
   - `workspace.schemas.ts`
   - `orchestration.schemas.ts`
2. Migrate all remaining imports from `src/shared/validation/ipc-schemas.ts` to `@contracts/schemas`.
3. Reduce `src/shared/validation/ipc-schemas.ts` to a minimal compatibility shim or remove it entirely once imports are zero.
4. Keep `src/shared/types/ipc.types.ts` aligned with the contracts package or retire it if no longer needed.
5. Add a guard test or lint-style check that fails when new code imports the deprecated shim.
6. Regenerate and verify preload channels after each logical chunk.

### Why This Comes First

This is the lowest-risk, highest-leverage cleanup. It improves type boundaries immediately and reduces friction for every later workstream.

### Exit Criteria

- Zero production imports of `src/shared/validation/ipc-schemas.ts`
- `packages/contracts` is the only schema/channel source of truth
- `npm run generate:ipc` and `npm run verify:ipc` both pass

---

## WS2: Extract Lifecycle and Session Submodules

### Objective

Continue the in-progress decomposition of instance/session hot paths so orchestration behavior is easier to reason about and test.

### Primary Files

- `src/main/instance/instance-manager.ts`
- `src/main/instance/instance-lifecycle.ts`
- `src/main/instance/lifecycle/instance-spawner.ts`
- `src/main/instance/lifecycle/session-recovery.ts`
- `src/main/session/session-continuity.ts`
- `src/main/session/`

### Tasks

1. Extract additional lifecycle responsibilities from `instance-lifecycle.ts` into focused modules:
   - plan mode state transitions
   - deferred permission resume logic
   - child completion/synthesis cleanup
   - restart / respawn policy helpers
2. Extract session responsibilities from `session-continuity.ts` into focused modules:
   - snapshot persistence
   - archive/import/export flows
   - replay/native resume coordination
   - termination gate orchestration
3. Keep `InstanceManager` as a thin coordinator and avoid reintroducing a second singleton path.
4. Add or expand tests around the extracted units before deleting the legacy inline code.

### Implementation Rules

- Extract by responsibility, not by arbitrary line count
- Preserve public APIs until tests and callers are migrated
- Avoid moving behavior and refactoring logic in the same patch unless the tests stay green

### Exit Criteria

- `instance-lifecycle.ts` and `session-continuity.ts` are materially smaller
- Extracted modules have direct tests
- `InstanceManager` remains primarily a delegator

---

## WS3: Normalize Provider Runtime Events

### Objective

Introduce a typed provider-runtime event envelope so orchestration, telemetry, and UI logic consume one provider-agnostic stream.

### Primary Files

- `src/shared/types/provider.types.ts`
- `packages/contracts/src/types/`
- `packages/sdk/src/providers.ts`
- `src/main/providers/`
- `src/main/orchestration/`
- `src/main/ipc/handlers/provider-handlers.ts`

### Tasks

1. Define a normalized provider-runtime event contract in `packages/contracts`.
2. Update `packages/sdk/src/providers.ts` to align public provider events with that runtime contract.
3. Add per-provider mapper/adaptor logic for Claude, Codex, Gemini, and Copilot so their raw events are normalized once.
4. Refactor orchestration and telemetry code to consume the normalized event stream instead of provider-specific event shapes.
5. Add contract tests covering event ordering, tool use, errors, exit semantics, and resume behavior.

### Inspiration to Copy

- `t3code/apps/server/src/provider/Layers/ProviderRegistry.ts`
- `t3code/apps/server/src/provider/Layers/ProviderService.ts`
- `t3code/packages/contracts/src/orchestration.ts`

### Exit Criteria

- Provider consumers no longer special-case each provider’s event shape
- Adding a new provider requires only adapter mapping plus registration
- Runtime event schemas are shared across main process, renderer, and SDK surfaces

---

## WS4: Harden Plugins and Skills with Typed Contracts

### Objective

Move plugin and skill loading away from permissive ad hoc parsing toward schema-validated manifests and strongly typed hook payloads.

### Primary Files

- `src/main/plugins/plugin-manager.ts`
- `src/main/skills/skill-loader.ts`
- `src/main/skills/skill-registry.ts`
- `packages/sdk/src/plugins.ts`
- `packages/contracts/src/schemas/`

### Tasks

1. Define schemas for plugin manifests and skill frontmatter in `packages/contracts`.
2. Replace the hand-rolled `parseMetadata()` flow in `skill-loader.ts` with schema-based parsing and better validation errors.
3. Narrow plugin hook payload translators in `plugin-manager.ts` so malformed payloads fail fast and predictably.
4. Align `packages/sdk/src/plugins.ts` with the actual runtime payload contracts.
5. Add contract tests for plugin manifests, hook payload compatibility, and extension loading failures.

### Inspiration to Copy

- `openclaw/package.json` export structure
- `openclaw/packages/plugin-sdk/package.json`
- `openclaw/src/plugins/contracts/`
- `nanoclaw/src/channels/registry.ts`

### Exit Criteria

- Skills and plugins fail validation with actionable errors
- SDK types match runtime payloads
- Extension loading behavior is covered by tests, not just happy-path manual checks

---

## WS5: Add Deterministic Parity and Recovery Harnesses

### Objective

Cover the highest-risk runtime flows with repeatable scenario tests so future refactors do not silently break approvals, resume, or tool flows.

### Primary Files / New Surfaces

- `src/main/providers/`
- `src/main/session/`
- `src/main/instance/`
- `tests/` or a dedicated harness directory under `src/tests/`

### Required Scenario Coverage

1. Streaming text roundtrip
2. Permission request approved
3. Permission request denied
4. Native resume success
5. Native resume failure followed by replay fallback
6. Interrupt and respawn behavior
7. MCP tool lifecycle / tool result roundtrip
8. Plugin hook roundtrip and payload validation

### Tasks

1. Build deterministic fixtures/mocks around provider output instead of relying on live CLIs for every scenario.
2. Add scenario runners that assert event ordering, state transitions, and persisted session artifacts.
3. Introduce fault injection where useful: failed resume, partial output, unexpected exit, malformed payload.
4. Ensure persistence-sensitive code uses atomic writes where needed.

### Inspiration to Copy

- `claw-code-parity/rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`
- `claw-code-parity/rust/crates/runtime/src/session.rs`

### Exit Criteria

- Recovery regressions are caught by deterministic tests
- Provider/session changes can be validated without manual CLI smoke testing
- Scenario tests document expected behavior for future contributors

---

## WS6: Modularize Bootstrap and Decompose UI Hotspots

### Objective

Reduce startup coupling in the main process and shrink oversized Angular container components without mixing in broad UI redesign.

### Primary Files

- `src/main/index.ts`
- `src/main/orchestration/default-invokers.ts`
- `src/renderer/app/features/instance-list/instance-list.component.ts`
- `src/renderer/app/features/instance-detail/instance-detail.component.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.ts`
- `src/renderer/app/core/state/instance/`

### Tasks

1. Introduce feature bootstrap modules for major domains so init/shutdown logic is not manually wired in one giant file.
2. Move each bootstrap module to an explicit contract: init, teardown, dependencies, failure mode.
3. Split the largest Angular feature containers into smaller components/presenters plus store selectors.
4. Keep behavior stable: this workstream is decomposition, not UX redesign.

### Implementation Rules

- Check template bindings and change detection behavior before moving state logic
- Prefer extracting presentational pieces from existing containers over rewriting stores
- Avoid coupling UI decomposition to provider/runtime changes in the same PR

### Exit Criteria

- `src/main/index.ts` is materially smaller and easier to audit
- Large Angular files are split without behavior regressions
- Startup/shutdown responsibilities are explicit and testable

---

## Recommended PR Order

1. WS1 — Contracts and IPC migration
2. WS2 — Lifecycle and session extraction
3. WS3 — Provider runtime normalization
4. WS4 — Plugin and skill contracts
5. WS5 — Parity and recovery harnesses
6. WS6 — Bootstrap and UI decomposition

---

## Non-Goals

- Rewriting the application around Effect, Rust, or a different desktop stack
- Redesigning the renderer while infrastructure boundaries are still unstable
- Building a new plugin ecosystem before the runtime contracts are dependable
- Shipping unrelated feature work during remediation PRs

---

## Definition of Done

- `packages/contracts` is the single source of truth for IPC contracts
- Core lifecycle/session modules are smaller and test-backed
- Providers emit normalized runtime events
- Plugin/skill contracts are schema-validated and SDK-aligned
- Deterministic recovery/parity scenarios exist for the highest-risk flows
- Main-process bootstrap and the largest Angular containers are materially easier to audit and maintain

---

## Final Verification Before Closing the Series

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run generate:ipc
npm run verify:ipc
npm run test
```
