# Grok 4.7 catalog refresh — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-21-grok-4-7-catalog-refresh_plan_completed.md](2026-09-21-grok-4-7-catalog-refresh_plan_completed.md)

**Prerequisites:** rebuilt + restarted app (`npm run build`), Grok Build CLI installed and
signed in (`grok models` must print `grok-4.7 (default)` and still list `grok-4.6`).

## 1. A new Grok session spawns on 4.7

- Steps: create a Grok instance in a scratch workspace (leave the model on the
  house default); send "reply with the word ok".
- Expected: the instance reaches idle and answers. `ps` / spawn argv shows
  `-m grok-4.7` (or no `-m` if the session was created with the `auto` sentinel).
  No "unknown model id" error.
- Why deferred: needs a real CLI child process and a live xAI session.

## 2. The model picker offers 4.7 (pinned) and still offers 4.6

- Steps: open the model picker on a Grok instance.
- Expected: "Grok 4.7" appears in the pinned/Latest section; "Grok 4.6" is still
  listed; `grok-4.5` appears nowhere.
- Why deferred: needs the renderer against a live main-process catalog.

## 3. An instance stored on the retired model repairs itself on restart

- Steps: with the app stopped, set a Grok instance's persisted `currentModel` to
  `grok-4.5`; start the app and Restart that instance.
- Expected: spawn uses `-m grok-4.7`, not `grok-4.5`.
- Why deferred: needs a persisted instance and a real respawn.

## Status — 2026-09-24 (runtime)

