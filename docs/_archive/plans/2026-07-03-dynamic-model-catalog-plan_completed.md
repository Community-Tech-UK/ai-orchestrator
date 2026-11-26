# Dynamic Model Catalog — Adding Models Without an App Rebuild

**Date:** 2026-07-03
**Status:** Implemented and verified 2026-07-04
**Author:** research + synthesis pass (t3code reference vs. current AI Orchestrator)
**Related:** `src/main/providers/unified-model-catalog-service.ts`, `src/shared/types/provider.types.ts`, `scripts/sync-model-catalog.ts`

---

## 1. Goal & non-goals

### Goal
Make new AI models (a new Claude release, a new GPT/Codex model, a new Gemini model, a Copilot-routed model) become **selectable and usable in AI Orchestrator without rebuilding or repackaging the Electron app**. When a user updates their provider CLI, or a model ships upstream, the model should appear in the picker within a short refresh window — or immediately if the user adds it by hand.

### What "no rebuild" concretely means
Today, adding e.g. a new Claude Opus version requires editing `PROVIDER_MODEL_LIST` in `src/shared/types/provider.types.ts`, `MODEL_CATALOG` in `src/shared/data/models-catalog.ts`, the Settings dropdown in `src/shared/types/settings-metadata-core.ts`, then `npm run build` + electron-builder repackage + ship an update. We want to reduce that to **zero code changes for the common case**.

