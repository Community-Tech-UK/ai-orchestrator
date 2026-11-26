# Computer Use Permission Onboarding Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with test-first red/green cycles. Do not commit or push without James's explicit authorization.

**Goal:** When local macOS Computer Use is enabled, show accurate Screen Recording and Accessibility readiness at the top of Harness and let James request/register each permission and open the correct System Settings pane from one shared flow.

**Architecture:** Electron owns Screen Recording status and registration because `desktopCapturer` performs capture. The bundled Swift helper owns Accessibility status and prompting because it performs AX inspection and synthesized input. A trusted renderer-only IPC operation coordinates the native request, exact-pane navigation, root-pane fallback, and a typed result. A root Angular signal store activates only while Computer Use is enabled and drives option C: a dismissible banner that collapses into a title-bar chip.

**Tech Stack:** Electron 40, Angular 21 signals and standalone OnPush components, TypeScript, Swift/ApplicationServices, Zod 4, Vitest.

**Approved design:** `docs/superpowers/specs/2026-07-11-computer-use-permission-onboarding-design.md`

## Global Constraints

- Never request Screen Recording or Accessibility merely because Harness starts.
- Do not request or open macOS permission settings while `computerUseEnabled` is false.
- Keep permission actions operator-only. Do not add them to the agent-facing Computer Use MCP tools.
- Accept only the closed permission enum; never accept a renderer-supplied URL.
- Do not return screen-source metadata or thumbnails to the renderer.
- Preserve all unrelated working-tree changes and do not commit or push.
- Treat pane-specific `x-apple.systempreferences:` links as best effort and report navigation failure truthfully.
- Do not claim the macOS ownership model is correct until a signed packaged build has been checked with clean TCC state.

---

### Task 1: Define the typed permission seam

**Files:**
- Modify: `src/shared/types/desktop-gateway.types.ts`
- Modify: `src/main/desktop-gateway/platform/desktop-driver.ts`
- Test: `src/main/desktop-gateway/platform/darwin-driver.spec.ts`

**Interfaces:**
- Add: `DesktopSystemPermission = 'screen-recording' | 'accessibility'`
- Add: `DesktopPermissionRequestResult` containing the permission, post-request capability state, and `nativeRequestAttempted`
- Add: `DesktopPermissionActionResult` extending the request result with `settingsOpened`
- Add: `DesktopDriver.requestSystemPermission(permission)`

- [x] Write a failing driver-interface test covering both accepted permission values and the unsupported-platform result.
- [x] Run `npm run test:quiet -- src/main/desktop-gateway/platform/darwin-driver.spec.ts` and confirm failure is caused by the absent permission seam.
- [x] Add the shared enum/result types and the driver method.
- [x] Implement `UnsupportedDesktopDriver.requestSystemPermission()` as a typed unsupported result with no native or URL side effect.
- [x] Re-run the targeted spec and confirm it passes.

### Task 2: Add an explicit Accessibility prompt command to the bundled helper

**Files:**
- Modify: `resources/desktop-helper/DesktopHelper.swift`
- Modify: `src/main/desktop-gateway/platform/desktop-helper-protocol.ts`
- Modify: `src/main/desktop-gateway/platform/darwin-helper-client.ts`
- Test: `src/main/desktop-gateway/platform/darwin-helper-client.spec.ts`
- Test: `scripts/__tests__/build-desktop-helper.spec.ts`

**Interfaces:**
- Add helper command: `requestAccessibility`
- Add client method: `requestAccessibility(): Promise<boolean>`
- Bump `DESKTOP_HELPER_PROTOCOL_VERSION` and the Swift `protocolVersion` together because the command contract changed.

- [x] Add a failing protocol/client test proving `requestAccessibility` serializes an empty payload and returns the helper's current trust state.
- [x] Add failing cases for malformed results, missing helper, and helper protocol mismatch.
- [x] Run `npm run test:quiet -- src/main/desktop-gateway/platform/darwin-helper-client.spec.ts scripts/__tests__/build-desktop-helper.spec.ts` and confirm the new assertions fail for the missing command.
- [x] In Swift, require an empty payload, call `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt: true`, and return the current boolean trust state. Do not treat `false` as an execution error because the prompt is asynchronous.
- [x] Extend the TypeScript command union and `DesktopHelperClient`, then add safe result validation and error mapping in `BundledDarwinHelperClient`.
- [x] Keep the existing `screenRecording` helper health field for protocol compatibility within this release, but stop treating it as authoritative in the driver.
- [x] Run `npm run build:desktop-helper` and the targeted tests.

### Task 3: Align permission health and requests with the responsible process

**Files:**
- Modify: `src/main/desktop-gateway/platform/darwin-driver.ts`
- Test: `src/main/desktop-gateway/platform/darwin-driver.spec.ts`

**Interfaces:**
- Inject: `getScreenAccessStatus()` around Electron `systemPreferences.getMediaAccessStatus('screen')`
- Inject: `requestScreenAccess()` around a minimal `desktopCapturer.getSources()` call
- Implement: `requestSystemPermission(permission)`

