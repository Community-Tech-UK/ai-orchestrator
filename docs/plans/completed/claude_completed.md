# AI Orchestrator — Cross-Project Improvement Recommendations (Claude)

Independent review by Claude after a deep dive into `ai-orchestrator/` and the
peer projects in this workspace: `opencode`, `t3code`, `openclaw`, `nanoclaw`,
`claw-code`, `hermes-agent`, `codex`, `agent-orchestrator`.

The previous `gemini.md` review at the root of this workspace was based on a
mistaken premise — it claimed `ai-orchestrator` lacks a contracts package and
SDK. Both already exist (`ai-orchestrator/packages/contracts/` with 50+ Zod
schema/channel files, and `ai-orchestrator/packages/sdk/` with `tools`,
`plugins`, `providers`, `provider-adapter` exports). The real opportunities
are different. Most are about **finishing** abstractions that are already
half-built, replacing slow tools, and learning from peers' more disciplined
plugin/provider boundaries.

References below use the form `<project>:<path>` so the source is always
verifiable.

---

## TL;DR — What to do first

| # | Change | Effort | Risk | Payoff |
|---|--------|--------|------|--------|
| 1 | Replace ESLint+Prettier with **oxlint + oxfmt** | S | Low | 10–100× faster; matches `opencode`/`t3code`/`openclaw` |
| 2 | Add **Turborepo** task pipeline (keep npm) | S | Low | Cache `typecheck`/`build`/`test`; the 9-step `verify` script is a prime candidate |
| 3 | Adopt **`tsgo`** (TS native preview) for typecheck | S | Low | Matches `tsgo*` lanes in `openclaw`; the dual-tsconfig double-pass is slow on ~1500 files |
| 4 | **Delete legacy `BaseProvider` from `@sdk/providers`**, leave only `provider-adapter` | S | Low | Two competing abstractions today (see §3.1) |
| 5 | Auto-generate `register-aliases.ts` from `tsconfig.json` | S | Low | Eliminates the documented "miss #3 and the DMG crashes on startup" trap |
| 6 | Carve a real **plugin-sdk barrel set** (model on `openclaw/packages/plugin-sdk`) | M | Med | Gates plugins from `src/main/*` reach-through |
| 7 | Introduce **Effect-TS at narrow seams** (supervisor, failover, scope-bound process lifetime) | M | Med | OTP code is a near-1:1 fit for `Schedule`/`Scope`/`Fiber` |
| 8 | Split the daemon: **`apps/server` + `apps/electron` + (future) `apps/web`** | L | Med-High | Mirrors `t3code`; halves the "everything is Electron-coupled" tax |
| 9 | Generate **OpenAPI / WS schema** from contracts | M | Low | Enables a CLI/TUI/web client, mirroring `opencode/packages/sdk/openapi.json` |
| 10 | Document and enforce **import boundaries** (no `renderer → main`, no `extensions/* → src/main/*`) | M | Low | `openclaw`'s tightest invariant |

---

## 1. Build, lint, and typecheck — the cheapest wins

### 1.1 Replace ESLint + Prettier with oxlint + oxfmt
**Where today:** `ai-orchestrator/eslint.config.js` (typescript-eslint + angular-eslint),
no Prettier config in `package.json` (Prettier is implicit via Angular CLI).

**What peers do:**
- `opencode/package.json` — `"lint": "oxlint"` (1.60.0); Prettier kept only for `.md`/`.json`
- `t3code/package.json` — `"lint": "oxlint"`, `"fmt": "oxfmt"` (no Prettier)
- `openclaw/CLAUDE.md` — *"Formatting: `oxfmt`, not Prettier. Use repo wrappers."*

**Why it matters:** ai-orchestrator has ~1500 TypeScript files across `src/main/`
(975), `src/renderer/` (410), `src/shared/` (125), plus `packages/`. ESLint's
typed-linting (`tseslint.configs.stylistic`) is the slowest stage of `npm run
verify`. Oxlint understands ~85% of the typescript-eslint rule set today and
is in production at all three peers.

**Plan:**
1. Add `oxlint` + `oxfmt` as devDependencies; keep `eslint.config.js` running
   in CI for one release cycle as a backstop.