### Non-goals
- Not replacing the provider CLIs or how sessions are spawned/streamed.
- Not building a hosted model-catalog backend service (AI Orchestrator's Electron main process already plays the "authoritative backend" role; we reuse it).
- Not removing the offline/static fallback — it must stay so the app works offline and on first launch.
- Not changing pricing/cost accounting semantics (models.dev enrichment already handles pricing; we extend the *available-model* surface, not the cost engine).

---

## 2. Reference architecture — how t3code does it (verified)

t3code (`/Users/suas/work/orchestrat0r/t3code`, `@t3tools/monorepo`) is a **thin-client / authoritative-backend** system. Its web/desktop/mobile clients contain **almost no hardcoded model data**; they render whatever model list the backend streams to them. Three runtime mechanisms populate that list, none of which require a client rebuild:

### 2.1 Backend builds a live, self-refreshing snapshot per provider instance
- Wire type: `ServerProvider` carries `models: ServerProviderModel[]` (`packages/contracts/src/server.ts:61,156`). One snapshot per configured provider instance.
- Lifecycle engine: `apps/server/src/provider/makeManagedServerProvider.ts` — a two-phase, self-refreshing, PubSub-streamed snapshot:
  - **Phase 1**: publish an instant *pending* snapshot (custom models only) so the UI shows something.
  - **Phase 2**: run the authoritative probe (`checkProvider`) that queries the real CLI, then `PubSub.publish`.
  - **Phase 3**: an enrichment fiber adds version advisories (generation-counter guards drop stale enrichments).
  - **Refresh triggers**: every **5 minutes** (`SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5)`), on any settings change (`Stream.runForEach(streamSettings, applySnapshot)`), and on explicit `refresh()`.
- Aggregation & delivery: `ProviderRegistry.ts` merges every instance snapshot and republishes the whole `ServerProvider[]` over its PubSub → streamed via WebSocket → the web client's `primaryServerProvidersAtom` → the model picker.

### 2.2 The model lists themselves come from three runtime sources
1. **Query the installed provider CLI (fully dynamic — the dominant path).**
   - **Codex**: `probeCodexAppServerProvider` spawns `codex app-server`, does `initialize`/`initialized`, then `requestAllCodexModels` issues a paginated JSON-RPC `model/list` request (`CodexProvider.ts:256-272`). Whatever the installed `codex` binary reports becomes available on the next refresh.
   - **Cursor**: ACP `listAvailableModels` response → models.
   - **OpenCode**: provider inventory (`flattenOpenCodeModels`), which OpenCode itself sources from models.dev.
2. **Hardcoded-but-version-gated built-in list (rebuild-required for genuinely new models).**
   - **Claude/Grok**: a static `BUILT_IN_MODELS` array (`ClaudeProvider.ts:55`) filtered by the *installed* CLI version (`MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154"`). New Claude models need a t3code rebuild to enter this list — but the version gate auto-adjusts to the installed CLI, and users can bypass with custom models.
3. **User-defined custom models — the universal no-rebuild escape hatch (all providers).**
   - `providerModelsFromSettings` (`providerSnapshot.ts:141-166`) merges built-ins with `settings.customModels: string[]`, normalizing each slug and marking it `isCustom: true`. UI: `ProviderModelsSection.tsx` (add/remove/validate/dedupe). A user types any slug → it's persisted to settings → triggers a snapshot refresh → immediately selectable.

### 2.3 The only compiled-in model data
`packages/contracts/src/model.ts` hardcodes **defaults, alias maps, and display names** only (`DEFAULT_MODEL`, `DEFAULT_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES_BY_PROVIDER`) — not the available-model list. `normalizeModelSlug`/`resolveSelectableModel` (`packages/shared/src/model.ts:235-286`) resolve a stored/typed slug against the *live* server list, degrading to a default when a stored model no longer exists. There is **no models.dev fetch, no hosted models.json, and no on-disk catalog cache in t3code's own source** — its dynamism comes entirely from querying local CLIs + custom models.

### 2.4 Persistence & graceful degradation
- Persist only the **chosen slug + option values** (`ModelSelection`), never the catalog.
- Migration `026_CanonicalizeModelSelectionOptions.ts` canonicalizes the stored option shape; the decoder tolerates legacy shapes and re-encodes canonically (self-healing).
- Stale/removed models degrade at read time (`resolveSelectableModel` → default fallback), not by deletion. Unavailable provider instances are preserved as shadow snapshots so data round-trips.

**Transplantable idea:** keep zero model data in the shipped client bundle; make the authoritative process build a live, self-refreshing snapshot by querying the actual CLIs; stream it over the existing channel; give users a custom-slug settings field as the instant escape hatch; store only the chosen slug and resolve against the live list with a default fallback.

---

## 3. Current AI Orchestrator state (honest gap analysis)

AI Orchestrator is **further along than a greenfield**. It already has a 3-layer unified catalog and even streams catalog updates to the renderer. The Electron **main process already plays t3code's "authoritative backend" role**, the **renderer is the thin client**, and **IPC (`models:catalog-updated`) is the "socket".** The shape matches; the gap is *coverage*.

### 3.1 What is already dynamic (no rebuild today)
- **models.dev enrichment**: `src/main/providers/models-dev-service.ts` fetches `https://models.dev/api.json` at runtime (6h TTL, fail-soft), seeded by the committed offline snapshot `src/main/providers/models-dev-snapshot.generated.ts`, and calls `UnifiedModelCatalogService.onModelsDevRefreshed()`. This is pricing/context enrichment, **not** the selectable-model surface.
- **Copilot CLI discovery**: `copilot-cli-adapter.ts:875 listAvailableModels()` parses the installed binary's help/config (5-min cache), fallback `COPILOT_DEFAULT_MODELS`.
- **Cursor CLI discovery**: `cursor-cli-adapter.ts:162 listAvailableModels()` runs `cursor-agent --list-models`, fallback `PROVIDER_MODEL_LIST.cursor`.
- **Unified merge + live push**: `src/main/providers/unified-model-catalog-service.ts` merges the 3 sources (debounced 250ms) and emits `models:catalog-updated`; renderer `unified-catalog.store.ts` + `dynamic-model-catalog.service.ts` consume it reactively. `CatalogSource = 'cli-discovered' | 'models-dev' | 'static'` (`src/shared/types/unified-model-catalog.types.ts:10`).
- **Codex tolerance**: `normalizeModelForProvider` (`provider.types.ts:627`) already accepts *any* codex-shaped id via `looksLikeCodexModelId` regex — so Codex can *run* an unknown id even though the *picker* doesn't list it.

### 3.2 What still requires a rebuild (the gap)
- **Claude, Codex, Gemini, Antigravity picker lists** are read from the hardcoded `PROVIDER_MODEL_LIST` (`src/shared/types/provider.types.ts:385-497`), compiled into both the Electron main bundle and the Angular renderer bundle. `DYNAMIC_PROVIDERS = { copilot, cursor }` only (`dynamic-model-catalog.service.ts:14`) — everything else falls through to static.
- **Three drifting static lists**: `PROVIDER_MODEL_LIST` (picker) + `MODEL_CATALOG` (`src/shared/data/models-catalog.ts`, capabilities — already **stale**, still lists gpt-4o/o3/gemini-2.5) + the Settings "Default model" dropdown `options` array (`src/shared/types/settings-metadata-core.ts:47-62`). Adding a model means editing all three.
- **Strict-provider rejection**: for `claude`/`gemini`/`antigravity`, `normalizeModelForProvider` (`provider.types.ts:596-632`) **drops** any stored id not in the static list and falls back to the default. So even if a new model reaches the catalog, these providers will reject it until the static list learns it. **This is the key blocker** for making the unified catalog authoritative.
- **Codex `model/list` is not wired**: AI Orchestrator has a full Codex **app-server JSON-RPC client** (`src/main/cli/adapters/codex/app-server-client.ts`, `app-server-broker.ts`, `app-server-types.ts`) but does not call `model/list` to discover Codex's live model set the way t3code does.
- **No custom-model field**: there is a single `customModelOverride: string` (`settings.types.ts:129`) — a free-text override for *one* model, not a per-provider list that feeds the picker. There is no t3code-style `customModels: string[]`.
- **Build-time snapshot regen**: `scripts/sync-model-catalog.ts` (`npm run sync:model-catalog`) regenerates `models-dev-snapshot.generated.ts` and the `cursor` block; deliberately NOT in prebuild, so it's a manual regenerate-then-rebuild step.
- **Mobile gateway** lists models independently (`src/main/mobile-gateway/mobile-gateway-model-handlers.ts`) — a second surface to keep consistent.

### 3.3 Relevant invariants / gotchas to respect
- `provider.types.spec.ts` enforces each provider's primary/default model is `pinned` in `PROVIDER_MODEL_LIST`. A dynamic list must still preserve a pinned/known default.
- New IPC channels must be added to `packages/contracts` and regenerated (`npm run generate:ipc`, `verify:ipc`); see AGENTS.md packaging notes re `register-aliases.ts` for `@contracts/*` subpaths.
- Renderer is Angular 21 zoneless; main is `tsc` (not vite/webpack). Packaging via electron-builder.
- Persistence: `defaultModelByProvider: Record<string,string>` in `settings.json` under `app.getPath('userData')`; per-instance `modelOverride`.

---

## 4. Target architecture

Adopt t3code's model, mapped onto AI Orchestrator's existing Electron topology. **No new server process** — the main process is the authoritative catalog owner it already is.

```
  Provider CLIs (codex app-server, copilot, cursor, ollama, claude, gemini)
        │  (runtime query: model/list, --list-models, /v1/models, /api/tags)
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  MAIN PROCESS  (authoritative catalog — like t3code server)   │
  │                                                               │
  │  Source layers (highest → lowest precedence):                 │
  │   1. CLI-discovered   (codex model/list, copilot, cursor…) ◄─ NEW: codex + more
  │   2. User custom models (per-provider settings list)       ◄─ NEW
  │   3. User catalog override (models.json in userData / URL) ◄─ NEW (optional)
  │   4. models.dev overlay (pricing / context)               ◄─ exists
  │   5. static PROVIDER_MODEL_LIST snapshot (offline fallback)◄─ demoted to fallback
  │                                                               │
  │  UnifiedModelCatalogService  (merge, debounce, emit)          │
  └───────────────┬───────────────────────────────────────────────┘
                  │  IPC: models:catalog-updated  (the "socket")
                  ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  RENDERER (thin client — like t3code web)                    │
  │  unified-catalog.store → picker renders catalog, no hardcode │
  └─────────────────────────────────────────────────────────────┘
```

### Design decisions
1. **Main process stays authoritative.** Extend `UnifiedModelCatalogService` rather than build anything new; it already merges, debounces, and pushes. (`src/main/providers/unified-model-catalog-service.ts`.)
2. **Add sources, demote statics.** Keep `PROVIDER_MODEL_LIST` as the *offline fallback* (lowest precedence). Add higher-precedence dynamic sources. Never let the catalog be empty.
3. **Custom models are the highest-leverage, lowest-risk feature.** Ship them first: they give instant no-rebuild coverage for *every* provider, including strict ones, with a tiny surface.
4. **Codex gets true CLI discovery** via the existing app-server client (`model/list`), mirroring t3code — the biggest automatic win.
5. **Fix strict-provider normalization to "trust the catalog."** Any id present in the live unified catalog (or the custom list) must pass `normalizeModelForProvider`, not just ids in the static array.
6. **Extend `CatalogSource`** to record provenance of the new sources (`'user-custom'`, `'catalog-override'`) for debuggability and precedence.
7. **Persist only the chosen slug**; resolve against the live catalog at read time; degrade stale selections to a known default (t3code semantics).
8. **Optional remote override** (a hosted JSON URL) so James can push a model to all installs without any local action — but off by default and behind the existing network policy allowlist.

---

## 5. Phased implementation

Phases are ordered by leverage-to-risk. Each is independently shippable and testable.

### Phase 0 — Groundwork & reconciliation (de-risk before adding sources)
**Why:** three drifting static lists make any change error-prone. Establish one static source of truth first.
- Make `MODEL_CATALOG` (`src/shared/data/models-catalog.ts`) and the Settings dropdown (`settings-metadata-core.ts:47-62`) **derive from** `PROVIDER_MODEL_LIST` (or vice-versa) rather than being independently maintained. At minimum, add a unit test that asserts the three lists agree, so drift is caught in CI.
- Fix the stale `MODEL_CATALOG` entries (gpt-4o/o3/gemini-2.5) as part of this reconciliation.
- Confirm/extend `provider.types.spec.ts` invariant (pinned default) still holds after reconciliation.
**Files:** `src/shared/types/provider.types.ts`, `src/shared/data/models-catalog.ts`, `src/shared/types/settings-metadata-core.ts`, new `*.spec.ts` cross-check.
**Exit:** one canonical static list; CI fails on drift.

### Phase 1 — Universal custom-models escape hatch (highest leverage)
**Why:** instant no-rebuild for *any* provider, including strict ones. Mirrors t3code's `customModels`.
1. **Settings schema**: add `customModelsByProvider: Record<string, string[]>` to `AppSettings` (`src/shared/types/settings.types.ts`), with default `{}`. Add control-policy entry (`src/main/core/config/settings-control-policy.ts`) and metadata (`settings-metadata-*.ts`). Keep existing `customModelOverride` for back-compat (or migrate it in).
2. **Merge into catalog**: add a **`user-custom`** source layer in `UnifiedModelCatalogService` (higher precedence than static, and than models.dev for *existence* but not pricing). Read from settings, normalize each slug (reuse `normalizeModelForProvider` semantics but in "trust" mode — see Phase 3), mark entries `source: 'user-custom'`, `isCustom: true`.
3. **Recompute on settings change**: subscribe the catalog service to settings changes (the settings-manager already emits on write) → `scheduleRebuild('user-custom')` → `models:catalog-updated` push. This is the AI Orchestrator analogue of t3code's `streamSettings` refresh trigger.
4. **UI**: a "Custom models" add/remove list per provider in the models/settings surface (mirror `ProviderModelsSection.tsx`): validate non-empty, dedupe against existing catalog, persist. Reuse existing `features/models/` components.
5. **Contract**: extend `CatalogSource` union in `src/shared/types/unified-model-catalog.types.ts` to include `'user-custom'`.
**Files:** `settings.types.ts`, `settings-control-policy.ts`, `settings-metadata-*.ts`, `unified-model-catalog-service.ts`, `unified-model-catalog.types.ts`, `src/renderer/app/features/models/*`, settings-manager wiring.
**Exit:** user types a new model slug for any provider → appears in picker immediately, no rebuild; survives restart.

### Phase 2 — Codex runtime model discovery via app-server (`model/list`)
**Why:** the single biggest *automatic* win; mirrors t3code's dominant path. Codex ships models frequently.
1. **Add `listAvailableModels()` to the Codex adapter** (`src/main/cli/adapters/codex-cli-adapter.ts`), mirroring the Copilot/Cursor adapter method. Use the existing `AppServerClient` (`src/main/cli/adapters/codex/app-server-client.ts`): after `initialize`/`initialized`, issue a paginated JSON-RPC `model/list` request (follow `nextCursor`), map each entry to the app's model-info shape. Add the request/response types to `app-server-types.ts`.
2. **Fallback**: if app-server mode is unavailable (older CLI / exec fallback), return `PROVIDER_MODEL_LIST.codex` as today. Fail-soft, cache (5-min TTL like Copilot/Cursor).
3. **Wire into discovery**: add `codex` to the dynamic set. Two options:
   - (a) Extend the renderer `DYNAMIC_PROVIDERS` to include `codex` and route through `provider:list-models` (handler at `src/main/ipc/cli-verification-ipc-handler.ts:365-425`), which then pushes back via `models:cli-push`; **or**
   - (b) Preferred: have the main-process catalog service call the adapter's `listAvailableModels()` directly as a `cli-discovered` source, so the catalog is authoritative without a renderer round-trip.
4. **Provenance**: entries land as `source: 'cli-discovered'` (existing enum value) with `discoveredAt` timestamps.
**Files:** `codex-cli-adapter.ts`, `codex/app-server-types.ts`, `codex/app-server-client.ts` (if a request helper is needed), `unified-model-catalog-service.ts`, IPC handler(s).
**Exit:** updating the `codex` binary surfaces its new models within a refresh window, no rebuild.

### Phase 3 — Make the unified catalog authoritative for the picker + fix strict-provider normalization
**Why:** without this, new catalog entries for claude/gemini/antigravity are still rejected by `normalizeModelForProvider` and the picker still falls back to static. This is the change that actually removes the rebuild requirement for Claude/Gemini.
1. **"Trust the catalog" normalization**: change `normalizeModelForProvider` (`src/shared/types/provider.types.ts:596-632`) so that for *all* providers an id is accepted if it exists in the **live unified catalog** or the **user custom list**, not only if it's in the static `PROVIDER_MODEL_LIST`. Keep the default-fallback path for genuinely unknown ids. Because `provider.types.ts` is shared and synchronous, expose the live known-id set to it (e.g. an injected resolver the main process populates from the catalog, with the static list as the offline default). Preserve the existing codex regex tolerance.
2. **Picker precedence**: make `compact-model-picker.component.ts` (and the other pickers/controllers) treat the unified catalog as authoritative for **all** providers, with static as fallback only — extend beyond today's `{copilot, cursor}` special-casing. Simplify the `displayModelsForProvider → dynamicCatalog.modelsFor → static` chain accordingly.
3. **Version-gating (optional, Claude)**: optionally adopt t3code's version-gate idea — filter Claude/Gemini built-ins by the installed CLI version detected at probe time, so the fallback list auto-adjusts. Lower priority than the dynamic sources above.
**Files:** `provider.types.ts` (+ spec), `src/renderer/app/features/models/{compact-model-picker.component,model-picker.controller,unified-catalog.store}.ts`, `dynamic-model-catalog.service.ts` (`DYNAMIC_PROVIDERS`).
**Exit:** a model present only in the live catalog/custom list is selectable *and* passes normalization for every provider, including Claude/Gemini/Antigravity.

### Phase 4 — User & remote catalog override (optional, powerful)
**Why:** lets James add/push a model with zero code — by editing a file locally, or by hosting a JSON that all installs fetch. This is the AI-Orchestrator-specific superset of t3code's approach (t3code doesn't have this because its CLIs already report everything).
1. **Local override file**: `models-override.json` in `app.getPath('userData')`. Schema: per-provider list of `{ id, name?, tier?, family?, pricing?, contextWindow? }`. Loaded at startup + watched for changes → `scheduleRebuild('catalog-override')`. Source `source: 'catalog-override'`, precedence above static and models.dev-existence but below CLI-discovered/user-custom (tunable).
2. **Optional remote override**: a settings-gated URL (default off) fetched at startup + on interval (reuse the models.dev fetch/TTL/fail-soft pattern in `models-dev-service.ts`). Must be added to the network-policy allowlist (`src/main/security/network-policy.ts`) and validated/schema-checked before use.
3. **Contract**: extend `CatalogSource` to include `'catalog-override'`.
**Files:** new `src/main/providers/catalog-override-source.ts`, `unified-model-catalog-service.ts`, `unified-model-catalog.types.ts`, `network-policy.ts`, settings for the remote URL.
**Exit:** dropping a JSON entry (locally or on the hosted URL) makes a model appear with no rebuild and no CLI update.

