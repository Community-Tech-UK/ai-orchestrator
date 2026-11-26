# Automation model default via favourites — live tests

**Date:** 2026-07-24
**Plan:** [2026-07-24-automation-favourite-model-default_plan_completed.md](./2026-07-24-automation-favourite-model-default_plan_completed.md)
**Prerequisites:** a fresh `npm run build` + restart of the AI Orchestrator
Electron app (the renderer favourites mirror and the automations model-pinned
Auto/Pinned split + preview only exist after a rebuild). Run against the primary
dev instance.

Every code, unit/integration test, typecheck, lint, and LOC gate already passed
in-loop. The checks below are deferred **only** because they exercise the real
renderer↔main IPC round-trip, the running picker UI, and a real automation fire
— none reproducible without the rebuilt app.

## 1. Favourite mirror writes the setting (Phase 3)

1. Open the model picker's ★ (Favorites) tab.
2. Toggle a star on/off for any model.
3. Run `get_setting modelPickerFavorites` (MCP / `$AIO_MCP settings get`).

**Expected:** the setting returns the ordered `provider:modelId` list matching
the picker's ★ list (the toggled model added/removed, order preserved).

## 2. One-time localStorage → setting migration (Phase 3)

1. On a profile that has a saved `compact-model-picker:favorites:v1`
   localStorage list but an empty `modelPickerFavorites` setting (i.e. upgraded
   from before this change), launch the app.
2. Without opening the picker, run `get_setting modelPickerFavorites`.

**Expected:** the setting is populated once from the localStorage list at boot
(the service is eager-injected in `app.component.ts`). A fresh/uncustomised
profile (no saved list) stays `[]` — `DEFAULT_FAVORITE_MODEL_KEYS` is never
copied.

## 3. Empty-model automation shows honestly as Auto (Phase 4)

1. Ensure an automation exists (or create one) with a concrete provider
   (e.g. `claude`) and **no** pinned model — e.g. via
   `update_automation` clearing the model.
2. Open the automation in the edit form.

**Expected:** the Model control shows **Auto** as active (not Pinned) even though
the provider is concrete, with the truthful hint naming the favourite — never a
phantom pinned "Opus latest, 1M". Clicking **Pinned** seeds a concrete model
(`pinModelSelection()`), keeping the concrete provider. Saving without touching
the Model control preserves `provider: claude` with no model (does not flip the
provider to `auto`).

## 4. Auto-mode preview is truthful and reactive (Phase 4)

1. Save favourites so a Claude model is first (Section 1).
2. Open an automation with `provider: auto` (or a concrete provider) and no
   pinned model; keep it in **Auto** mode.
3. Read the hint under the Model control.
4. Reorder favourites to put a different Claude model first, reopen the form.

**Expected:** the hint reads `Auto · currently <model name> (favourite)` (or
`(provider default)` / `(automation default)` / `(pinned)` as appropriate), and
after reordering it names the new top favourite — with no automation edit/save.

## 5. Auto automation fires on the favourite (Phase 2, end-to-end)

1. Set favourites so `claude:<some model>` is the first Claude entry.
2. Create/keep an automation with `provider: claude`, no model, a near-future
   schedule (or fire manually).
3. When it fires, inspect the spawned instance's model.

**Expected:** the instance spawns on the favourite Claude model (not the
picker-clobbered `defaultModelByProvider.claude`). Reordering favourites before
the next fire redirects it with no automation edit.

---

## Results — 2026-07-25, all 5 sections PASS

Run against the dev app (`harness-dev` profile) with main rebuilt from the current tree; driven
through the real renderer (`window.ng` component handles + real DOM clicks) and the app's own
settings IPC, so every read is the dev profile's own state rather than prod's.

**1. Favourite mirror writes the setting — PASS.** Opened the picker's ★ Favorites tab on the
automations page (5 star buttons rendered) and clicked a star whose `aria-pressed` was `false`.
It flipped to `true` and the setting went
`["claude:opus","claude:sonnet","codex:gpt-5.5"]` → `["claude:opus","claude:sonnet","codex:gpt-5.6-sol","codex:gpt-5.5"]`.
Clicking the same star again removed exactly that entry and restored the original list, order
preserved.

**2. One-time localStorage → setting migration — PASS, both halves.**
- *Uncustomised profile*: setting `[]` with `compact-model-picker:favorites:v1` absent stayed `[]`
  across a boot — `DEFAULT_FAVORITE_MODEL_KEYS` was never copied.
- *Upgraded profile*: wrote `["claude:sonnet","claude:opus","codex:gpt-5.5"]` to that localStorage
  key, left the setting `[]`, reloaded, and read the setting **without opening the picker** — it
  came back populated with exactly that list.

**3. Empty-model automation shows honestly as Auto — PASS.** Fixture automation with
`action.provider: "claude"` and no model. In the edit form: `isModelPinned() === false`, and in the
DOM the **Auto** button carries `is-active` while **Pinned** does not — no phantom pinned
"Opus latest, 1M". `resolvedModelPreview()` = `{label: "Sonnet latest", source: "favourite"}`,
matching the then-top Claude favourite. Clicking **Pinned** seeded a concrete model
(`{provider: "claude", model: "opus[1m]"}`, preview `{label: "Opus latest, 1M", source: "pinned"}`)
and kept the concrete provider; returning to **Auto** cleared the model to `null`. Saving without
touching the Model control left the stored action at `{provider: "claude", model: null}` — the
provider did **not** flip to `auto`.

**4. Auto-mode preview is truthful and reactive — PASS.** With favourites
`["claude:sonnet", …]` the hint read `Sonnet latest (favourite)`; rewriting favourites to
`["claude:opus", …]` flipped it live to `Opus latest (favourite)` with **no automation edit or
save**, and `modelPickerSelection` stayed `{provider: "claude", model: null}` throughout.

**5. Auto automation fires on the favourite — PASS, with a discriminating control.**
`defaultModelByProvider.claude` was deliberately set to `sonnet` while the top Claude favourite was
`claude:opus`, so the two sources disagree. Firing the automation spawned
`InstanceLifecycle | Creating instance | {"modelOverride": "opus", "provider": "claude", …}` — the
favourite, not the picker-clobbered default. Then, reordering favourites to put `claude:haiku`
first and firing again produced `{"modelOverride": "haiku"}`, while the automation record itself
stayed `{provider: "claude", model: null}` — redirected with no automation edit.

Fixture automation deleted, spawned instances terminated, and `modelPickerFavorites` /
`defaultModelByProvider` / the localStorage key restored to their pre-test state.
