# Harness Cross-Platform Auto-Update Implementation Plan (Completed)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish signed Harness releases for supported desktop platforms and let packaged clients download them silently, prompt for restart, and install on normal quit.

**Architecture:** Extend the existing main-process `AutoUpdateService`, keep IPC as a thin typed adapter, and add a signal-backed renderer store plus global update banner. A tag-triggered GitHub Actions matrix builds native artifacts and publishes the installers, blockmaps, and update manifests to public GitHub Releases.

**Tech Stack:** Electron 40, electron-updater 6, electron-builder 26, Angular 21 signals, TypeScript 5.9, Vitest, GitHub Actions.

## Global Constraints

- Release provider is the public GitHub repository `Community-Tech-UK/ai-orchestrator`.
- Stable release tags use `vX.Y.Z` and must match `package.json#version`.
- Background checks start after 15 seconds and repeat every four hours without overlap.
- Updates download silently, never restart active work automatically, show **Restart to update** and **Later**, and install on the next normal quit.
- Self-updating targets are macOS arm64/x64 DMG+ZIP, Windows x64 NSIS, and Linux x64/arm64 AppImage.
- Windows portable and Linux DEB remain manual distribution formats.
- No credentials, certificates, tokens, signed URLs, or realistic secret-like values enter source, fixtures, logs, or snapshots.
- Do not commit or push without James's separate explicit permission.

## File Map

- `src/main/updates/auto-update-service.ts`: updater lifecycle, typed status, timers, overlap protection, auto-download, cleanup.
- `src/main/updates/__tests__/auto-update-service.spec.ts`: main-process state-machine and timer coverage.
- `src/main/ipc/handlers/update-handlers.ts`: initialize the service and keep IPC methods thin.
- `src/main/ipc/handlers/update-handlers.spec.ts`: handler wiring and response coverage.
- `src/shared/types/update.types.ts`: renderer-safe update state contract.
- `src/preload/domains/infrastructure.preload.ts`: existing typed bridge, updated to use the shared status type.
- `src/renderer/app/core/state/app-update.store.ts`: signal store over update IPC.
- `src/renderer/app/core/state/app-update.store.spec.ts`: initial load, push events, actions, dismissal, and disposal.
- `src/renderer/app/shared/components/app-update-banner/app-update-banner.component.ts`: global downloaded-update notice.
- `src/renderer/app/shared/components/app-update-banner/app-update-banner.component.spec.ts`: accessible rendering and actions.
- `src/renderer/app/features/settings/app-update-settings.component.ts`: manual status/check/retry surface.
- `src/renderer/app/features/settings/app-update-settings.component.spec.ts`: status and manual-action coverage.
- `src/renderer/app/features/settings/general-settings-tab.component.ts`: mount the update settings card.
- `src/renderer/app/app.component.ts`: initialize and dispose the application-update store.
- `src/renderer/app/app.component.html`: mount the global update banner.
- `src/renderer/app/app.component.spec.ts`: root integration coverage.
- `electron-builder.json`: GitHub provider, supported targets, signing/notarization configuration.
- `package.json`: architecture-aware packaging pre-hook and release validation scripts.
- `scripts/validate-release-tag.js`: reject version/tag drift.
- `scripts/validate-release-assets.js`: reject incomplete or placeholder update artifacts.
- `scripts/__tests__/validate-release-tag.spec.ts`: tag validation coverage.
- `scripts/__tests__/validate-release-assets.spec.ts`: artifact validation coverage.
- `.github/workflows/release.yml`: preflight, native build matrix, signature checks, artifact aggregation, and GitHub Release publication.
- `docs/packaging-native-modules.md`: release/update operational guidance.
- `docs/superpowers/plans/2026-07-11-harness-auto-update-plan_livetest.md`: packaged N-to-N+1 checks that require signed artifacts and real target machines.

---

### Task 1: Main-process updater lifecycle

**Files:**

- Modify: `src/main/updates/auto-update-service.ts`
- Modify: `src/main/updates/__tests__/auto-update-service.spec.ts`
- Create: `src/shared/types/update.types.ts`