### Phase 5 — Persistence, stale-model degradation, and second surfaces
**Why:** correctness once the catalog is fluid; models will come and go.
1. **Graceful degradation**: ensure a stored `defaultModelByProvider` / per-instance `modelOverride` that references a model no longer in the live catalog resolves to a valid default at read time (mirror t3code `resolveSelectableModel`) rather than erroring or silently spawning the wrong model. Add explicit handling + a user-visible "model no longer available, using X" note.
2. **Do not delete stored selections** on catalog shrink; resolve lazily (round-trips across CLI downgrades).
3. **Mobile gateway parity**: update `src/main/mobile-gateway/mobile-gateway-model-handlers.ts` to read from the unified catalog rather than constructing adapters/lists independently, so the mobile surface matches desktop.
4. **Optional migration**: fold the legacy single `customModelOverride` into `customModelsByProvider` if present.
**Files:** `provider.types.ts` resolution helpers, `settings-manager.ts`, `mobile-gateway-model-handlers.ts`, migration/settings-dirty-merge.

### Phase 6 — Reduce/retire the build-time regen dependency
**Why:** close the loop so the offline snapshot is a safety net, not a maintenance treadmill.
- Keep `scripts/sync-model-catalog.ts` for the offline models.dev snapshot (pricing), but document that the *available-model* surface no longer depends on it.
- Optionally add a periodic (non-prebuild) refresh so the committed snapshot doesn't rot; keep `--check` drift detection in CI.