- [x] Add failing status-mapping tests for Electron's `granted`, `not-determined`, `denied`, `restricted`, and `unknown` values.
- [x] Add a regression proving helper `screenRecording` cannot override Electron's status.
- [x] Add regressions proving a missing/failed helper makes Accessibility and input unavailable without discarding an independently available Screen Recording state.
- [x] Change Accessibility false to map both Accessibility and input to `missing_permission`; reserve `unavailable` for helper/runtime failure.
- [x] Add failing request tests: already-ready permissions do not prompt, Screen Recording performs one minimal source request then rechecks, Accessibility invokes the helper prompt then rechecks, and request failures return a safe state without content.
- [x] Implement composed health using Electron for Screen Recording and helper health for Accessibility/input; build setup actions from the composed result.
- [x] Implement Screen Recording registration with `types: ['screen']`, a 1x1 thumbnail, and `fetchWindowIcons: false`; discard all returned sources immediately.
- [x] Implement Accessibility prompting through the helper and deduplicate concurrent requests for the same permission with one in-flight promise.
- [x] Run `npm run test:quiet -- src/main/desktop-gateway/platform/darwin-driver.spec.ts`.

### Task 4: Add the operator-only request-and-open IPC flow

**Files:**
- Modify: `src/main/desktop-gateway/desktop-gateway-service.ts`
- Modify: `src/main/desktop-gateway/desktop-gateway-service.spec.ts`
- Modify: `packages/contracts/src/channels/desktop.channels.ts`
- Modify: `src/main/ipc/handlers/desktop-gateway-handlers.ts`
- Create: `src/main/ipc/handlers/desktop-gateway-handlers.spec.ts`
- Generate: `src/preload/generated/channels.ts`

**Interfaces:**
- Add channel: `desktop:request-system-permission`
- Replace the renderer use of `desktop:open-permission-settings`; remove the old channel after all callers migrate.
- Return: `DesktopGatewayResult<DesktopPermissionActionResult>`, where the action result adds `settingsOpened` to the driver request result.

- [x] Add service tests proving `requestSystemPermissionForOperator()` denies without invoking the driver when Computer Use is disabled and delegates with the stable operator audit context when enabled.
- [x] Add handler tests for strict Zod enum validation and trusted-sender rejection before any native request or navigation.
- [x] Add failing handler cases for ready, missing, native-request failure, exact-pane failure with Privacy & Security root fallback, dual navigation failure, and non-macOS behavior.
- [x] Implement `requestSystemPermissionForOperator()` without accepting a caller-supplied instance context, and audit only safe permission/state/result metadata.
- [x] Centralize main-process URL candidates. Try the permission-specific pane first and the Privacy & Security root second; never accept a URL from IPC.
- [x] Treat `shell.openExternal()` resolution as navigation success and rejection as failure. Return `settingsOpened: false` if both candidates fail.
- [x] Preserve the native result even when navigation fails so the renderer can distinguish permission state from settings-launch state.
- [x] Run `npm run generate:ipc`, `npm run verify:ipc`, and the targeted service/handler specs.

### Task 5: Expose one typed renderer IPC operation

**Files:**
- Modify: `src/preload/domains/desktop.preload.ts`
- Modify: `src/renderer/app/core/services/ipc/desktop-gateway-ipc.service.ts`
- Create: `src/renderer/app/core/services/ipc/desktop-gateway-ipc.service.spec.ts`

**Interfaces:**
- Add preload method: `desktopRequestSystemPermission({ permission })`
- Add renderer wrapper: `requestSystemPermission(permission)`
- Remove: `desktopOpenPermissionSettings` / `openPermissionSettings` after migration.

- [x] Add a failing IPC-service test for typed payload forwarding, nested gateway-result normalization, and the non-Electron failure shape.
- [x] Replace the old open-only wrapper with the new request-and-open wrapper.
- [x] Keep the preload domain as a thin invoke layer with no platform, URL, or permission logic.
- [x] Run `npm run test:quiet -- src/renderer/app/core/services/ipc/desktop-gateway-ipc.service.spec.ts` and `npm run generate:ipc`.

### Task 6: Create the shared Angular permission lifecycle

**Files:**
- Create: `src/renderer/app/core/state/computer-use-permission.store.ts`
- Create: `src/renderer/app/core/state/computer-use-permission.store.spec.ts`
- Modify: `src/renderer/app/core/state/settings.store.ts` only if a named `computerUseEnabled` computed signal is needed; otherwise consume `settings()` without expanding the store API.

**Interfaces:**
- Produce signals: `health`, `loading`, `error`, `missingPermissions`, `bannerVisible`, `chipVisible`
- Produce actions: `refresh()`, `requestPermission(permission)`, `dismissBanner()`