**Interfaces:**

- Produces: `UpdateStatus`, `AutoUpdateService.initialize(options)`, `AutoUpdateService.dispose()`, `AutoUpdateService.checkForUpdates()`, `AutoUpdateService.downloadUpdate()`, and `AutoUpdateService.quitAndInstall()`.
- `AutoUpdateInitOptions` adds `startupDelayMs`, `pollIntervalMs`, injected timer functions for tests, and defaults of 15 seconds/four hours.

- [x] **Step 1: Write failing status and lifecycle tests**

Add tests that assert `currentVersion`, `lastCheckedAt`, retryable error state, `autoDownload = true`, `autoInstallOnAppQuit = true`, one delayed startup check, four-hour polling, no concurrent checks, automatic download after `update-available`, and timer cleanup from `dispose()`.

- [x] **Step 2: Run the focused test and confirm the new assertions fail**

Run: `rtk npm run test:quiet -- src/main/updates/__tests__/auto-update-service.spec.ts`

Expected: FAIL because lifecycle scheduling, shared status fields, automatic download, and disposal do not exist yet.

- [x] **Step 3: Move the status contract and implement the minimal lifecycle**

Create a renderer-safe `UpdateState`/`UpdateStatus` contract in `src/shared/types/update.types.ts`. Update the service to set `autoDownload` and `autoInstallOnAppQuit`, schedule checks, guard in-flight checks/downloads, download on availability when configured, record timestamps, preserve retry context, and clear timers/listeners on disposal.

- [x] **Step 4: Run the focused test until it passes**

Run: `rtk npm run test:quiet -- src/main/updates/__tests__/auto-update-service.spec.ts`

Expected: PASS with timer assertions using fake timers; no network or Electron runtime required.

### Task 2: IPC lifecycle adapter

**Files:**

- Modify: `src/main/ipc/handlers/update-handlers.ts`
- Create: `src/main/ipc/handlers/update-handlers.spec.ts`
- Modify: `src/preload/domains/infrastructure.preload.ts`

**Interfaces:**

- Consumes: Task 1 `AutoUpdateService` and `UpdateStatus`.
- Produces: typed `update:check`, `update:download`, `update:install`, `update:get-status`, and `update:status-changed` behaviour.

- [x] **Step 1: Write failing handler tests**

Mock Electron, the updater singleton, and `WindowManager`; assert packaged initialization enables auto-download, status changes broadcast once, all handlers return typed success data, and registration cleanup disposes the service/listener.

- [x] **Step 2: Run the focused test and confirm failure**

Run: `rtk npm run test:quiet -- src/main/ipc/handlers/update-handlers.spec.ts`

Expected: FAIL because initialization still sets `autoDownload: false` and cleanup is not exposed.

- [x] **Step 3: Implement the thin lifecycle adapter**

Initialize with `enabled: app.isPackaged`, `autoDownload: true`, and the production timing defaults. Return a cleanup function that removes the status listener and disposes timers. Type preload callbacks and status responses with `UpdateStatus` without importing Electron-only modules into the renderer.

- [x] **Step 4: Run handler and preload checks**

Run: `rtk npm run test:quiet -- src/main/ipc/handlers/update-handlers.spec.ts`

Run: `rtk npx tsc --noEmit -p tsconfig.electron.json`

Expected: both PASS.

### Task 3: Renderer store and global restart banner

**Files:**