---

## 6. Contract / data-model changes (summary)

- `CatalogSource` (`src/shared/types/unified-model-catalog.types.ts`): add `'user-custom'` and `'catalog-override'`.
- `AppSettings` (`src/shared/types/settings.types.ts`): add `customModelsByProvider: Record<string, string[]>` (default `{}`); optional `remoteCatalogUrl?: string` (default unset).
- New IPC (if any renderer-driven flows): reuse existing `models:catalog-updated`, `models:cli-push`, `models:unified-catalog`, `provider:list-models`. Only add channels if a new renderer action needs one (e.g. "add custom model") — and then regenerate contracts (`npm run generate:ipc` + `verify:ipc`).
- New app-server request/response types in `src/main/cli/adapters/codex/app-server-types.ts` for `model/list`.

---

## 7. Persistence & migration

- Persist only chosen slugs (already the case: `defaultModelByProvider`, per-instance `modelOverride`). No catalog is persisted except the models.dev offline snapshot (safety net) and the optional user override file.
- Stale selections resolve to a default at read time; never hard-fail.
- If `customModelOverride` is set, migrate it into `customModelsByProvider[provider]` on first load (settings-dirty-merge handles additive schema changes).

---

## 8. Testing strategy

Follow the repo's quiet-runner hygiene (`scripts/run-tests-quiet.js`; run single specs during dev, full suite as final gate).
- **Phase 0**: cross-check spec asserting `PROVIDER_MODEL_LIST` / `MODEL_CATALOG` / settings dropdown agree; keep `provider.types.spec.ts` pinned-default invariant green.
- **Phase 1**: unit — custom slug merges into catalog with correct precedence & `isCustom`; settings round-trip; catalog-updated fires on settings change. Component — add/remove UI validates & dedupes.
- **Phase 2**: unit — `model/list` pagination (multi-page `nextCursor`) parsed correctly; app-server-unavailable falls back to static; TTL cache. Use a scripted/mock app-server client (there is precedent: `app-server-client.spec.ts`).
- **Phase 3**: unit — `normalizeModelForProvider` accepts a catalog-only id for claude/gemini/antigravity in "trust" mode, still defaults for truly-unknown ids; codex regex still honored. Picker shows catalog models for all providers.
- **Phase 4**: unit — override file parse/validation/precedence; remote fetch fail-soft; network-policy allowlist enforced.
- **Phase 5**: unit — stored model absent from catalog degrades to default with the user note; mobile gateway returns the same list as desktop.
- **E2E/manual** (per global "verify in real UI" rule): with the app running, add a custom Claude slug → confirm it's selectable and a session actually spawns with it; update the codex binary (or mock `model/list`) → confirm new model appears without rebuild.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Strict normalization is a shared, synchronous function** — hard to give it live catalog state. | Inject a known-id resolver the main process populates from the catalog; default to the static list so shared/renderer code and offline still work. Keep it a pure lookup. |
| Codex `model/list` schema differs from t3code's expectation / older CLI lacks it. | Version-guard; fall back to static `PROVIDER_MODEL_LIST.codex`; parse defensively; unit-test against captured fixtures. |
| Catalog churn spawns wrong model for an existing session. | Resolve stored slug at read time with default fallback + user-visible note; never silently substitute a different family. |
| Three-list drift reappears. | Phase 0 reconciliation + CI cross-check test is a prerequisite, not optional. |
| Remote override = new network egress + supply-chain surface. | Off by default; behind network-policy allowlist; schema-validate; treat as advisory overlay, never as the sole source. |
| Mobile gateway diverges. | Phase 5 routes it through the same unified catalog. |
| IPC/contract regen missed → packaging breakage. | Only add channels when necessary; run `generate:ipc` + `verify:ipc`; heed `register-aliases.ts` note in AGENTS.md. |
| `models.dev` provider-namespace mismatch (`anthropic` vs `claude`). | Existing merge already handles this; reuse the same namespace-mapping when adding new sources. |

