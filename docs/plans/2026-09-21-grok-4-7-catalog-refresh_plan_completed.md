# Grok 4.7 — catalog refresh

**Status:** complete — code implemented and verified; live checks deferred to
[2026-09-21-grok-4-7-catalog-refresh_livetest.md](2026-09-21-grok-4-7-catalog-refresh_livetest.md)
**Created:** 2026-09-21
**Trigger:** "Grok 4.7 is out, can you make sure manifests and shit are up to date"

## Verified findings

1. Official xAI docs list `grok-4.7` as the recommended coding/chat model, same
   $2 / $6 per 1M tokens (under 200k prompt) as `grok-4.6`, 500k context,
   knowledge cutoff May 2026.
2. Installed Grok Build CLI `1.0.40` reports:

   ```
   Default model: grok-4.7
   Available models:
     * grok-4.7 (default)
     - grok-4.6
   ```

   4.6 is still accepted. 4.5 stays retired (`unknown model id`).
3. Offline fallbacks previously pinned `grok-4.6`: `GROK_MODELS`,
   `DEFAULT_MODELS.grok`, `PROVIDER_MODEL_LIST.grok`, reviewer/loop defaults,
   `GrokCliProvider`. Live `GrokCliDiscoveryService` would surface 4.7 once the
   CLI is current, but a missing/signed-out CLI still offered only 4.6.

## Work items

- [x] WS1 — `provider.types.ts`: add `GROK_47`, default + pricing (2/6), picker
      list `4.7` (pinned primary) then `4.6` (still offered). 4.5 stays retired.
- [x] WS2 — reviewer + loop defaults, `grok-cli-provider` default/fallback.
- [x] WS3 — regenerate models.dev snapshot if the live registry has `grok-4.7`.
- [x] WS4 — lock the live `grok models` 1.0.40 shape in the parser spec; update
      tests that assert the *current* default (not historical fixtures).
- [x] WS5 — targeted + canonical verification.

Out of scope: Copilot enterprise-seat checker roster (those ids are
seat-verified; 4.7 is not confirmed on that seat). Historical ACP / entitlement
fixtures that mention `grok-4.6` stay as recorded evidence.

## As built

- `GROK_MODELS.GROK_47 = 'grok-4.7'` is the house default (`DEFAULT_MODELS.grok`,
  `DEFAULT_REVIEWER_MODEL_BY_PROVIDER.grok`, `DEFAULT_LOOP_MODEL_BY_PROVIDER.grok`,
  `GrokCliProvider.defaultModel`). Pricing is $2 / $6, same as 4.6.
- Offline picker: pinned `Grok 4.7`, then unpinned `Grok 4.6`. 4.5 remains in
  `RETIRED_PROVIDER_MODELS` only.
- `npm run sync:model-catalog` added `grok-4.7` to the models.dev snapshot
  (500k ctx, $2/$6). Snapshot grew 108 → 109 models; no unrelated churn.
- Parser spec now locks the live 1.0.40 `* grok-4.7 (default)` / `- grok-4.6`
  output. Catalog-only trust coverage moved from `grok-4.7` to `grok-4.8`.
- Retired-id spawn repair now lands on `grok-4.7`.

## Verification

- Targeted: 7 files, 168 tests passed.
- `npx tsc --noEmit` clean; lint clean; `build:main` and `build:renderer` clean.
- `npm run test:quiet`: 2167 files, 25761 tests passed.
- `check:ts-max-loc` still fails on unrelated dirty-tree
  `input-panel.component.ts` (not in this diff).
- Independent completion gate: `VERDICT: PASS`, no findings.
