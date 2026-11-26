# AI Orchestrator — Copilot Review

I reviewed `ai-orchestrator` against the peer projects in this workspace, with the strongest comparisons coming from `t3code`, `openclaw`, `opencode`, and `agent-orchestrator`.

The big correction up front: **AI Orchestrator already has a real contracts package and SDK**. The interesting work is not “add contracts” or “add an SDK”; it is **finish the abstractions that are already present, remove duplicated seams, and copy the operational discipline the peer projects apply around them**.

## What AI Orchestrator already does well

- **Contracts are real and already central**: `ai-orchestrator/packages/contracts/package.json` exports a large schema/channel surface, and `ai-orchestrator/scripts/generate-preload-channels.js` already generates preload IPC from those contracts.
- **There is already a modern provider adapter interface**: `ai-orchestrator/packages/sdk/src/provider-adapter.ts` plus `ai-orchestrator/src/main/providers/provider-interface.ts`.
- **Verification is better than most peers**: `ai-orchestrator/package.json` has `verify`, `verify:ipc`, `verify:exports`, `check:contracts`, `verify:architecture`, and `smoke:electron`.
- **There is already meaningful runtime health work**: `ai-orchestrator/src/main/orchestration/supervisor.ts`, `ai-orchestrator/src/main/providers/failover-manager.ts`, and `ai-orchestrator/src/main/providers/provider-doctor.ts`.

## Best improvements to make

## 1. Replace slow lint/format tooling with `oxlint` + `oxfmt`

`ai-orchestrator/package.json` still uses `ng lint` and the Angular ESLint stack in a repo with a large TypeScript surface and a long `verify` chain. `t3code/package.json`, `t3code/turbo.json`, `opencode/package.json`, and `openclaw/CLAUDE.md` all show the same pattern: move the fast path to **Oxlint/Oxfmt**, then keep slower checks only where they are still needed.

**Recommendation**
- Add `oxlint` and `oxfmt`.
- Keep current Angular linting for one transition cycle.
- Make the default developer path fast; leave framework-specific linting as the backstop, not the day-to-day path.

## 2. Add Turborepo task orchestration before considering a package-manager migration

`ai-orchestrator/package.json` runs a long sequential `verify` script and separate `build`, `typecheck`, and `test` commands with no task graph or cache. `t3code/turbo.json` and `t3code/package.json` show a much cleaner model: task dependencies, cached build outputs, and shared env pinning. `opencode/package.json` also pushes typecheck through Turbo.

**Recommendation**
- Add `turbo.json` first.
- Cache `build`, `typecheck`, `test`, and the contracts/SDK package work.
- Keep npm initially; package-manager migration is optional and lower priority than getting a task graph in place.

## 3. Pilot `tsgo` / native TypeScript preview for typecheck-heavy lanes

`ai-orchestrator/package.json` runs multiple `tsc --noEmit` passes (`typecheck`, `typecheck:spec`, and the Electron tsconfig path). `openclaw/CLAUDE.md` explicitly standardizes on `tsgo` lanes, and `opencode/package.json` already carries `@typescript/native-preview`.

**Recommendation**
- Add an experimental `tsgo` lane for `packages/contracts`, `packages/sdk`, then the main app.
- Compare diagnostics against the current `tsc` passes before switching.
- Treat this as a speed experiment, not a full compiler migration.

## 4. Generate `register-aliases.ts` instead of hand-maintaining it