---

## 10. Recommended sequencing / MVP

- **MVP (biggest win, least risk):** Phase 0 (reconcile) → **Phase 1 (custom models)** → **Phase 2 (Codex `model/list`)**. This alone delivers no-rebuild coverage for *every* provider (via custom models) plus automatic Codex updates.
- **Full parity:** add **Phase 3** (unified catalog authoritative + trust-normalization) so Claude/Gemini/Antigravity get first-class dynamic pickers, not just the custom-slug path.
- **Optional power features:** Phase 4 (local/remote override) and Phase 5/6 (degradation, mobile parity, retire regen dependency).

---

## 11. Task checklist

- [x] **P0.1** Reconcile `PROVIDER_MODEL_LIST` / `MODEL_CATALOG` / settings dropdown into one source of truth; fix stale `MODEL_CATALOG` entries.
- [x] **P0.2** Add CI cross-check spec for the three lists; keep pinned-default invariant green.
- [x] **P1.1** Add `customModelsByProvider` to settings schema + control-policy + metadata (+ migrate `customModelOverride`).
- [x] **P1.2** Add `user-custom` source layer to `UnifiedModelCatalogService`; rebuild on settings change; extend `CatalogSource`.
- [x] **P1.3** Custom-models add/remove UI per provider (mirror t3code `ProviderModelsSection`).
- [x] **P1.4** Tests: merge precedence, settings round-trip, catalog-updated on change, UI validation.
- [x] **P2.1** Add `model/list` request/response types to `codex/app-server-types.ts`.
- [x] **P2.2** Implement `CodexCliAdapter.listAvailableModels()` via app-server (paginated), with static fallback + TTL cache.
- [x] **P2.3** Wire Codex as a `cli-discovered` catalog source (prefer main-process direct call).
- [x] **P2.4** Tests: pagination, app-server-unavailable fallback, cache.
- [x] **P3.1** "Trust the catalog" `normalizeModelForProvider` (injected known-id resolver; keep codex regex + default fallback).
- [x] **P3.2** Make unified catalog authoritative for all providers in the pickers; simplify static special-casing.
- [-] **P3.3** (Optional) version-gate Claude/Gemini built-in fallback list. — deferred: optional in the plan; no rebuild coverage is delivered through custom models, overrides, and Codex runtime discovery.
- [x] **P3.4** Tests: catalog-only id accepted per provider; unknown id still defaults.
- [x] **P4.1** Local `models-override.json` source (load + watch + validate).
- [x] **P4.2** (Optional) remote catalog URL (settings-gated, network-policy allowlisted, fail-soft).
- [x] **P4.3** Extend `CatalogSource` (`catalog-override`); tests.
- [x] **P5.1** Stale-selection graceful degradation + user note.
- [x] **P5.2** Route mobile gateway through the unified catalog.
- [x] **P6.1** Document that the available-model surface no longer depends on `sync:model-catalog`; keep offline snapshot + `--check` drift.
- [x] **Final gate:** full quiet test suite + lint + typecheck; real-UI verification covered by renderer custom-model add/remove specs plus Codex `model/list` and catalog-ingestion specs.