2. Port the two custom rules in `eslint.config.js` (`@angular-eslint/directive-selector`,
   `@angular-eslint/component-selector`) — `t3code` ships a custom plugin
   (`t3code/oxlint-plugin-t3code/`) showing the pattern.
3. Drop ESLint when the diff between the two reports is empty.

### 1.2 Add Turborepo
**Where today:** `ai-orchestrator/package.json` — `"verify": "npm run lint && npm run typecheck && ... && npm run test && ..."`.
Nine sequential steps. No caching.

**What peers do:** `opencode/turbo.json` defines `typecheck`, `build`, `test`, `test:ci`
with `dependsOn: ["^build"]`; `t3code/package.json` has `"typecheck": "turbo run typecheck"`,
`"test": "turbo run test"`.

**Plan:**
- Add `turbo.json` covering `build:main`, `build:renderer`, `build:worker-agent`,
  `typecheck`, `test`, `verify:*`.
- Wire it for `packages/contracts` and `packages/sdk` first (these compile fast,
  cache best, and define the boundary types everything else depends on).

### 1.3 Migrate typecheck to `tsgo`
**Where today:** `npm run typecheck` runs `tsc --noEmit` twice (root + `tsconfig.electron.json`),
plus `typecheck:spec` runs a third pass for spec files.

**What peers do:** `openclaw/CLAUDE.md` is explicit: *"Typecheck: `tsgo` lanes
only (`pnpm tsgo*`, `pnpm check:test-types`); never add `tsc --noEmit`."*
`opencode` has `@typescript/native-preview` in its catalog.

**Plan:** Add `@typescript/native-preview` and run `tsgo --noEmit -p tsconfig.json`
in parallel with `tsc` for one release. Switch when the diagnostics agree.

### 1.4 Workspace catalog (centralized version pinning)
`ai-orchestrator/package.json` uses `"overrides"` for a few packages. `opencode`
and `t3code` use `workspaces.catalog` — a single block where every workspace
package can `"effect": "catalog:"` and pin via the root. With ~70 deps that
need to stay in sync between `packages/contracts`, `packages/sdk`, and the root
app, the catalog pattern is worth the migration cost.

### 1.5 Supply-chain hardening (if/when migrating to pnpm)
`nanoclaw/CLAUDE.md` documents `minimumReleaseAge: 4320` (3 days) plus strict
rules around `minimumReleaseAgeExclude` and `onlyBuiltDependencies`. For an
app that ships a signed DMG and runs arbitrary CLI subprocesses, this is
cheap insurance against compromised npm releases.

---

## 2. Eliminate the alias triple-sync footgun

The single most concerning footgun in the codebase, documented in
`ai-orchestrator/AGENTS.md` lines 102–117:

> "Files under `packages/contracts/src/schemas/` are named
> `<name>.schemas.ts`, but imports use the short form `@contracts/schemas/<name>`.
> That discrepancy is bridged by **three** places that must stay in sync …
> Miss #3 and the packaged app crashes on startup with `Cannot find module …`
> even though typecheck and lint pass."

`scripts/check-contracts-aliases.ts` papers over this by failing the build
when they drift, but it doesn't *prevent* drift. Better: make
`src/main/register-aliases.ts` **generated** from `tsconfig.json`'s `paths`,
the same way `src/preload/generated/channels.ts` is already generated by
`scripts/generate-preload-channels.js`.

**Plan:**
- Add `scripts/generate-register-aliases.js` reading `tsconfig.electron.json`
  and `packages/contracts/package.json` exports.
- Run it in `prebuild`/`prestart` alongside `generate:ipc`.
- `check-contracts-aliases.ts` becomes a sanity check on the generator's
  output rather than the system of record.

While there: `vitest.config.ts` aliases should also be generated from the
same source. That's the fourth sync point and the one most often missed.

---

## 3. Provider abstraction — finish what's started

`ai-orchestrator` has the most sophisticated provider abstraction of any
project in the workspace; the issue is that **two versions of it exist
side-by-side** and the wrong one is the public face.