- Create: `src/renderer/app/core/state/app-update.store.ts`
- Create: `src/renderer/app/core/state/app-update.store.spec.ts`
- Create: `src/renderer/app/shared/components/app-update-banner/app-update-banner.component.ts`
- Create: `src/renderer/app/shared/components/app-update-banner/app-update-banner.component.spec.ts`
- Modify: `src/renderer/app/app.component.ts`
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.spec.ts`

**Interfaces:**

- Consumes: preload methods `updateGetStatus`, `updateCheck`, `updateDownload`, `updateInstall`, and `onUpdateStatusChanged`.
- Produces: `AppUpdateStore.status`, `visible`, `loading`, `error`, `init()`, `dispose()`, `check()`, `retryDownload()`, `restartAndInstall()`, and `dismissForSession()`.

- [x] **Step 1: Write failing store tests**

Cover idempotent initialization, initial status load, pushed state, failed IPC calls, manual check, download retry, install, session dismissal reset when a different version downloads, and listener disposal.

- [x] **Step 2: Run the store test and confirm failure**

Run: `rtk npm run test:quiet -- src/renderer/app/core/state/app-update.store.spec.ts`

Expected: FAIL because `AppUpdateStore` does not exist.

- [x] **Step 3: Implement the signal store**

Follow `CliUpdatePillStore` conventions: inject `ElectronIpcService`, use readonly signals, make `init()` idempotent, validate IPC success before updating state, retain user-action errors, and remove subscriptions in `dispose()`.

- [x] **Step 4: Write failing banner and root-integration tests**

Assert the banner only appears for `downloaded`, includes the version, uses `role="status"` and `aria-live="polite"`, labels both buttons, routes actions to the store, and is mounted once by `AppComponent`.

- [x] **Step 5: Implement the standalone banner and root wiring**

Use repository design tokens, `OnPush`, `inject()`, and signals. Initialize the store during root startup, mount the banner above the main workspace, and dispose it during root teardown.

- [x] **Step 6: Run renderer focused tests**

Run: `rtk npm run test:quiet -- src/renderer/app/core/state/app-update.store.spec.ts src/renderer/app/shared/components/app-update-banner/app-update-banner.component.spec.ts src/renderer/app/app.component.spec.ts`

Expected: PASS.

### Task 4: Manual update settings surface

**Files:**

- Create: `src/renderer/app/features/settings/app-update-settings.component.ts`
- Create: `src/renderer/app/features/settings/app-update-settings.component.spec.ts`
- Modify: `src/renderer/app/features/settings/general-settings-tab.component.ts`

**Interfaces:**

- Consumes: Task 3 `AppUpdateStore`.
- Produces: General settings card showing current/available version, last check, state, errors, and manual check/retry/restart actions.

- [x] **Step 1: Write failing component tests**

Cover disabled/browser state, idle/checking/available/downloading/downloaded/error labels, progress, manual check, retry download, and restart actions with accessible button labels.

- [x] **Step 2: Run the component test and confirm failure**

Run: `rtk npm run test:quiet -- src/renderer/app/features/settings/app-update-settings.component.spec.ts`

Expected: FAIL because the component does not exist.

- [x] **Step 3: Implement and mount the settings card**

Create a standalone `OnPush` component using the existing settings-card visual language and add it below the generated general settings list. Do not add a new navigation section for one card.

- [x] **Step 4: Run focused settings tests**

Run: `rtk npm run test:quiet -- src/renderer/app/features/settings/app-update-settings.component.spec.ts src/renderer/app/features/settings/settings.component.spec.ts`

Expected: PASS.

### Task 5: Cross-platform builder configuration and release guards

**Files:**

- Modify: `electron-builder.json`
- Modify: `package.json`
- Create: `scripts/validate-release-tag.js`
- Create: `scripts/validate-release-assets.js`
- Create: `scripts/__tests__/validate-release-tag.spec.ts`
- Create: `scripts/__tests__/validate-release-assets.spec.ts`

**Interfaces:**

- Produces: `npm run release:validate-tag -- <tag>` and `npm run release:validate-assets -- <directory>`.

- [x] **Step 1: Write failing release-validation tests**

Test exact stable tags, version mismatch, prerelease rejection, malformed tags, missing manifests, placeholder feed strings, missing macOS ZIP, missing blockmaps, and incomplete target sets.

- [x] **Step 2: Run the focused tests and confirm failure**

Run: `rtk npm run test:quiet -- scripts/__tests__/validate-release-tag.spec.ts scripts/__tests__/validate-release-assets.spec.ts`

Expected: FAIL because the validators do not exist.

- [x] **Step 3: Implement pure validators and CLI wrappers**

Export pure functions for Vitest and keep CLI output limited to filenames, versions, and validation reasons. Never print environment values.

- [x] **Step 4: Correct electron-builder targets and provider**

Replace the placeholder generic feed with the GitHub provider owner/repository. Configure macOS DMG+ZIP for arm64/x64 with notarization enabled, Windows NSIS x64 as the update target, Linux AppImage x64/arm64, and artifact names that cannot collide when matrix artifacts are combined. Make the packaging pre-hook take the requested architecture instead of hardcoding arm64.

- [x] **Step 5: Run configuration tests and unsigned packaging smoke**

Run: `rtk npm run test:quiet -- scripts/__tests__/validate-release-tag.spec.ts scripts/__tests__/validate-release-assets.spec.ts`

Run on the current macOS host: `rtk npm run electron:build -- --mac --dir --config electron-builder.json --config.mac.identity=null`

Expected: tests PASS; unsigned unpacked macOS application builds for the host architecture without a placeholder update feed.

### Task 6: Tag-triggered GitHub release workflow

**Files:**

- Create: `.github/workflows/release.yml`
- Modify: `docs/packaging-native-modules.md`

**Interfaces:**

- Consumes: Task 5 validators and builder configuration.
- Produces: one immutable public GitHub Release per `vX.Y.Z` tag.

- [x] **Step 1: Add a release workflow with least privilege**

Use a preflight job for tag/version validation and canonical checks; native matrix jobs for macOS arm64/x64, Windows x64, Linux x64/arm64; artifact upload/download; signature/platform verification; manifest validation; and a final publish job whose only elevated permission is `contents: write`.

- [x] **Step 2: Make signing a hard publication requirement**

macOS jobs require the documented electron-builder Apple signing/notarization environment and run `codesign --verify --deep --strict` plus `spctl --assess`. Windows runs signature verification after Authenticode signing. Publication must not fall back to unsigned artifacts when required secrets are absent.

- [x] **Step 3: Document operator setup without secret values**

Document GitHub secret names, Apple Developer ID/notarization prerequisites, Windows certificate prerequisites, tag/version workflow, artifact expectations, rollback via a higher patch version, and local unsigned smoke commands.

- [x] **Step 4: Validate workflow syntax and repository integration**

Run: `rtk npx prettier --check .github/workflows/release.yml electron-builder.json package.json`

Run: `rtk npm run release:validate-tag -- v$(node -p "require('./package.json').version")`

Expected: formatting check PASS and tag validator reports matching stable version.

### Task 7: Full verification and deferred packaged update matrix

**Files:**

- Create: `docs/superpowers/plans/2026-07-11-harness-auto-update-plan_livetest.md`
- Rename after all agent-runnable gates pass: `docs/superpowers/plans/2026-07-11-harness-auto-update-plan.md` to `docs/superpowers/plans/2026-07-11-harness-auto-update-plan_completed.md`

- [x] **Step 1: Run all targeted tests from Tasks 1–6**

Expected: PASS with no skipped updater, renderer, validator, or handler tests.

- [x] **Step 2: Run canonical project gates**

Final isolated-worktree evidence: all three TypeScript checks, lint, and the
TypeScript file-size ratchet pass; the production build passes; 1,288 test files
and 12,824 tests pass with no failures or skips; and an unsigned macOS arm64
package builds successfully in an isolated scratch output directory.

Run:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

Expected: all commands exit 0.

- [x] **Step 3: Record signed N-to-N+1 checks in the livetest document**

List exact prerequisites, commands/UI actions, expected version transitions, data-preservation checks, and signature checks for macOS arm64/x64, Windows x64, and Linux x64/arm64. Explain that they require signing credentials, published test-channel artifacts, and target machines/runners.

- [x] **Step 4: Complete plan bookkeeping**

Move only the genuinely external signed-update matrix into the livetest document, link it from the implementation plan, and rename the implementation plan `_completed` only after all code, tests, lint, typecheck, packaging smoke, and workflow validation pass.

The remaining signed N-to-N+1 checks are recorded in
`2026-07-11-harness-auto-update-plan_livetest.md`.