This is the clearest footgun in the repo. `ai-orchestrator/AGENTS.md` documents that path alias additions must stay in sync across `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and sometimes `vitest.config.ts`. `ai-orchestrator/scripts/check-contracts-aliases.ts` detects drift, but `ai-orchestrator/src/main/register-aliases.ts` is still a hand-maintained map.

AI Orchestrator already has the right pattern for generated boundary files in `ai-orchestrator/scripts/generate-preload-channels.js`.

**Recommendation**
- Generate `src/main/register-aliases.ts` from `tsconfig.electron.json` and `packages/contracts/package.json` exports.
- Generate the Vitest alias block from the same source.
- Keep `check-contracts-aliases.ts` as a guardrail, but stop using humans as the sync mechanism.

## 5. Remove the legacy `BaseProvider` from the public SDK surface

There are currently **two provider abstractions**:

- `ai-orchestrator/src/main/providers/provider-interface.ts` has the modern `events$`-based `BaseProvider` and normalized runtime envelopes.
- `ai-orchestrator/packages/sdk/src/provider-adapter.ts` exposes the modern adapter contract.
- But `ai-orchestrator/packages/sdk/src/providers.ts` still exports a **legacy** `BaseProvider` without the modern streaming/event model.

That means third-party integrations can still build against the wrong abstraction.

**Recommendation**
- Remove the runtime `BaseProvider` class from `packages/sdk/src/providers.ts`.
- Keep only the type-level exports there if needed for compatibility.
- Make `@sdk/provider-adapter` the only supported authoring surface for new providers.

## 6. Move provider config decoding into the registry and add provider metadata

`ai-orchestrator/packages/sdk/src/providers.ts` still uses `options?: Record<string, unknown>`, which pushes config decoding into individual providers. In `t3code/apps/server/src/provider/ProviderDriver.ts`, drivers get a **typed config already decoded by the registry**, and the driver metadata includes `supportsMultipleInstances`.

**Recommendation**
- Give each provider descriptor a schema and decode once at registration/load time.
- Add metadata such as `displayName` and `supportsMultipleInstances`.
- Reject invalid or duplicate instance setups at the registry boundary instead of inside providers.

## 7. Build a real plugin SDK barrel set and enforce boundaries

`ai-orchestrator/packages/sdk/src/plugins.ts` defines slots and hook payloads, but the public SDK surface is still broad and generic. In contrast:

- `openclaw/packages/plugin-sdk/package.json` exports many narrow, versioned barrels.
- `openclaw/CLAUDE.md` explicitly forbids plugin code from reaching into core internals.
- `agent-orchestrator/packages/core/package.json` exposes clean subpath exports such as `./plugin-registry`, `./session-manager`, and `./paths`.

AI Orchestrator has the beginnings of a plugin system, but not the same **hard boundary discipline**.

**Recommendation**
- Split the SDK into narrower barrels around actual seams: provider runtime, orchestration hooks, permissions, memory, telemetry, transport, etc.
- Treat those barrels as the only supported plugin imports.
- Add an architecture check that fails if plugin/extension code reaches into `src/main/**`.

## 8. Extend architecture verification from inventory to dependency rules

`ai-orchestrator/scripts/generate-architecture-inventory.js` is a useful inventory generator, but it mostly reports counts, files, and large-file hotspots. `openclaw/CLAUDE.md` goes further and treats import-cycle and architecture checks as hard gates.

**Recommendation**
- Keep the inventory generator.
- Add a boundary checker (`madge` or `dependency-cruiser`) to enforce:
  - no `renderer -> main` back-edges,
  - no plugin/extension code importing private core internals,
  - no unexpected package cycles.
- Make this part of `verify:architecture`, not a separate optional check.

## 9. Split the core runtime from Electron so desktop becomes just one transport

`ai-orchestrator/package.json` shows an Electron-first startup/build model, but the project already has contracts, WebSocket dependencies (`ws`), remote-node infrastructure, and a lot of main-process orchestration logic that does not fundamentally need a `BrowserWindow`. The peers show better separation:

- `t3code/package.json` and `t3code/turbo.json` split work across `apps/server`, `apps/web`, and `apps/desktop`.
- `agent-orchestrator/README.md` exposes a dashboard over HTTP and keeps runtime/session machinery in reusable core packages.

**Recommendation**
- Extract a headless server entrypoint first.
- Keep Electron as one client over the same contracts.
- Add a simple CLI/status view later; that would make AI Orchestrator more usable in CI, remote, and headless setups.

## 10. Use Effect selectively at the supervision/failover seams, not as a rewrite

AI Orchestrator already has two places that look like natural fits for Effect-style structured concurrency:

- `ai-orchestrator/src/main/orchestration/supervisor.ts`
- `ai-orchestrator/src/main/providers/failover-manager.ts`

At the same time, `t3code/package.json` and `opencode/package.json` show what an Effect-heavy stack looks like when it is native to the whole codebase. AI Orchestrator is not that codebase, and it should not try to become one all at once.

**Recommendation**
- Use Effect only where it clearly simplifies restart, scope, cancellation, or retry logic.
- Start with supervisor/failover experiments.
- Do **not** rewrite contracts or the general app surface just to “be more functional”.

## 11. Copy agent-orchestrator’s session/workspace naming safety rules

`agent-orchestrator/packages/core/src/paths.ts` is strong on two things AI Orchestrator could benefit from more broadly:

- deterministic path/session naming helpers,
- strict safety validation for project IDs and session IDs.

`agent-orchestrator/packages/plugins/runtime-process/src/index.ts` also validates session IDs and keeps output buffers bounded.

**Recommendation**
- Reuse that style of validation for any AI Orchestrator runtime/session/workspace identifiers.
- Audit long-running buffers and subprocess metadata for bounded growth.
- This is a small improvement, but it reduces a whole class of shell/path edge cases.

## 12. Keep what is already better than the peers

A few suggestions from other reviews should **not** be treated as priorities because AI Orchestrator already has them:

- Do **not** spend time “adding a contracts package” — it already exists in `ai-orchestrator/packages/contracts/package.json`.
- Do **not** spend time “adding provider diagnostics” as if missing — `ai-orchestrator/src/main/providers/provider-doctor.ts` already exists.
- Do **not** replace existing verification culture with lighter-weight peer setups — on this point, AI Orchestrator is already ahead.

## Recommended first sprint

If I had to narrow this to the highest-value first pass:

1. Add `oxlint` + `oxfmt`.
2. Add `turbo.json` and move build/typecheck/test orchestration into it.
3. Generate `register-aliases.ts` and test aliases from a single source of truth.
4. Remove the legacy SDK `BaseProvider`.
5. Add import-cycle/boundary enforcement to `verify:architecture`.

That set is low-risk, directly evidence-backed by the code, and improves both day-to-day developer speed and long-term architecture discipline.
