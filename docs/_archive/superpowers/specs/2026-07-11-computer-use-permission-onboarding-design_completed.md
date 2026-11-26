# Computer Use Permission Onboarding Design

**Date:** 2026-07-11
**Status:** Implemented 2026-07-12 — all agent-runnable gates pass; packaged-app TCC attribution and live UI flows deferred to `docs/superpowers/plans/2026-07-11-computer-use-permission-onboarding-plan_livetest.md`
**Scope:** Local macOS coordinator only

## Summary

When Computer Use is enabled on macOS but Screen Recording or Accessibility is
missing, AIO will show a dismissible permission banner at the top of the app.
The banner provides one action for each missing permission. Dismissing the
banner collapses it into an amber title-bar chip that remains until both
permissions are ready. The chip opens AIO's Computer Use settings page, where
the same permission actions and live health state remain available.

Permission requests are never made merely because AIO starts. They become
visible only when `computerUseEnabled` is true, and invoking a native macOS
request requires an explicit user click.

## Goals

1. Make missing Computer Use permissions visible outside the Settings page.
2. Let James open the correct macOS Privacy & Security pane from the banner,
   title bar, or Computer Use settings.
3. Use the real protected operation before the System Settings fallback so
   macOS can register AIO in the relevant permission list.
4. Recheck permissions when AIO regains focus and remove stale warnings without
   requiring a restart.
5. Report health from the process that actually uses each protected capability.

## Non-goals

- Requesting permissions while Computer Use is disabled.
- Automatically granting, toggling, or bypassing macOS privacy controls.
- Adding Windows or Linux desktop-control support.
- Redesigning Computer Use grants, app allowlists, audit history, or agent
  escalation policy.
- Replacing Electron `desktopCapturer` with ScreenCaptureKit in this change.
- Persisting a user's dismissal after Computer Use has been disabled and later
  re-enabled.

## Current State

AIO already has most of the lower-level pieces:

- `ComputerUseSettingsTabComponent` fetches live desktop gateway health and
  renders per-permission **Open settings** buttons.
- `desktop:open-permission-settings` opens pane-specific
  `x-apple.systempreferences:` URLs from the trusted main process.
- `DesktopHelper.swift` checks Accessibility with `AXIsProcessTrusted()` and
  Screen Recording with `CGPreflightScreenCaptureAccess()`.
- `DarwinDesktopDriver` captures screenshots through Electron
  `desktopCapturer`, while Accessibility inspection and input synthesis run in
  the Swift helper.
- `AppComponent` already provides a root-level dismissible banner pattern and a
  title-bar status cluster.
- Settings supports direct navigation to `/settings?tab=computer-use`.

The important correctness issue is that Screen Recording health is currently
reported by the Swift helper even though Electron performs the screen capture.
The permission check and protected operation should have the same responsible
process identity.

## Research Conclusions

1. Electron documents `systemPreferences.getMediaAccessStatus('screen')` as the
   way to detect macOS screen-capture consent for `desktopCapturer`.
   <https://www.electronjs.org/docs/latest/api/system-preferences/>
2. Electron documents that `desktopCapturer` requires macOS Screen Recording
   consent. Attempting the real capture operation is the registration/request
   seam available to AIO's Electron main process.
   <https://www.electronjs.org/docs/latest/api/desktop-capturer/>
3. Apple documents `AXIsProcessTrustedWithOptions` with
   `kAXTrustedCheckOptionPrompt`; prompting is asynchronous and the return value
   remains the current trust state.
   <https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions>
4. Apple expects apps that need Accessibility access to prompt and then direct
   the user to Privacy & Security when needed.
   <https://support.apple.com/en-ca/guide/mac-help/mh43185/mac>
5. TCC decisions depend on macOS's "responsible code" relationship. A bundled,
   signed helper normally attributes its protected operation to the containing
   app, but this relationship can be broken by unusual child-process behavior.
   AIO must therefore verify the packaged app on a clean macOS permission state,
   not rely only on unit tests.
   <https://developer.apple.com/forums/thread/678819>
6. Pane-specific `x-apple.systempreferences:` URLs are widely used but not part
   of a stable, publicly documented Apple API contract. AIO must treat them as
   best-effort navigation and fall back to the Privacy & Security root pane if
   the exact pane cannot be opened.

## Recommended Architecture

### 1. Process-aligned permission status

`DarwinDesktopDriver.health()` will compose permission status from two sources:

- **Screen Recording:** Electron main process via
  `systemPreferences.getMediaAccessStatus('screen')`.
- **Accessibility and input:** the existing Swift helper via
  `AXIsProcessTrusted()`.

Electron statuses map as follows:

| Native status | Gateway capability state |
| --- | --- |
| `granted` | `available` |
| `not-determined`, `denied` | `missing_permission` |
| `restricted`, `unknown` | `unavailable` |

Accessibility `true` maps Accessibility and input to `available`;
Accessibility `false` maps both to `missing_permission`. A missing, failed, or
version-mismatched helper continues to map both to `unavailable` with its
existing safe setup action.

