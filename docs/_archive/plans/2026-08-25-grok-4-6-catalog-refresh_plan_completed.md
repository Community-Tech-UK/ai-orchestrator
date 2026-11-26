# Grok 4.6 — catalog refresh + real auto-update path for xAI

**Status:** complete — code implemented and verified; live checks deferred to
[2026-08-25-grok-4-6-catalog-refresh_livetest.md](2026-08-25-grok-4-6-catalog-refresh_livetest.md)
**Created:** 2026-08-25
**Trigger:** "Grok 4.6 is out — why didn't AIO get this, and autoupdate?"

## Verified findings (evidence first)

1. **The Grok provider is currently broken, not just stale.**
   `createGrokAdapter` always passes `-m <model>` (`src/main/cli/adapters/adapter-factory.ts:497-500`),
   and every default resolves to `grok-4.5`. The installed CLI rejects it:

   ```
   $ grok -p "…" -m grok-4.5
   Couldn't set model 'grok-4.5': Invalid params: "unknown model id".
   exit=1
   ```

   `grok models` (CLI 1.0.5, authenticated as grok.com) reports exactly one model:
   `grok-4.6 (default)`. xAI retired 4.5 from the CLI.

2. **Grok has no live model discovery.** Codex, Cursor and Copilot each have a
   discovery service that re-reads the installed CLI's model list into the unified
   catalog (`codex-cli-discovery-service.ts`, `cursor-copilot-cli-discovery-service.ts`).
   Grok has none, even though `grok models` exists and exits 0. So
   `PROVIDER_MODEL_LIST.grok` (`src/shared/types/provider.types.ts:545`) — one
   hand-written `grok-4.5` row — is the *only* source of Grok models.

3. **The one auto-update path that does run files xAI under a namespace nothing reads.**
   `ModelsDevService` fetches models.dev every 6h and parses *all* providers, so
   `grok-4.6` (published 2026-08-12, 500k ctx, $2/$6 per 1M) is already being
   downloaded. But `normalizeModelsDevProviderNamespace()`
   (`unified-model-catalog-normalizers.ts:83`) only maps anthropic/google/openai/
   github-copilot, so the entry lands at catalog key `xai:grok-4.6` while the
   picker filters `provider === 'grok'` (`unified-catalog.store.ts:84-86`).
   The model is in the catalog and invisible.

4. **Pricing drops xAI on the floor too.** `normalizePricingProvider()`
   (`model-pricing.ts:233-243`) returns `undefined` for `xai`, so every xAI rate in
   the live overlay is discarded. The static row for `grok-4.5` (2.0/10.0) is also
   wrong — models.dev says 2/6.

5. **The offline snapshot has no xAI at all.** `providerScope: ['anthropic',
   'openai', 'google', 'github-copilot']` in `models-dev-snapshot.generated.ts:136`,
   set by `SUPPORTED_PROVIDERS` in `scripts/sync-model-catalog.ts:50`.

6. **AIO never offers to update the Grok CLI.** `grok` is in `SUPPORTED_CLIS`
   (`cli-registry.ts:18`) but absent from `CLI_UPDATE_SPECS`
   (`cli-update-service.ts:35-60`), so `getUpdatePlan('grok')` returns
   `supported: false` and the update pill skips it. The CLI ships as npm
   `@xai-official/grok` and has its own `grok update` self-updater
   (`grok update --check --json` → `{"currentVersion":"1.0.5","latestVersion":"1.0.5",
   "autoUpdate":true,"installer":"npm"}`), so the binary happened to stay current
   on its own — but AIO has no visibility either way.

## Work items

- [x] WS1 — `provider.types.ts`: `GROK_MODELS.GROK_46`, `DEFAULT_MODELS.grok`,
      `MODEL_PRICING` rows (4.6 at 2/6; correct 4.5 to 2/6 for historical lookups),
      `PROVIDER_MODEL_LIST.grok` → 4.6 only (4.5 is rejected by the CLI, so listing
      it guarantees a failed session).
- [x] WS2 — `settings-defaults.ts` reviewer model, `grok-cli-provider.ts`
      `defaultModel` + fallback + header comment.
- [x] WS3 — map `xai` → `grok` in `normalizeModelsDevProviderNamespace()` and
      `normalizePricingProvider()` so the 6h models.dev sync surfaces and prices
      future xAI models with no code edit.