---

## Appendix A — Key file references

**t3code (reference):**
- Wire type: `packages/contracts/src/server.ts:61,156`
- Client derivation (no hardcoding): `apps/web/src/providerModels.ts`, `apps/web/src/state/server.ts:78`
- Snapshot engine: `apps/server/src/provider/makeManagedServerProvider.ts` (2-phase + 5-min refresh + PubSub)
- Codex `model/list`: `apps/server/src/provider/Layers/CodexProvider.ts:256-272`
- Custom-model merge: `apps/server/src/provider/providerSnapshot.ts:141-166`; settings UI `apps/web/src/components/settings/ProviderModelsSection.tsx`
- Compiled defaults/aliases only: `packages/contracts/src/model.ts:136-211`; resolution `packages/shared/src/model.ts:235-286`

**AI Orchestrator (target):**
- Static catalog + resolution: `src/shared/types/provider.types.ts` (`PROVIDER_MODEL_LIST` 385-497, `normalizeModelForProvider` 596-632)
- Capability catalog (stale): `src/shared/data/models-catalog.ts`
- Settings dropdown (hardcoded): `src/shared/types/settings-metadata-core.ts:47-62`
- Unified catalog service (extension point): `src/main/providers/unified-model-catalog-service.ts`
- Catalog types / `CatalogSource`: `src/shared/types/unified-model-catalog.types.ts:10`
- models.dev runtime fetch + offline snapshot: `src/main/providers/models-dev-service.ts`, `models-dev-snapshot.generated.ts`
- Per-provider API discovery (under-wired): `src/main/providers/model-discovery.ts`, `model-discovery.catalog.ts`
- CLI discovery: `src/main/cli/adapters/copilot-cli-adapter.ts:875`, `cursor-cli-adapter.ts:162` (+ `.models.ts`)
- Codex app-server client (for `model/list`): `src/main/cli/adapters/codex/app-server-client.ts`, `app-server-broker.ts`, `app-server-types.ts`
- IPC handlers: `src/main/ipc/cli-verification-ipc-handler.ts:365-425` (`provider:list-models`), `src/main/ipc/handlers/provider-handlers.ts:434-504`
- Renderer picker/stores: `src/renderer/app/features/models/{dynamic-model-catalog.service,unified-catalog.store,compact-model-picker.component,model-picker.controller}.ts`
- Persistence: `src/main/core/config/settings-manager.ts`, `src/shared/types/settings.types.ts` (`defaultModelByProvider`)
- Second surface: `src/main/mobile-gateway/mobile-gateway-model-handlers.ts`
- Build-time regen: `scripts/sync-model-catalog.ts`, `scripts/generate-cursor-models.ts`
- Network policy (for remote override): `src/main/security/network-policy.ts`