The helper health response may retain its `screenRecording` field during this
change to avoid an unnecessary protocol migration, but the driver will no
longer use that field as the authoritative Screen Recording status.

### 2. User-initiated request and fallback

Add a typed desktop gateway operation:

```ts
type DesktopSystemPermission = 'screen-recording' | 'accessibility';

interface DesktopPermissionActionResult {
  permission: DesktopSystemPermission;
  state: DesktopCapabilityState;
  nativeRequestAttempted: boolean;
  settingsOpened: boolean;
}
```

The operation is exposed only through trusted renderer IPC. It is an operator
action, not an agent MCP tool.

For Screen Recording:

1. Read `systemPreferences.getMediaAccessStatus('screen')`.
2. If already granted, return `available` without opening System Settings.
3. Otherwise call `desktopCapturer.getSources({ types: ['screen'],
   thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false })` from the
   main process to exercise the real protected API.
4. Re-read the Electron media status.
5. If it is still not granted, open the Screen Recording pane.

For Accessibility:

1. Read helper trust with `AXIsProcessTrusted()`.
2. If already trusted, return `available` without opening System Settings.
3. Otherwise invoke a new helper command that calls
   `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt: true`.
4. Re-read helper trust. Because Apple's prompt is asynchronous, a false result
   is expected until the user acts.
5. If still false, open the Accessibility pane.

Exact-pane opening first uses the current pane-specific URL. If Electron rejects
that URL, AIO attempts the Privacy & Security root URL. The IPC result reports
`settingsOpened: false` if both fail; renderer surfaces that error instead of
claiming success.

Concurrent clicks for the same permission share one in-flight promise so AIO
does not stack native prompts or System Settings launches.

### 3. Shared renderer permission state

Add a root-provided `ComputerUsePermissionStore` that owns:

- current `DesktopHealthData`;
- `loading` and safe `error` signals;
- whether the initial banner has been dismissed for the current enabled period;
- computed missing permissions;
- computed banner visibility and title-bar chip visibility;
- idempotent `refresh()` and `requestPermission(permission)` methods.

The store becomes active only after `SettingsStore.isInitialized()` and
`computerUseEnabled` are true on macOS. It refreshes:

- immediately when Computer Use becomes enabled;
- after a permission action;
- when AIO's renderer window regains focus;
- when document visibility changes back to `visible`.

Focus and visibility events are coalesced through the store's in-flight refresh
guard. There is no polling timer.

Disabling Computer Use clears health, errors, and the banner dismissal. Enabling
it again starts a fresh setup period and shows the banner if permissions are
missing.

### 4. Banner and title-bar chip

Use two small standalone OnPush components backed by the shared store:

- `ComputerUsePermissionBannerComponent` is mounted above `app-main`, alongside
  the existing startup and pause banners.
- `ComputerUsePermissionChipComponent` is mounted in the existing title-bar
  status cluster.

Banner behavior:

- It appears only on macOS when Computer Use is enabled, health has loaded, at
  least one required permission is `missing_permission`, and the banner has not
  been dismissed for the current enabled period.
- It names the missing permissions and renders one action per missing
  permission.
- Each action invokes the request-and-fallback operation.
- Dismiss changes the current enabled period to compact mode; it does not hide
  the underlying health warning.

Chip behavior:

- It appears after the banner is dismissed while Computer Use remains enabled
  and either required permission is not `available`.
- It uses warning styling for missing permissions and error styling for
  unavailable helper/platform failures.
- Its text is compact: `Computer Use: 2 needed`, `Computer Use: 1 needed`, or
  `Computer Use unavailable`.
- Clicking it navigates to `/settings?tab=computer-use`.
- It disappears as soon as both Screen Recording and Accessibility are
  `available` or Computer Use is disabled.

The banner is announced with `role="status"` and `aria-live="polite"`. Buttons
have explicit accessible names such as `Open Screen Recording settings`.

### 5. Computer Use settings integration

`ComputerUseSettingsTabComponent` will consume `ComputerUsePermissionStore`
instead of owning a separate health request lifecycle. Its existing apps,
grants, and audit refresh remain local to the tab.

The existing **Open settings** buttons call the store's
`requestPermission(permission)` method. Button loading and errors therefore
match the root banner, and the status row updates when AIO regains focus.

The detailed settings tab remains the source of truth for health diagnostics;
the banner and chip are concise setup entry points.

## State Model

| Computer Use | Permission health | Dismissed | Root UI |
| --- | --- | --- | --- |
| Disabled | Any | Any | No permission banner or chip |
| Enabled | Loading | No | No stale warning; optional compact loading state only in Settings |
| Enabled | Both ready | Any | No permission banner or chip |
| Enabled | Missing | No | Banner only |
| Enabled | Missing | Yes | Amber chip only |
| Enabled | Unavailable | No | Error-toned banner only |
| Enabled | Unavailable | Yes | Error chip only |