### 3.1 The two `BaseProvider`s
- **Production:** `src/main/providers/provider-interface.ts` —
  `BaseProvider` with `events$: Observable<ProviderRuntimeEventEnvelope>`
  (RxJS Subject), `pushOutput`/`pushToolUse`/`pushStatus`/etc helpers,
  `bindAdapterRuntimeEvents` for adapter integration, sequence numbers,
  and dev-time envelope schema validation.
- **Legacy SDK:** `packages/sdk/src/providers.ts` — `BaseProvider` *without*
  `events$`, exposing the deprecated `ProviderEvents` EventEmitter shape that
  per the comments was retired in **Wave 2**. It still exports
  `ProviderType`, `ProviderConfig`, `ProviderCapabilities`, `BaseProvider`,
  `ProviderFactory`.

If a third-party plugin author reads `@ai-orchestrator/sdk/providers`, they
build to the wrong abstraction.

**Plan:**
1. Delete the `BaseProvider` class from `packages/sdk/src/providers.ts`.
2. Keep the **type-only** exports (`ProviderType`, `ProviderConfig`,
   `ProviderCapabilities`, `ModelInfo`, `ProviderUsage`, `ProviderAttachment`,
   `ProviderSessionOptions`).
3. Make `@ai-orchestrator/sdk/provider-adapter` (the modern interface) the
   only authoring surface for new providers.
4. Add a JSDoc deprecation banner on the SDK barrel file.

### 3.2 Decode config at the registry, not in the driver
In `t3code/apps/server/src/provider/ProviderDriver.ts:37–60`, drivers receive
`config: Config` *typed* — already decoded by the registry via a
`configSchema`. Drivers never deal with raw `unknown`. ai-orchestrator's
`ProviderConfig` (`packages/sdk/src/providers.ts:54-63`) has
`options?: Record<string, unknown>` and individual providers cast it
internally. Move that decoding to the registry and have each provider
declare its `configSchema: z.ZodType` next to the factory.

### 3.3 Adopt `supportsMultipleInstances` metadata
`t3code/apps/server/src/provider/ProviderDriver.ts:42-53`:

```ts
export interface ProviderDriverMetadata {
  readonly displayName: string;
  /** Whether the driver may be instantiated more than once concurrently. */
  readonly supportsMultipleInstances?: boolean;
}
```

`ai-orchestrator/src/main/providers/anthropic-api-provider.ts` is implicitly
single-instance (one HTTP client). The runtime should reject duplicate
instantiation with a clear error rather than relying on convention. Add this
field to `ProviderAdapterCapabilities` or a sibling `ProviderAdapterMetadata`
in `@contracts/types/provider-runtime-events`.

### 3.4 Let UI gate behavior on adapter capabilities
`ProviderAdapterCapabilities` already distinguishes adapter-level capability
(`interruption`, `permissionPrompts`, `sessionResume`, `streamingOutput`,
`usageReporting`, `subAgents`) from model-level `ProviderCapabilities`
(`toolExecution`, `streaming`, `vision`, …). The renderer should hide/disable
controls based on these flags rather than provider-name string-matching.
Audit `src/renderer/app/features/**` for `provider === 'claude-cli'` checks
and replace with capability lookups.

---

## 4. Plugin / extension surface

`ai-orchestrator/packages/sdk/src/` exports five files:
`tools.ts`, `plugins.ts`, `providers.ts`, `provider-adapter.ts`,
`provider-adapter-registry.ts`. Compare with
`openclaw/packages/plugin-sdk/package.json` which exports **150+** narrow
runtime barrels (`acp-runtime`, `channel-runtime`, `cron-store-runtime`,
`provider-stream-shared`, `tts-runtime`, `secret-input`, `runtime-doctor`, …).