- [x] WS4 — add `'xai'` to `SUPPORTED_PROVIDERS` in `scripts/sync-model-catalog.ts`
      and regenerate the committed snapshot.
- [x] WS5 — new `grok models` parser + `GrokCliDiscoveryService`, mirroring the
      codex/cursor services, started from `unified-model-catalog-initialization.ts`.
      This is the highest-priority catalog source, so the installed CLI becomes the
      source of truth for Grok.
- [x] WS6 — `CLI_UPDATE_SPECS.grok` = `{ npmPackage: '@xai-official/grok',
      selfUpdateArgs: ['update'] }` so CLI Health polls and can update it.
- [x] WS7 — tests: parser + discovery service specs, namespace-mapping specs,
      updated `adapter-factory-grok.spec.ts`.
- [x] WS8 — canonical verification checklist + fresh-eyes completion gate.

## Risks

- Removing `grok-4.5` from the picker changes any saved instance still pinned to it.
  Those sessions are already failing to spawn, so this is strictly a repair.
- Widening the snapshot scope to `xai` adds ~12 rows (including `grok-imagine-*`);
  entries without finite input/output cost are skipped by the generator.
- `grok models` spawns a CLI at startup and on an interval. Same shape as the
  existing cursor/copilot discovery, fail-soft, 10s timeout.

## As built — what changed beyond the original plan

Four things surfaced during implementation and the completion-gate rounds that the
plan did not anticipate:

1. **Regenerating the snapshot exposed an unstable attribution rule.** The generator
   keyed the snapshot by bare model id and let models.dev's own JSON key order decide
   duplicate winners, so today's regeneration reattributed 23 primary-vendor models
   (including `claude-opus-5`) to `github-copilot`, taking their context/output limits
   with them. `parseSnapshot` was extracted to `scripts/sync-model-catalog.parse.ts`
   (mirroring `generate-cursor-models.versions.ts`) and now iterates
   `SUPPORTED_PROVIDERS` in order, first claim wins, resellers last — with a unit test
   locking that rule.
2. **Retired ids still need a price.** `getProviderModelRate` gates the flat
   `MODEL_PRICING` table on membership of `PROVIDER_MODEL_LIST` (the LT-190 reseller
   guard), so dropping `grok-4.5` from the offer list also dropped its rate — and the
   local-AI-guard budget path accumulates an undefined estimate as `$0`. Added
   `RETIRED_PROVIDER_MODELS`, consulted only by the pricing lookup.
3. **The `xai` → `grok` mapping re-admitted the retired id.** models.dev still publishes
   `xai/grok-4.5`, so the models.dev-only catalog layer handed it back to the `grok`
   bucket and into the snapshot the spawn-time validators trust. That layer now skips
   `RETIRED_PROVIDER_MODELS` ids; CLI-discovered lists and explicit operator overrides
   are deliberately NOT filtered, since those are authoritative and a registry listing
   is not.
4. **Session-create validation does not cover respawn.** Hibernate wake, restart and
   native resume all rebuild spawn options from the persisted `instance.currentModel`
   with no revalidation, so instances stored on `grok-4.5` would have stayed broken.
   `createGrokAdapter` now normalizes at the spawn boundary — but only an *explicitly*
   requested model, so an absent one still omits `-m` and lets the CLI pick its own
   current default rather than pinning whatever id we last hard-coded.

Also: `normalizeModelForProvider` gained a strict `case 'grok'` (the CLI hard-fails on
an unknown id rather than falling back), and `unified-model-catalog-initialization.spec.ts`
now injects a `grokDiscoveryService` mock — without it, three unrelated unit tests spawned
the real `grok models` CLI.

## Verification

- `npx tsc --noEmit` clean; `npm run lint` clean; `npm run build:main` clean.
- `npm run check:ts-max-loc`: `adapter-factory.ts` back under its ceiling (754/756).
  Remaining violations belong to a concurrent session's Copilot-account-routing work.
- Targeted suites (shared types/data, providers, cli, app, instance lifecycle,
  local-ai-guard, sync-model-catalog): 276 files, 3093 tests, all passing.
- `npx tsx scripts/sync-model-catalog.ts --check` reports the committed snapshot is
  current against the live registry.
- Five independent completion-gate rounds; the fifth returned `VERDICT: PASS` with no
  actionable findings. Rounds 1-4 each found a real defect, all fixed here.