The dismissal is in-memory for one enabled period. It is not written to
`localStorage`, so a restart with Computer Use still enabled may show the banner
again if setup remains incomplete. This is intentional for a high-impact feature
that cannot function, while the persistent chip prevents dismissal from hiding
the problem during the current run.

## Error Handling

- Native request failures are logged with stable error codes and no captured
  pixels, window titles, typed text, or secret-like data.
- A failed native request still attempts the System Settings fallback.
- A failed exact-pane deep link falls back to Privacy & Security root.
- If both navigation attempts fail, the UI shows: `Could not open System
  Settings. Open Privacy & Security manually.`
- Health refresh retains the last successful health value while exposing a
  transient refresh error, avoiding false "ready" or flicker.
- Unsupported platforms never invoke macOS URLs or native request operations.
- Request actions are trusted-renderer IPC only and validated with Zod.

## Security and Privacy

- Agents cannot invoke the system-permission request IPC through the
  `computer-use` MCP server.
- The operation accepts a closed permission enum and no arbitrary URL.
- Existing trusted-sender validation remains mandatory.
- Screen registration asks Electron only for screen sources and does not return
  thumbnails or source metadata to the renderer.
- Permission health and action results contain no app/window content.
- The design does not attempt to toggle TCC settings or use private Apple
  entitlements.

## Testing Strategy

### Native/helper tests

- Helper protocol accepts `requestAccessibility` and rejects malformed payloads.
- Helper client maps request success and protocol failures to safe gateway
  errors.
- Darwin driver uses Electron Screen Recording status rather than the helper's
  `screenRecording` boolean.
- Screen status mapping covers all Electron media-access values.
- Accessibility false maps both Accessibility and input to
  `missing_permission`.
- Requesting Screen Recording exercises the injected capture request once and
  rechecks status.
- Requesting Accessibility invokes the helper prompt command once and rechecks
  health.

### Main/IPC tests

- The permission enum rejects arbitrary values and missing payloads.
- Trusted-sender rejection prevents native requests and external navigation.
- Ready permissions do not open System Settings.
- Missing permissions attempt registration and then the exact pane.
- Exact-pane failure attempts the Privacy & Security root.
- Dual navigation failure returns `settingsOpened: false`.
- Non-macOS returns a typed unsupported result without opening a URL.
- Concurrent same-permission actions are deduplicated.

### Renderer tests

- Store remains inactive while Computer Use is disabled.
- Enabling refreshes once and shows banner/chip for missing permissions.
- Dismiss hides only the banner.
- Focus and visible events refresh with listener cleanup.
- Ready health removes both surfaces.
- Disabling and re-enabling starts a fresh banner period.
- Banner actions route to the correct permission enum and expose failures.
- Chip text/count/state are correct and click navigates to the Computer Use tab.
- Settings reuses the store action and does not start a competing health
  lifecycle.

### Manual packaged-app verification

Run on a signed packaged macOS build with a clean TCC state:

1. Enable Computer Use and confirm no native prompt occurs until a banner action
   is clicked.
2. Click Screen Recording; confirm Harness appears in Screen & System Audio
   Recording and the correct pane opens when required.
3. Click Accessibility; confirm Harness, not a raw helper path, appears in the
   Accessibility list.
4. Grant each permission, return to Harness, and confirm focus refresh updates
   the banner/chip without restarting.
5. Revoke each permission while Harness is running and confirm the warning
   returns on focus.
6. Deny each first-time prompt and confirm a later action still opens the correct
   pane.
7. Verify the packaged helper is signed as nested code and `codesign --verify
   --deep --strict` succeeds.

If macOS attributes Accessibility to the raw helper rather than Harness, stop
the release and correct helper packaging/signing or move the AX permission seam
into a properly bundled helper/XPC service before accepting the feature.

## Expected File Boundaries

- Shared contracts/types: desktop permission enum and action result.
- Swift helper protocol: Accessibility request command only.
- Darwin driver: process-aligned status and user-initiated request mechanics.
- Desktop gateway service/IPC: operator-only request orchestration and safe
  System Settings fallback.
- Preload/renderer IPC: typed request wrapper and desktop change subscription.
- Renderer store: one permission state lifecycle.
- Root banner/chip components: presentation and navigation only.
- Computer Use settings tab: detailed diagnostics plus reuse of the shared
  permission actions.

## Acceptance Criteria

1. With Computer Use disabled, AIO never shows or requests these permissions.
2. Enabling Computer Use with missing permissions shows option C: a banner that
   collapses to a persistent title-bar chip.
3. Each permission action attempts the real native request and then opens the
   correct System Settings pane when still missing.
4. Screen Recording health reflects Electron's permission, not the helper's.
5. Returning to AIO after changing System Settings refreshes state without a
   restart.
6. Banner and Settings actions share one implementation.
7. Both surfaces disappear when Screen Recording and Accessibility are ready.
8. Unit, renderer, IPC, typecheck, lint, LOC, and full quiet test gates pass.
9. A signed packaged build passes the clean-TCC manual verification above.