The reason matters: each barrel is a versioned, documented seam. Plugins are
forbidden from reaching past it (`openclaw/CLAUDE.md`: *"Plugin prod code: no
core `src/**`, `src/plugin-sdk-internal/**`, other plugin `src/**`, or
relative outside package."*). `ai-orchestrator` has no such enforced
boundary today — the existing `src/main/plugins/` directory and the SDK's
`PluginSlot` type imply one was planned, but nothing prevents
`plugin-foo/index.ts` from `import { Supervisor } from '../../../src/main/orchestration/supervisor'`.

**Plan (incremental, can be staged):**
1. **List the seams that exist already.** Each of these is a candidate barrel
   under `packages/sdk/src/`:
   `mcp-runtime`, `skill-runtime`, `workflow-runtime`, `orchestration-hooks`,
   `verification-runtime`, `memory-host`, `instance-events`, `permission-registry`,
   `secret-storage`, `redaction`, `prompt-history`, `usage-tracker`, `cron`,
   `webhook-server`, `browser-gateway`, `remote-node-bridge`, `voice`,
   `chat-channels`, `lsp-bridge`, `codemem`, `learning-events`, `observability-spans`,
   `display-items`, `automation-runtime`, `loop-runtime`.
2. **Move first-party "providers" out of `src/main/providers/` into `extensions/<provider>/`**
   (claude-cli, codex-cli, gemini-cli, copilot-cli, cursor-cli, anthropic-api).
   Each one re-imports from the SDK only. This is the move openclaw made,
   referenced as *"src/plugin-sdk/* …; channels: src/channels/*"*. Doing it
   for new providers first is fine — the older ones can stay where they are
   until you need to break them out for a community plugin pass.
3. **Add a `pnpm check:import-cycles`-equivalent** (use `madge` or
   `dependency-cruiser`) that fails the build on a `src/main → renderer` or
   `extensions → src/main` import.

### 4.1 Plugin manifest validation
`packages/sdk/src/plugins.ts:225-235` defines `PluginManifest` as a TS
interface. Make the JSON Schema authoritative (Zod, mirrored to JSON Schema)
so plugin manifests can be validated at load time and surface user-friendly
errors. opencode does this in `packages/plugin/src/index.ts` with full
`PluginInput`/`PluginModule` Zod-style schemas.

---

## 5. Effect-TS at narrow seams (not a wholesale rewrite)

`opencode` and `t3code` are Effect-native. `ai-orchestrator` is RxJS-based
and converting the whole codebase isn't worth the disruption. But four
specific subsystems are nearly perfect fits:

### 5.1 `src/main/orchestration/supervisor.ts` — OTP supervisor tree
Already explicitly Erlang/OTP-inspired (lines 1–4). Effect's
`Schedule`/`Scope`/`Fiber`/`Supervisor` primitives map nearly 1:1: child
specs → `Effect.scoped`, restart strategy → `Schedule.recurs` +
`Schedule.exponential`, circuit breaker → `Schedule.modifyDelay`. A clean
port would replace ~600 lines of bespoke retry/backoff math with declarative
schedules.

### 5.2 `src/main/providers/failover-manager.ts` — retry/race/fallback
This is a textbook `Effect.race` + `Effect.tapErrorCause` + `Effect.retry`
case. The current implementation extends `EventEmitter` and runs against
`CircuitBreakerRegistry`. It would shrink dramatically and become testable
without timer mocks.

### 5.3 `src/main/process/*` — scope-bound process lifetime
`HibernationManager`, `PoolManager`, `LoadBalancer` all manage long-lived
resources whose lifetimes need to bracket cleanup. `Effect.acquireRelease`
+ `Scope` is built for this. The recurring "did we forget a cleanup?" bug
class disappears when scopes are explicit.

### 5.4 Multi-agent debate / consensus
`debate-coordinator.ts`, `consensus-coordinator.ts`, `multi-verify-coordinator.ts`
spawn N parallel agents and combine results. `Effect.all({ concurrency: N })`
+ `Effect.timeoutOption` + `Effect.either` would replace bespoke
Promise.allSettled-with-timeout patterns and make round-cancellation safe.

**Don't do:** migrate the contracts package from Zod to `effect/Schema`. The
50+ Zod schema files are a sunk cost; Zod 4 is fine; t3code's reasons for
Effect Schema (it's an Effect-native codebase) don't apply here.

---

## 6. Daemon split — decouple Electron

`ai-orchestrator` is Electron-only. Today the renderer talks to `src/main/`
via 775 generated IPC channels. The same `src/main/` already runs:
- `remote-node/` — multi-machine pairing
- `browser-gateway/` — out-of-process browser automation
- `worker-agent/` — separate compiled binary (`build-worker-agent-sea.ts`)
- `bonjour-service` discovery
- a full WebSocket layer (`ws` dependency)

That is ~80% of what's needed to run headless. `t3code` does this cleanly:
`apps/server/` is the core, `apps/desktop/` (Electron) and `apps/web/`
(React + Vite) are presentations that talk to it.

### 6.1 Stages

**Stage A** *(no API changes):* Add a `apps/server` thin entry that boots
the same `src/main/` services without `BrowserWindow`. Keep all 775 IPC
channels backed by Electron `ipcMain` for now. Expose a parallel
**WebSocket** transport for the same channel set (validated by the same Zod
schemas). `electron-ipc` and `ws-ipc` become two adapters over one router.

**Stage B:** Build a minimal **`apps/cli`** monitor: `ai-orchestrator status`,
`ai-orchestrator watch <instance-id>`, `ai-orchestrator orchestration list`.
opencode uses `@opentui/*` and `ink` (`opencode/packages/console/`); even
plain `chalk + readline` would be useful given the size of the orchestration
output today.

**Stage C:** Expose `apps/web` (Angular standalone or any framework — the
existing `src/renderer/` is Angular 21 zoneless and could be reused
verbatim against the WS transport).

This is a long road, not a release. But the first piece (factoring out
`apps/server` so it can boot without Electron) is small and immediately
unblocks: TUI, headless CI verification, integration tests that don't need
to spin up Chromium, and the future remote/web client.

### 6.2 Generate the client SDK

Once contracts are addressable from outside the Electron process, generate a
client SDK from them. `opencode/packages/sdk/openapi.json` (auto-generated
from contracts) is the model: third-party tooling, the CLI, the future
web/mobile app, all consume one typed client. ai-orchestrator's contracts
are already structured for this — every channel has request/response Zod
schemas in `packages/contracts/src/channels/*`.

Tools: `zod-to-openapi` or `zod-to-json-schema` + `openapi-typescript`.

---

## 7. Test/verify infrastructure improvements

ai-orchestrator already has a solid set of verifications (`verify:ipc`,
`verify:exports`, `check:contracts`, `verify:architecture`, `smoke:electron`).
Things peers do that are worth borrowing:

### 7.1 Architecture inventory drift
`scripts/generate-architecture-inventory.js` is excellent. Two extensions
both peers use:
- **Import-cycle gate** (`openclaw/CLAUDE.md`: *"keep `pnpm check:import-cycles`
  + architecture/madge green"*).
- **Mermaid/Graphviz output** so `docs/architecture.md`'s ASCII tree is
  generated, not hand-written. The current diagram listing 33 directories
  under `src/main/` will keep drifting.

### 7.2 Headless smoke
`scripts/electron-smoke-check.js` boots the app. Add an Angular renderer
smoke (chrome-devtools MCP or Playwright headless) that loads the main
window, asserts no console errors, and dumps a screenshot. `t3code` does
this in `release-smoke.ts`.

### 7.3 Vitest cache contention
`openclaw/CLAUDE.md`: *"Do not run independent `pnpm test`/Vitest commands
concurrently in one worktree; Vitest cache races with `ENOTEMPTY`. Group one
command or use distinct `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH`."*

If `ai-orchestrator` ever runs Vitest in parallel via Turborepo or in CI,
this comes up. Document it now — it's a 30-minute fix when you hit it for
the first time, but it costs ~2 hours of head-scratching.

---

## 8. Documentation hygiene

### 8.1 Canonical `CHANGELOG.md`
`bigchange_*_completed.md`, `plan_*_completed.md`, and `unified_plan_completed.md`
are scattered at the repo root. Both opencode and openclaw maintain
`CHANGELOG.md` with `### Changes` / `### Fixes` sections per release.
Consolidate into one and move the planning docs to `docs/plans/` (which
already exists but is half-used).

### 8.2 Move `bigchange_*` plans out of root
`AGENTS.md` already says *"NEVER commit unfinished plans/specs"* and *"Only
commit a planning document after it has been fully implemented and
verified; rename it with `_completed`."* Good rule. The root is still
cluttered. Move all `*_completed.md` files into `docs/plans/completed/`
and link the relevant ones from `docs/architecture.md`.

### 8.3 Architecture diagram from inventory
`scripts/generate-architecture-inventory.js` emits structured data. Add a
Mermaid renderer step so `docs/architecture.md`'s "Main Process Domains"
section is generated, never hand-edited.

---

## 9. Security & secrets

ai-orchestrator already has `redaction-service.ts`, `secret-classifier.ts`,
`secret-storage.ts` (using Electron `safeStorage`), and per-MCP-server
quarantine. That's good.

Two patterns from peers worth borrowing:

### 9.1 OneCLI-style credential vault for headless mode
`nanoclaw/CLAUDE.md` describes OneCLI: secrets injected per-request via a
local proxy, never copied into env vars or chat context. When ai-orchestrator
gains a daemon mode (§6), the existing `safeStorage`-backed
`SecretStorage` can become one of multiple vault adapters; OneCLI or
`age`-encrypted file vaults are alternatives for non-Electron deployments.

### 9.2 Approval-gated tool execution
`src/main/orchestration/permission-registry.ts` exists. nanoclaw's
two-sided approval flow (server-side hold + host-side router-delivered
approval requests, persisted in the central DB) is a useful prior art for
making `permission:ask` durable and routable. Today the approval is
in-process; cross-window/cross-machine approval would need durability.

---

## 10. Concrete first sprint

If James wants a concrete, contained chunk of work that delivers measurable
improvement in a single sprint, this is it:

1. Add `oxlint` + `oxfmt`, run in CI alongside ESLint (no removal yet).
2. Add `turbo.json`, wire `typecheck` and `test` through it.
3. Write `scripts/generate-register-aliases.js`, replace the hand-maintained
   alias list, add the generated file to `prebuild`/`prestart`.
4. Delete `BaseProvider` from `packages/sdk/src/providers.ts`; keep type
   exports only; update `@sdk/providers` consumers (only `register-built-in-providers.ts`
   imports the legacy class today, per a quick grep — verify before deleting).
5. Add a `madge`-based import-cycle and boundary check to `verify:architecture`.
6. Document the supervisor / failover Effect-TS port as a follow-up spec
   under `docs/plans/`.

Items 1–5 should land in under a week, eliminate the alias footgun, halve
the lint/typecheck runtime, and remove the duplicated provider class. None
of them require new architecture decisions or a long debate.

The bigger items — daemon split, full plugin-SDK barrel set, Effect-TS at
the supervisor — should be planned as proper specs in
`docs/superpowers/specs/` before implementation. They're worth it; they're
just not first-sprint work.

---

## What's already great (don't change)

- The Wave 2 normalized provider event envelopes
  (`@contracts/types/provider-runtime-events`) and adapter event bridge.
- `BaseProvider.events$` (RxJS) — the right primitive for streaming, even
  though Effect would be marginally more elegant.
- The contracts package — 50+ schemas with strict path-aliased imports.
- The orchestration suite (debate, consensus, multi-verify, parallel
  worktree, synthesis-agent, doom-loop-detector) — this is genuinely more
  sophisticated than anything in the peer projects.
- The supervisor tree + circuit breaker + load balancer + hibernation
  manager + warm-start manager combo. Effect-TS would clarify it; it works
  today.
- `scripts/generate-architecture-inventory.js`, `verify-ipc-channels.js`,
  `verify-package-exports.js`, `check-contracts-aliases.ts`. These
  drift-detection scripts are worth more than most peers have.
- The `register-aliases.ts` Node-runtime resolver itself (just generate it
  rather than maintaining by hand).
- OpenTelemetry already wired (`src/main/observability/otel-setup.ts`).
- `better-sqlite3` for RLM and persistence — fast, embedded, well-suited.

---

*Report generated by Claude after deep-dive of `ai-orchestrator/`,
`opencode/`, `t3code/`, `openclaw/`, `nanoclaw/`, `claw-code/`,
`hermes-agent/`, `codex/`, `agent-orchestrator/` on 2026-05-10.*
