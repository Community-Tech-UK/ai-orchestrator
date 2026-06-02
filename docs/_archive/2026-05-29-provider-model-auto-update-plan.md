# Provider & Model Auto-Update Plan

**Date:** 2026-05-29 · **Re-scoped:** 2026-05-30
**Status:** ⚠️ PARTIALLY IMPLEMENTED — **Phase 1 is DONE and committed.** Remaining open work = Phase 2 (true auto-apply) + Phase 3 (model-catalog freshness, itself partly built). Untracked — do not commit until the remaining phases are implemented & verified.
**Goal:** When a new version of a CLI provider (Claude Code, Codex, Gemini, Copilot, Cursor, …) is released — or a provider ships a new model — AI Orchestrator (AIO) should *notice automatically*, surface it, and offer to update. Modeled on t3code's "provider update" pill/check.

---

## 0. TL;DR (re-scoped 2026-05-30 — read this first)

**Phase 1 (CLI-version update detection) shipped.** The premise of the original draft — "the one missing piece is latest-version detection; `cli-update-poll-service.ts:111` hardcodes `updateAvailable: false`" — is **no longer true**. Verified in tree (committed 2026-05-29):
- `src/main/cli/semver.ts` — dependency-free semver compare (the §4 Phase-1.1 file).
- `src/main/cli/cli-latest-version.ts` — `fetchNpmLatestVersion` + `resolveLatestCliVersion` + 1h cache (the §4 Phase-1.2 file).
- `cli-update-poll-service.ts` now computes `updateAvailable = isUpdateAvailable(current, latest)` and `count` derives correctly → the pill is live, not dormant.
- `src/main/providers/models-dev-service.ts` (+ `.spec.ts`) and `src/shared/data/model-pricing.ts` **already exist** and fetch models.dev with a pricing overlay — so Phase 3-B is *also* partly built (it is NOT greenfield; see §3 below).

So Phase 1 §4 is a record of completed work; **do not re-implement it.** The original t3code reference (§1) and capability table (§2) are retained as background.

