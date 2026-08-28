# Grok 4.6 catalog refresh — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-08-25-grok-4-6-catalog-refresh_plan_completed.md](2026-08-25-grok-4-6-catalog-refresh_plan_completed.md)

**Prerequisites:** rebuilt + restarted app (`npm run build`), Grok Build CLI installed and
signed in (`grok models` must print `grok-4.6 (default)`). These checks spawn a real `grok`
child process and read the real unified catalog, so they cannot run against the
wasm-mocked test suite.

## 1. A new Grok session spawns and reaches idle

- Steps: create a Grok instance in a scratch workspace; send "reply with the word ok".
- Expected: the instance reaches idle and answers. `ps aux | grep 'grok agent'` shows
  `-m grok-4.6` (or no `-m` if the session was created with the `auto` sentinel). No
  "unknown model id" error.
- Why deferred: needs a real CLI child process and a live xAI session.

## 2. The model picker offers 4.6 and no longer offers 4.5

- Steps: open the model picker on a Grok instance.
- Expected: "Grok 4.6" appears in the pinned/Latest section; `grok-4.5` appears nowhere.
  Any additional model the installed CLI reports is listed too (CLI discovery outranks
  the static list).
- Why deferred: needs the renderer against a live main-process catalog.

## 3. An instance stored on the retired model repairs itself on restart

- Steps: with the app stopped, set a Grok instance's persisted `currentModel` to
  `grok-4.5` (or use one created before this change); start the app and Restart that
  instance.
- Expected: it spawns successfully — `ps aux` shows `-m grok-4.6`. This exercises the
  spawn-boundary normalization in `createGrokAdapter`, which the unit tests cover only
  at the factory level.
- Why deferred: needs persisted instance state plus a real restart.

## 4. Hibernate → wake on a Grok instance

- Steps: let a Grok instance hibernate (or force it), then send it a message to wake it.
- Expected: it wakes and answers; the spawn uses an accepted model id.
- Why deferred: needs the real hibernation lifecycle.

## 5. CLI Health offers a Grok update

- Steps: open Doctor / CLI Health with `grok` installed.
- Expected: Grok Build appears with a real update plan (`grok update`) instead of
  "No automatic updater is configured". If npm has a newer `@xai-official/grok` than
  the installed version, the update pill offers it.
- Why deferred: needs the live Doctor surface and the npm registry.

## 6. models.dev sync surfaces a future xAI model with no code edit

- Steps: after the app has been running long enough for the models.dev refresh (or force
  one), inspect the unified catalog for provider `grok`.
- Expected: entries sourced from `models-dev` for xAI ids appear under provider `grok`,
  not `xai`, and carry pricing. `grok-4.5` must NOT appear despite models.dev still
  publishing it.
- Why deferred: needs a live models.dev fetch in the running app.

## Evidence run — 2026-08-25