- [x] Add failing store tests proving it remains inert before settings initialization, on non-macOS, and while Computer Use is disabled.
- [x] Add tests for one refresh on enable, no polling, in-flight refresh/request deduplication, and retention of the last good health value on transient refresh failure.
- [x] Add tests for option C state: unhealthy starts as banner-only; dismiss changes to chip-only; ready hides both; disabling clears state; re-enabling starts a fresh banner period.
- [x] Add tests for `window.focus` and `document.visibilitychange` refresh plus listener cleanup through `DestroyRef`.
- [x] Implement the root-provided signal store using `SettingsStore`, `DesktopGatewayIpcService`, and `ElectronIpcService.platform`.
- [x] Refresh immediately after a permission action and surface the manual Privacy & Security instruction when `settingsOpened` is false.
- [x] Do not persist dismissal to settings or local storage.
- [x] Run `npm run test:quiet -- src/renderer/app/core/state/computer-use-permission.store.spec.ts`.

### Task 7: Implement the banner, collapsed chip, and Settings reuse

**Files:**
- Create: `src/renderer/app/core/state/computer-use-permission-banner.component.ts`
- Create: `src/renderer/app/core/state/computer-use-permission-banner.component.html`
- Create: `src/renderer/app/core/state/computer-use-permission-banner.component.scss`
- Create: `src/renderer/app/core/state/computer-use-permission-banner.component.spec.ts`
- Create: `src/renderer/app/core/state/computer-use-permission-chip.component.ts`
- Create: `src/renderer/app/core/state/computer-use-permission-chip.component.spec.ts`
- Modify: `src/renderer/app/app.component.ts`
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.spec.ts`
- Modify: `src/renderer/app/features/settings/computer-use-settings-tab.component.ts`
- Modify: `src/renderer/app/features/settings/computer-use-settings-tab.component.html`
- Modify: `src/renderer/app/features/settings/computer-use-settings-tab.component.spec.ts` or create it if absent

**Interfaces:**
- Banner actions request only the missing permission selected by James.
- Chip click navigates to `/settings?tab=computer-use`.
- Settings consumes shared health/request state while retaining local apps, grants, and audit loading.

- [x] Add component tests for missing-permission labels, one action per missing permission, loading/disabled state, safe error copy, `role="status"`, `aria-live="polite"`, and dismissal.
- [x] Add chip tests for `1 needed`, `2 needed`, unavailable tone, query-param navigation, and absence before banner dismissal.
- [x] Mount the chip in the existing title-bar status cluster and the banner above `app-main`, beside the startup and pause banners.
- [x] Ensure the banner and chip never render simultaneously and both disappear immediately when ready or disabled.
- [x] Refactor `ComputerUseSettingsTabComponent` to use shared health/loading/error and `requestPermission()`; keep apps, grants, and audit data local to that tab.
- [x] Disable permission actions while Computer Use is off. Preserve the existing refresh/revoke behavior for the rest of the tab.
- [x] Run the new component/store specs and `src/renderer/app/app.component.spec.ts`.

### Task 8: Verify the signed packaged macOS ownership boundary

**Files:**
- Inspect: `electron-builder.json`
- Inspect/modify only if evidence requires it: `scripts/set-electron-fuses.js`, `build/entitlements.mac.plist`, and packaging tests
- Test: `scripts/electron-smoke-check.js` or a focused packaging check if nested-helper verification is not already covered

> Deferred live checks recorded in [the live-test plan](./2026-07-11-computer-use-permission-onboarding-plan_livetest.md) (Check 1) — requires macOS, a signed packaged build, and clean TCC state, none of which exist in the headless implementation environment.

### Task 9: Run real behavior and repository gates

**Files:**
- Rename after all checks pass: `docs/superpowers/specs/2026-07-11-computer-use-permission-onboarding-design.md` to `_completed.md`
- Rename after all checks pass: `docs/superpowers/plans/2026-07-11-computer-use-permission-onboarding-plan.md` to `_completed.md`

> Deferred live checks recorded in [the live-test plan](./2026-07-11-computer-use-permission-onboarding-plan_livetest.md) (Check 2) — requires the rebuilt app, real macOS permission prompts, and human interaction. All state transitions are unit-tested in `computer-use-permission.store.spec.ts` and the banner/chip/settings component specs.
- [x] Run all targeted helper, driver, service, IPC, store, component, and app specs.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Review the final diff for secrets, arbitrary-URL exposure, agent-facing permission actions, stale old-channel references, and unrelated edits.
- [x] Rename the design and plan with `_completed`; every agent-runnable automated check passes, and the packaged-app checks are deferred per the Live-Test Deferral policy into the linked livetest doc.

## Acceptance Checklist

- [x] Computer Use disabled means no permission UI or native request.
- [x] Missing permissions produce the approved banner-then-chip option C.
- [x] Screen Recording status and registration come from Electron.
- [x] Accessibility status and prompting come from the bundled Swift helper.
- [x] Each action attempts the real protected seam before System Settings fallback.
- [x] Exact-pane failure falls back safely and dual failure is reported honestly.
- [x] Focus/visibility refresh removes stale UI without polling or restart.
- [x] Settings, banner, and chip share one permission lifecycle.
- [x] Agents cannot invoke the permission request through Computer Use MCP tools.
- [ ] Signed packaged Harness receives the expected macOS TCC attribution — deferred to [the live-test plan](./2026-07-11-computer-use-permission-onboarding-plan_livetest.md).
- [x] Targeted and canonical repository verification gates pass.