**What remains genuinely open:**
- **Phase 2** — true unattended *auto-apply* (beyond t3code's notify-only): the `cliUpdatePolicy` setting + apply-on-detect + per-package lock. Not built.
- **Phase 3** — "latest model" freshness. The CLI resolves bare names (`opus`/`sonnet`) to latest already; the staleness is the **versioned catalogs + pricing in `provider.types.ts`**. `models-dev-service.ts` gives the *fetch*; what's missing is **wiring it into the model picker** (Phase 3-A, = claude1_todo #9 "models.dev → picker", still PARTIAL) and/or a build-time catalog-sync that regenerates the curated constants (Phase 3-B).

---

## 1. How t3code does it (the reference)

All paths below are under `t3code/`.

### 1.1 Maintenance capabilities — per-provider, install-method aware
`apps/server/src/provider/providerMaintenance.ts`

- Each driver declares a `PackageManagedProviderMaintenanceDefinition`: `npmPackageName`, `homebrewFormula`, and an optional `nativeUpdate` (e.g. `claude update`). Example — `apps/server/src/provider/Drivers/ClaudeDriver.ts:66`:
  ```ts
  const UPDATE = makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@anthropic-ai/claude-code",
    homebrewFormula: "claude-code",
    nativeUpdate: { executable: "claude", args: ["update"], lockKey: "claude-native", isCommandPath: isClaudeNativeCommandPath },
  });
  ```
- `resolvePackageManagedProviderMaintenance()` inspects the **resolved binary path** (following symlinks via `realPath`) and decides the correct update command: npm-global (`npm install -g pkg@latest`), bun (`bun i -g`), pnpm (`pnpm add -g`), vite-plus, homebrew (`brew upgrade formula`), or the native self-updater. This is more thorough than AIO's path heuristic.

### 1.2 Latest-version detection + advisory — **the key piece**
`apps/server/src/provider/providerMaintenance.ts`

- `fetchNpmLatestVersion(pkg)` → `GET https://registry.npmjs.org/<pkg>/latest`, reads `.version`. **4s timeout, fail-soft to `null`.**
- `resolveLatestProviderVersion()` caches per-package for **1 hour** (`LATEST_VERSION_CACHE_TTL_MS`).
- `deriveVersionAdvisory()` uses `compareSemverVersions(current, latest)` (`packages/shared/src/semver.ts`, dependency-free, handles `v` prefix + prerelease):
  - `current < latest` → `behind_latest` (+ "Install the update now…")
  - missing either → `unknown`
  - else → `current`
- `enrichProviderSnapshotWithVersionAdvisory()` attaches the advisory to the provider snapshot.

Contract — `packages/contracts/src/server.ts:119`:
```ts
ServerProviderVersionAdvisory = { status: "unknown"|"current"|"behind_latest",
  currentVersion, latestVersion, updateCommand, canUpdate, checkedAt, message }
```

### 1.3 When it checks — automatic, every 5 min
Each driver sets `SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5)` and `makeManagedServerProvider` re-runs the snapshot (re-probe version + models + re-enrich advisory) on that interval. The npm fetch is cached 1h, so the registry is hit ≈ hourly while the *check* runs every 5 min. The provider `models` array is part of the same snapshot, so model lists refresh on the same cadence.

### 1.4 One-click update (apply)
`apps/server/src/provider/providerMaintenanceRunner.ts`

- `updateProvider()` resolves capabilities → acquires a **lock keyed by package manager** (`npm-global`, `homebrew`, …) so two npm updates never collide → runs the command (**5-min timeout, 10KB output cap**) → **re-detects and re-verifies** the advisory; reports `succeeded` / `unchanged` / `failed`.
- It is **user-triggered** (the toast/settings calls the `updateProvider` RPC). t3code **notifies + one-click**, it does **not** silently auto-apply.

### 1.5 UI
- `apps/web/src/components/sidebar/SidebarProviderUpdatePill.tsx` — sidebar pill, tones loading/success/warning/error; click → `/settings/providers`.
- `apps/web/src/components/ProviderUpdateLaunchNotification.{tsx,logic.ts}` — toast with phases (initial → running → succeeded/unchanged/failed) and a one-click action when `canOneClickUpdate`.

---

## 2. What AIO already has (more than expected)

All paths below are under `ai-orchestrator/`.

| Capability | t3code | AIO — status |
|---|---|---|
| Detect installed CLI + version (`--version`) | driver probe | ✅ `src/main/cli/cli-detection.ts` (`CliDetectionService`, shadow-install scan) |
| Per-provider update spec (npm pkg / brew / self-update) | driver maintenance def | ✅ `src/main/cli/cli-update-service.ts:31` `CLI_UPDATE_SPECS` |
| Resolve install-method → update command | `resolvePackageManagedProviderMaintenance` | ⚠️ `cli-update-service.ts` (`resolveSiblingNpm`, `isHomebrewPath`, self-update) — works, but **no bun/pnpm + no symlink `realPath`** |
| Execute update + re-detect + lock | `providerMaintenanceRunner` | ✅ `cli-update-service.ts` `updateOne/updateAllInstalled` (300s timeout, re-detect). ⚠️ serialized via `for`-loop, no per-package lock |
| **Fetch latest version + semver compare** | `fetchNpmLatestVersion` + `compareSemverVersions` | ❌ **MISSING — the whole gap** |
| Background check | 5-min snapshot refresh | ⚠️ `src/main/cli/cli-update-poll-service.ts` polls **24h** but hardcodes `updateAvailable:false` (line 111) |
| Advisory data shape | `ServerProviderVersionAdvisory` | ✅ partial: `CliUpdatePillEntry.{latestVersion,updateAvailable}` already exist (`src/shared/types/diagnostics.types.ts:193`), just never populated |
| Update pill UI | sidebar pill | ✅ `src/renderer/app/features/title-bar/cli-update-pill.component.ts` — renders when `count>0`, tooltip already shows `current → latest`; store `cli-update-pill.store.ts`; bootstrapped in `src/main/bootstrap/infrastructure-bootstrap.ts:64` |
| Settings UI to apply | `/settings/providers` | ✅ CLI Health tab: `src/renderer/app/features/settings/cli-health-settings-tab.component.ts` ("Update all", per-CLI "Run updater") |
| IPC / preload / renderer service | RPC | ✅ `CLI_UPDATE_ONE/ALL/PILL_*`, `provider.preload.ts`, `provider-ipc.service.ts` |
| Network egress to registry | HttpClient | ✅ `registry.npmjs.org` already in allowlist (`src/main/security/network-policy.ts:101`); main process already uses `https` (`model-discovery.ts`) |
| Dynamic model discovery | snapshot `models[]` | ✅ `src/main/providers/model-discovery.ts` (API providers, 1h cache) + Copilot CLI dynamic listing |
| Static model catalog | curated | ✅ `src/shared/types/provider.types.ts` (`CLAUDE_PINNED_MODELS`, `OPENAI_MODELS`, `GOOGLE_MODELS`, `COPILOT_MODELS`, `MODEL_PRICING`, `PROVIDER_MODEL_LIST`) — **hand-maintained** |

**Conclusion:** the dormant pill is wired end-to-end. Populate `latestVersion`/`updateAvailable` and it turns on.

---

## 3. The gap, precisely — ✅ CLOSED (kept for history)

> **2026-05-30:** This section described the original gap. It has been **fixed** — `cli-update-poll-service.ts` now calls `isUpdateAvailable(currentVersion, latestVersion)` (no longer hardcoded `false`), and `src/main/cli/semver.ts` is the new semver utility. Likewise the "`models-dev-service.ts` doesn't exist" assumption behind Phase 3-B is wrong: `src/main/providers/models-dev-service.ts` + `src/shared/data/model-pricing.ts` are in tree and fetch models.dev. Read the rest of this section as the historical problem statement.

`src/main/cli/cli-update-poll-service.ts:102-113` (original, now superseded):
```ts
entries.push({
  cli,
  displayName: CLI_REGISTRY[cli]?.displayName ?? cli,
  currentVersion: plan.currentVersion ?? detectedByName.get(cli)?.version,
  // Outdated-detection (querying the registry/brew/etc. for a newer version)
  // is not yet implemented. ... the pill's `count` ... stays at 0 ...
  updateAvailable: false,   // ← hardcoded
  updatePlan: plan,
});
```
`count = entries.filter(e => e.updateAvailable === true).length` → always 0 → pill hidden. AIO also has **no semver utility and no `semver` dependency** (only `parseVersion` in `rtk-runtime.ts`, which just extracts a string).

---

## 4. Implementation plan

### Phase 1 — Turn on CLI-version update detection — ✅ DONE (committed 2026-05-29)

> All of Phase 1 below is **implemented**: `semver.ts`, `cli-latest-version.ts`, the poll-service wiring, and tests all exist in tree. The subsections are kept verbatim as the implementation record / acceptance reference. **Skip to Phase 2** for open work. (Optional 1.5 install-method polish — bun/pnpm/`realpath` — should be spot-checked against the shipped `cli-update-service.ts`; treat as a small follow-up only if not present.)

**1.1 Add a dependency-free semver utility.**
New file `src/main/cli/semver.ts` — port t3code's `packages/shared/src/semver.ts` (`normalizeSemverVersion`, `parseSemver`, `compareSemverVersions`; handles `v` prefix, 2-segment versions, prerelease ordering). No new npm dep.
Tests: `src/main/cli/__tests__/semver.spec.ts` (equal, major/minor/patch ordering, `v`-prefix, prerelease `<` release, malformed → null).

**1.2 Add latest-version resolver.**
New file `src/main/cli/cli-latest-version.ts`:
- `fetchNpmLatestVersion(pkg): Promise<string|null>` — `https.get(https://registry.npmjs.org/<pkg>/latest)`, parse `.version`. **~4s timeout, fail-soft → null.** Mirror the `https` usage style already in `model-discovery.ts`.
- Per-package **1h cache** (Map with `expiresAt`), plus a `force` flag.
- `resolveLatestCliVersion(cli): Promise<string|null>` — map `cli → npm package` from `CLI_UPDATE_SPECS`:
  - npm-backed (`claude`, `codex`, `gemini`, `copilot`) → `fetchNpmLatestVersion`.
  - `cursor` (no npm pkg, self-update only) → `null` for now (parity with t3code, which yields `unknown`). *Stretch:* GitHub releases API.
  - `ollama` (brew) → `null` for now. *Stretch:* `https://formulae.brew.sh/api/formula/ollama.json` `.versions.stable`.
- Respect `NetworkPolicy` if it intercepts main-process egress (registry is already allowlisted).
- To expose the package names: export a small `getCliUpdateSpec(cli)` / `CLI_UPDATE_SPECS` accessor from `cli-update-service.ts` (currently module-private), or lift `CLI_UPDATE_SPECS` into a shared const both files import.

Tests: `src/main/cli/__tests__/cli-latest-version.spec.ts` — mock `https`/fetch: success, non-2xx, timeout, malformed JSON all → null; cache hit avoids second call.

**1.3 Wire into the poll service.**
`src/main/cli/cli-update-poll-service.ts` `refreshInternal()` — for each installed + supported CLI:
```ts
const latestVersion = await resolveLatestCliVersion(cli);          // fail-soft
const currentVersion = plan.currentVersion ?? detectedByName.get(cli)?.version;
const updateAvailable = !!(currentVersion && latestVersion &&
  compareSemverVersions(currentVersion, latestVersion) < 0);
entries.push({ cli, displayName, currentVersion, latestVersion, updateAvailable, updatePlan: plan });
```
`count` then derives correctly and the pill appears. The existing `emit('change')`-only-on-diff logic already prevents spam.

**1.4 Cadence + freshness.**
- Keep the 24h interval as the registry-cache refresh floor **but** add **refresh-on-demand**: call `getCliUpdatePollService().refresh()` when the CLI Health settings tab opens and (optionally) on app focus/window-show. This is what makes "a new version came out" visible within minutes of the user looking, without hammering npm (1h cache).
- *Optional:* drop the interval to ~6h. The registry fetch is cached 1h regardless, so cost is bounded.

**1.5 Improve install-method resolution (parity polish, optional within Phase 1).**
In `cli-update-service.ts` add bun/pnpm path detection and `fs.realpathSync` symlink resolution before classifying npm-vs-brew (port `isBunGlobalCommandPath` / `isPnpmGlobalCommandPath` / `realPath` logic from t3code). Prevents "ran the wrong package manager" on bun/pnpm/volta installs.

**Phase 1 acceptance:** with an intentionally-downgraded CLI, the title-bar pill shows "Update CLI", tooltip reads `current → latest`, clicking opens CLI Health, "Run updater" updates and the pill clears on next refresh.

---

### Phase 2 — Optional true *auto-apply* (beyond t3code's notify-only)

The user said "auto-update". t3code only notifies + one-click. Add a setting so AIO can go further:

- New setting in `AppSettings` (`src/shared/types/settings.types.ts`): `cliUpdatePolicy: 'off' | 'notify' | 'auto'`, default `'notify'` (= current behavior; `'off'` hides the pill).
- When `'auto'`: after the poll finds `updateAvailable` entries, call the existing `CliUpdateService.updateOne()` per CLI, **serialized**, then refresh. Reuse existing pill/toast states for progress (add an `'updating'` flavor if desired).
- **Guardrails:** only auto-apply `npm`/native self-update strategies (never an unattended `brew`/`sudo`); skip while interactive sessions are running; exponential backoff + don't retry the same failed version; respect a "paused/offline" state.
- Add a per-package update lock (port t3code's `lockKey` idea) so a manual "Update all" and the auto-updater can't run npm concurrently.

---

### Phase 3 — Latest-model freshness (the "latest model" half)

Two model surfaces in AIO:
1. **Bare-name CLI models** (`CLAUDE_MODELS.OPUS = 'opus'`, `'sonnet'`): the CLI resolves these to the latest generation server-side — **no maintenance needed** (documented at `provider.types.ts:135`).
2. **Versioned catalogs + pricing**: `CLAUDE_PINNED_MODELS`, `OPENAI_MODELS`, `GOOGLE_MODELS`, `COPILOT_MODELS`, `MODEL_PRICING`, `PROVIDER_MODEL_LIST` — **hand-edited today**. This is the staleness gap.

Options (recommend doing both A and B):

- **A — Runtime discovery in the picker (low risk).** Surface `ModelDiscoveryService` output for key/API providers and the already-wired Copilot dynamic listing in the model menu, **merging** discovered IDs with the static catalog (static supplies curated tier/pricing/`pinned`; dynamic supplies freshness). Extend the same dynamic listing to Codex/Gemini where the CLI/API exposes a model list. New IDs appear automatically; unknown ones fall through to a default tier/group.
- **B — Build-time catalog sync (keeps curation).** Add `scripts/refresh-model-catalog.ts` that pulls from **models.dev** (the cross-provider registry opencode/others use) and/or each provider's models endpoint, and regenerates the catalog + `MODEL_PRICING` constants, run on a schedule/CI that opens a PR with the diff. Removes manual editing while preserving the curated dropdown UX and pricing accuracy.

Pricing especially should come from a source of truth (models.dev) rather than being typed by hand.

---

## 5. Files to touch (checklist)

**Phase 1**
- [ ] `src/main/cli/semver.ts` (new) + `__tests__/semver.spec.ts`
- [ ] `src/main/cli/cli-latest-version.ts` (new) + `__tests__/cli-latest-version.spec.ts`
- [ ] `src/main/cli/cli-update-service.ts` — export `CLI_UPDATE_SPECS`/`getCliUpdateSpec`; (optional) bun/pnpm + `realpath` resolution
- [ ] `src/main/cli/cli-update-poll-service.ts` — populate `latestVersion`/`updateAvailable`; update its spec
- [ ] (optional) refresh-on-demand trigger from CLI Health tab open / app focus
- [ ] Verify renderer pill + CLI Health tab render correctly (no code change expected)

**Phase 2**
- [ ] `src/shared/types/settings.types.ts` — add `cliUpdatePolicy`; settings UI toggle; migration default `'notify'`
- [ ] `src/main/cli/cli-update-poll-service.ts` (or a new `cli-auto-update-service.ts`) — apply-on-detect when `'auto'`
- [ ] per-package update lock in `cli-update-service.ts`

**Phase 3**
- [ ] Model picker merge of dynamic + static (renderer model menu + IPC for Codex/Gemini listing)
- [ ] `scripts/refresh-model-catalog.ts` (new) + CI wiring + provider.types.ts regeneration

---

## 6. Risks & gotchas

- **Network/proxy:** registry is allowlisted, but corporate proxies/offline still happen → **always fail-soft to `null`**, never block startup or the poll. Confirm whether `NetworkPolicy` actually intercepts main-process `https` (model-discovery suggests not) and route through it if so.
- **Version-string formats:** confirm each `--version` output parses to clean semver (the registry uses `latest` dist-tag, avoiding betas; the prerelease-aware compare handles odd CLI version strings). Cursor reports a non-npm version → keep `unknown`.
- **No false positives:** `updateAvailable` only when *both* versions parse and `current < latest`; brew/cursor stay `unknown` (no pill) until a latest source exists.
- **Don't spam:** 1h registry cache + change-only `emit` already cover this; keep them.
- **Auto-apply (Phase 2) safety:** unattended package installs can break a working setup — gate behind opt-in, exclude `brew`/`sudo`, serialize with a lock, back off on failure, avoid updating mid-session.
- **Phase 3 scope creep:** keep static curation as the UX layer; let discovery/sync feed it rather than replacing it.

---

## 7. Verification

- **Unit:** semver compare matrix; latest-version fetch (mock `https`: ok / non-2xx / timeout / bad JSON → null; cache hit); poll service sets `updateAvailable` from `(current, latest)`.
- **Manual (real UI):** downgrade a CLI (e.g. `npm i -g @openai/codex@<older>`), launch AIO, confirm pill appears with `old → new`, click → CLI Health, "Run updater", confirm pill clears after refresh. Test offline → no pill, no error toast, no startup delay.
- **Gates:** `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `vitest run` for touched files.

---

## 8. Recommendation / sequencing (re-scoped 2026-05-30)

1. ~~**Phase 1**~~ — **DONE** (shipped 2026-05-29). Detection loop is live.
2. **Phase 3-A** (runtime model-discovery merge into the picker) — the highest-value remaining item, independent, and the same thing as `claude1_todo` #9 (still PARTIAL: `models-dev-service.ts` fetches but isn't wired into the picker UI). Do this next.
3. **Phase 2** (true unattended auto-apply) — the only fully-greenfield piece. Gate behind the `cliUpdatePolicy` opt-in; exclude `brew`/`sudo`; serialize with a per-package lock; don't update mid-session.
4. **Phase 3-B** (build-time models.dev catalog sync) — a refinement over the now-existing `models-dev-service.ts` + `model-pricing.ts`; lowest priority. **Per the deconfliction map, models.dev is owned by this plan** — `claude1_todo` #9 and `claude2_todo` #12 are the same work; don't build it twice.