Batch agent A. Dev app launched with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-A`,
`--remote-debugging-port=9451`, driven over CDP (harness with focus/visibility emulation
enabled). Prerequisites reconfirmed: `grok 1.0.5 (5115b46bc909) [stable]` on PATH,
`grok models` prints "Default model: grok-4.6" with `grok-4.6 (default)` as the only
model. `npm run build:main` was clean as of 17:06 the same day, so the dev app's main
process carried current source.

**Check 1 — PASS.** Created a Grok instance (`icui12o2x`) in `/tmp/aio-lt-A-workspace-grok`
via `createInstance({provider:'grok', ...})`. It reached `idle` on its own before any
message. `ps -eo pid,ppid,command | grep grok` confirmed the argv:
`grok agent -m grok-4.6 --reasoning-effort high --always-approve stdio`. Sent
`sendInput({instanceId, message:'reply with the word ok'})`; the instance went
busy→idle and `outputBuffer` shows the assistant reply `"ok"`, `errorCount: 0`. No
"unknown model id" text anywhere in the output.

**Check 2 — PASS.** Read `window.electronAPI.getUnifiedModelCatalog()` — provider `grok`
has exactly one entry, `{id:"grok-4.6", name:"Grok 4.6", pricing:{input:2,output:6},
pricingSource:"models-dev", source:"cli-discovered"}`; no `grok-4.5` entry anywhere in
the catalog. Then drove the **real rendered DOM**: this dev profile is fresh, so first
had to clear two first-run gates that are dev-profile artefacts, not part of the check —
`localStorage.setItem('aiorch.setup.completed','1')` (first-run wizard) and
`InstanceStore` role selection via `settingsStore.set('workerMode', {role:'coordinator'})`
(worker/coordinator role-choice screen) — both are one-time onboarding screens a real
user's profile has already cleared. With those cleared, selected the Grok instance
(`InstanceStore.setSelectedInstance('icui12o2x')`), clicked the real
`.compact-picker__chip` button (`chip.click()`), which showed
`"Grok · Grok 4.6 · High"` and opened `<app-model-selection-panel>`. Clicked the
`aria-label="Grok"` rail tab; the panel's rendered rows were exactly `["Grok 4.6Grok"]` —
`panel.textContent` contains `"Grok 4.6"` and does **not** contain `"Grok 4.5"` or
`"grok-4.5"` anywhere. This is genuine rendered DOM (focus/visibility emulation was
active for the whole session, confirmed by the picker's own aria-expanded flip and
content update with no forced change detection).

**Check 3 — PASS**, via the app's real persistence/restore path (not a literal in-place
"Restart" button — see note). Created a second instance (`ie0n6z483`), sent
"reply with the word ready", confirmed idle with a real assistant reply in
`outputBuffer`. Gracefully quit the dev app over CDP (`Browser.close`, which drives
Electron's real `before-quit` → `cleanupSync()` → `cleanup()` → `terminateAll()` path —
confirmed via `/tmp/aio-lt-A/logs/shutdown.ndjson`, a full
`before-quit→cleanup-finished→will-quit→quit` sequence, and
`/tmp/aio-lt-A/logs/lifecycle.ndjson` showing `ie0n6z483` transition `idle→terminated`).
On graceful quit the instance was archived (this only happens for a session with
real message content — a first attempt with an empty session confirmed instances are
**not** archived if `messageCount` is 0, so a full app-stop/restart round-trip with no
message never re-offers a "Restart" affordance; that's expected behaviour and not a
defect). With the app fully stopped (`curl` to the debug port refused), edited the
persisted model id to the retired `grok-4.5` in **both** places that hold it:
`/tmp/aio-lt-A/session-continuity/states/ie0n6z483.json` (`modelId`) and
`/tmp/aio-lt-A/conversation-history/index.json` (`currentModel` on the archived entry).
Restarted the dev app on the same profile/port. Called
`electronAPI.restoreHistory(entryId, workingDirectory)` — the only affordance that turns
an archived (terminated) conversation back into a live instance after a real app
restart, since live instances do not survive process exit by design (they are archived,
not kept warm). It returned `restoreMode: "native-resume"` and a new instance id
`i863h5onj`. `ps` immediately after showed
`grok agent -m grok-4.6 --reasoning-effort high stdio` — **not** `-m grok-4.5` — and
`listInstances` reported `status: "idle", currentModel: "grok-4.6"`. This is the
spawn-boundary normalization in `createGrokAdapter`
(`src/main/cli/adapters/adapter-factory.ts:531-536`, `normalizeModelForProvider('grok',
options.model)`) firing on exactly the "app was stopped with a retired model persisted,
then brought back" scenario the check describes; the code path is shared with an
in-session `restartInstance`/wake, which check 1/4 already exercised with a valid model.
*Deviation from the literal check text:* the doc says "Restart that instance" assuming
it is still present in the instance list after an app restart; in this build, instances
are archived on quit and the equivalent action is History → Restore. Recorded here for
anyone re-running this check rather than filed as a defect — restarting from history is
that instance's `restore = 'native-resume'`, the correct in-app path to bring back a
persisted session.

**Check 4 — PASS.** On `icui12o2x` (still idle from check 1), called
`electronAPI.hibernateInstance({instanceId})`; `listInstances` reported
`status: "hibernated"`, and `ps` confirmed the CLI child process was gone. Sent
`sendInput({instanceId, message:'reply with the word pong'})`, which woke it:
`ps` showed a **new** grok process, `-m grok-4.6 --reasoning-effort high --always-approve
stdio`; `listInstances` returned `status: "idle"`, `outputTail` shows the exchange ending
in assistant `"pong"`, `errorCount: 0`.

**Check 5 — PASS.** Called `window.electronAPI.diagnosticsGetDoctorReport()` (the live
Doctor/CLI-Health IPC) and `cliUpdatePillGetState()`. `cliHealth.installs` contains a
`grok` entry: `installed: true, activeVersion: "1.0.5", updatePlan: {supported: true,
command: "/Users/suas/.nvm/versions/node/v24.15.0/bin/grok", args: ["update"],
displayCommand: "grok update", strategy: "self-update"}` — a real update plan, not "No
automatic updater is configured". The pill's `grok` entry shows
`currentVersion/latestVersion: "1.0.5"`, `updateAvailable: false` (correctly up to date;
this run's installed CLI happens to match the latest, so it did not additionally exercise
the "npm has a newer version" branch of the check's expectation).

**Check 6 — PASS.** From the same `getUnifiedModelCatalog()` read used for check 2:
provider `grok` carries exactly `grok-4.6` with `pricingSource: "models-dev"`,
`inputPerMillion: 2`, `outputPerMillion: 6`; there is no `xai`-keyed entry at all
(`xaiCount: 0`). Traced all three wirings the task asked to confirm are actually on the
path, not merely present in source:
  1. **CLI discovery** — `catalog.status.cliDiscoveryLastRefreshedAt.grok` is a real
     recent timestamp and the `grok-4.6` entry's `source` is `"cli-discovered"`,
     confirming `GrokCliDiscoveryService` genuinely ran and won priority over the
     models.dev-only layer.
  2. **models.dev namespace map, both catalog and pricing** —
     `normalizeModelsDevProviderNamespace()` (`src/main/providers/unified-model-catalog-normalizers.ts:97-98`)
     maps `case 'xai': return 'grok'`, and `normalizePricingProvider()`
     (`src/shared/data/model-pricing.ts:251`) does the same for the live pricing overlay.
     Both are called from the live catalog-build path
     (`src/main/providers/unified-model-catalog-service.ts:409-431`), which also
     confirms the retirement guard: `RETIRED_PROVIDER_MODELS.grok = ['grok-4.5']`
     (`src/shared/types/provider.types.ts:319-321`) is consulted at that exact call site
     before a models.dev-only entry is admitted — this is why `grok-4.5` (still published
     upstream, confirmed present in `models-dev-snapshot.generated.ts:134` with correct
     2/6 pricing) never reaches the live catalog even though the namespace map would
     otherwise re-admit it.
  3. **`CLI_UPDATE_SPECS`** — confirmed live via check 5's Doctor report above
     (`grok` has a real `self-update` plan, not `supported: false`).

### Cleanup

Terminated every instance created (`icui12o2x` was superseded by the app restart and
never survived it; `i863h5onj`, the restored instance, was explicitly terminated via
`electronAPI.terminateInstance`). No automations were created. No global/production
settings were touched — all edits (localStorage first-run flag, `workerMode.role`,
session-continuity/history JSON edits) were local to the throwaway
`/tmp/aio-lt-A` dev profile, which was deleted after this run. Dev app on port 9451 was
stopped. No source files were modified.

### Result

All 6 checks PASS with current, directly-executed evidence (real CLI spawns, real
rendered DOM, a real app-stop/edit/restart round trip, real hibernate/wake, and the live
Doctor/catalog IPCs). No defects reproduced; nothing filed to the remediation register.