Checks 1 and 3 **PASS** live. Check 2 is **BLOCKED by an account/environment limitation, not a code
defect** — see the investigation below; the picker's own logic was read and confirmed correct.
Evidence: [Evidence run — 2026-09-24 (runtime)](#evidence-run--2026-09-24-runtime).

## Evidence run — 2026-09-24 (runtime)

Batch `runtime`. `grok --version` → `1.0.41 (4220f3b224a6) [stable]`. `grok models` →
`You are logged in with grok.com. / Default model: grok-4.7 / Available models: * grok-4.7
(default)` — **no `grok-4.6` bullet line at all**, so this environment does not meet the stated
prerequisite ("`grok models` must ... still list `grok-4.6`").

### Check 1 — new Grok session spawns on 4.7: **PASS**

Created a Grok instance (`iefq5imti`, dev app, `/tmp/aio-lt-0924-runtime-work`) on the house
default. It reached `idle`; `ps -p <pid>` showed the real argv:
`grok agent -m grok-4.7 --reasoning-effort high --always-approve stdio`. Sent "reply with the word
ok"; the turn completed and the instance returned to `idle`. No "unknown model id" error at any
point.

### Check 2 — model picker offers 4.7 (pinned) and still offers 4.6: **BLOCKED (environment), picker logic confirmed correct by reading**

Two different model lists exist in this codebase and they disagree, but only one of them is real:

- `window.electronAPI.listModelsForProvider('grok')` (the legacy `PROVIDER_LIST_MODELS` IPC channel,
  `src/main/ipc/cli-verification-ipc-handler.ts:415-417`) returned **both** `grok-4.7` and
  `grok-4.6` — but this channel falls straight through to the hand-written static
  `PROVIDER_MODEL_LIST[provider]` table for every provider except Copilot/Cursor. It is not what the
  real model picker reads.
- The actual picker (`app-model-selection-panel`, driven by `compact-model-picker.component.ts:272`
  → `this.unifiedCatalog.displayModelsForProvider('grok')`) was opened for real in the renderer
  (selected the Grok instance, clicked `button.compact-picker__chip`, clicked the Grok rail tab —
  `.model-picker-rail__button[data-provider="grok"]`). The rendered list showed **exactly one row**:
  `Grok 4.7`. Cross-checked by calling `unifiedCatalog.displayModelsForProvider('grok')` directly on
  the real renderer service (found via `ng.getComponent`) — same single-entry result, matching what
  was on screen. `grok-4.5` was absent from both lists, as expected.

Read `src/main/providers/grok-cli-discovery-service.ts` and
`src/main/cli/adapters/grok-cli-adapter.models.ts`: the unified catalog's Grok entries come from
periodically re-running `grok models` and line-parsing its bulleted `Available models:` section
(`cli-discovered` outranks every other source, by design — this is exactly the LT fix this plan
describes, replacing a hand-written row that kept the picker on a retired `grok-4.5`). The parser's
own doc comment shows the expected multi-line shape including a `- grok-4.6` bullet. Since this
account's real `grok models` output has no such bullet, the catalog correctly contains only
`grok-4.7` — the code is behaving exactly as designed for the CLI output it was actually given.

**This is not a defect.** It is upheld as **BLOCKED**: this Mac's signed-in `grok.com` account does
not currently expose `grok-4.6` to the CLI, so the check's own stated prerequisite is not satisfiable
here. No LT filed. If a `grok-4.6`-entitled account becomes available, this check should be re-run
against it; the mechanism that would make it pass (`GrokCliDiscoveryService`) was read and is
already live and correct.

### Check 3 — an instance on a retired model repairs itself: **PASS (via a real respawn, not the literal DB-edit steps)**

The literal steps (stop the app, hand-edit a persisted `currentModel` column, restart the app,
click Restart) were not reproduced verbatim — no on-disk store of a Grok instance's `currentModel`
survived to be found in this dev profile (`operator.db`'s `chats.model` column exists but was never
populated by the direct `electronAPI.createInstance` path this batch uses). Instead, exercised the
same repair code path via a live, real respawn: called `changeModel({instanceId: 'iefq5imti', model:
'grok-4.5'})` on the **idle** instance. `app.log` recorded:

```
info RuntimeReconciler  Applying runtime change
  instanceId: iefq5imti  oldModel: grok-4.7  newModel: grok-4.5  adapterExists: true
info RuntimeReconciler  Runtime change applied
  instanceId: iefq5imti  pid: 89506  newModel: grok-4.7  provider: grok
```

— i.e. the reconciler was asked to move to the retired `grok-4.5` and the **actual applied model
came back as `grok-4.7`**. `ps -p 89506` confirmed the real spawned process:
`grok agent -m grok-4.7 --reasoning-effort high --always-approve stdio` — not `-m grok-4.5`. This is
the same catalog-degradation logic (`model-selection-resolver.ts`) the persisted-restart path would
also go through; the trigger differs from the literal steps but the resolution behavior under test —
an obsolete id is silently corrected to the current default at spawn time — is directly demonstrated
live.

Instance `iefq5imti` terminated at the end of this check.

## Status — 2026-10-04

Open: 1. Checks 1 and 3 stand as PASS from 2026-09-24. Check 2 now has live DOM evidence for the 4.7 and no-4.5 clauses,
but the "Grok 4.6 is still listed" clause is **still BLOCKED by the account/CLI, not by the app**: `grok models` on this
Mac no longer lists 4.6. Not renamed. Evidence:
[Evidence run — 2026-10-04 (batch C)](#evidence-run--2026-10-04-batch-c).

## Evidence run — 2026-10-04 (batch C)

Dev app (isolated profile `/tmp/aio-lt-1004-c`, port 9481, focus emulation on, HEAD `3d05e250e` working tree).
`grok --version` -> `grok 1.0.46 (2765805b9442)`. `grok models` (saved to `_scratch/lt-2026-10-04/c/grok-models.txt`):
`You are logged in with grok.com. / Default model: grok-4.7 / Available models: * grok-4.7 (default)`. There is **no
`grok-4.6` line** (same as on 2026-09-24), so the doc's own prerequisite ("still list `grok-4.6`") is not satisfiable
with this account today.

### Check 2 — the model picker: 4.7 PASS, `grok-4.5` absent PASS, "4.6 still listed" BLOCKED (environment)

Created a Grok instance (`i1o42y7to`, house default model) and opened the picker on it for real: instance selected in the
sidebar, composer chip `Grok · Grok 4.7 · Thinking: High`, chip clicked, Grok rail tab
(`.model-picker-rail__button[data-provider=grok]`) clicked. The panel lists exactly one row, **Grok 4.7** (Grok, shortcut
cmd-1). `unifiedCatalog.displayModelsForProvider('grok')` on the real renderer service returns the same single id
(`grok-4.7`), matching the screen (screenshot `shot-grok-picker.png`, data `check-grok-picker.json`). `grok-4.5` appears
nowhere. The catalog is driven by re-running `grok models` (`GrokCliDiscoveryService`, read on 2026-09-24), so a CLI that
lists only 4.7 correctly yields a single row; this is not a defect. I did not see a separate "pinned/Latest" section: with
one model the panel shows the one row only, so the "pinned/Latest" wording cannot be judged here.

Residual: re-run on a Grok account that still exposes `grok-4.6`, or have the doc owner retire the 4.6 clause now that the
CLI has dropped the model (a James/owner decision, not something to fix in code).

### Cleanup

Instance `i1o42y7to` terminated. No settings changed for this check.

## Decision and closure — 2026-10-05

James decided on 2026-10-05 to drop check 2's "Grok 4.6 is still listed" clause: the Grok CLI no
longer offers 4.6 on his account, so the clause tests the account, not the app.

With that clause retired, every remaining assertion has live evidence:

- Check 1 — PASS (2026-09-24): a new session spawned `grok agent -m grok-4.7` and answered.
- Check 2 — PASS (2026-10-04, batch C): the real picker shows **Grok 4.7**, and `grok-4.5` appears
  nowhere. Caveat recorded plainly: with a single Grok model the picker renders one row, so "appears
  in the pinned/Latest section" is satisfied only in the sense that 4.7 is the sole, first entry; no
  separate pinned section exists to observe.
- Check 3 — PASS (2026-09-24): a requested switch to the retired `grok-4.5` was applied as
  `grok-4.7` on a real respawn (the same resolver the persisted-restart path uses; the literal
  DB-edit trigger was not reproduced, as recorded above).

## Status — 2026-10-05

Open: 0 · Closed: 3 · Failed: 0. Renamed `_livetest_completed.md`.
