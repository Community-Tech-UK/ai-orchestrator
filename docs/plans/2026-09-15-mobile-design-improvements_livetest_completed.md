# Mobile design improvements: remaining device checks

**Current status — 2026-09-27:** Open: 0 · Closed: 0 · Moved: 5 · Failed: 0.

All remaining assertions require the unavailable physical iPhone and are now maintained in the
single consolidated [RES-013 physical-iPhone campaign](2026-09-27-livetest-human-external-residuals_livetest.md#res-013--physical-iphone-mobile-queue-design-permissions-and-rendering-campaign).
This source document is complete as a campaign record; moving the checks does not claim they passed.

**Implementation plan:** [Mobile design improvements](2026-09-15-mobile-design-improvements_plan_completed.md).

**Prerequisites:** A rebuilt, signed Harness mobile app containing these changes, installed through the normal iOS development/release workflow; an unlocked iPhone; a test host with the rebuilt mobile gateway; disposable sessions and harmless test images. Keep App Lock enabled for check 4. Do not overwrite the user's real paired app or send commands to real work as fixture setup.

**Remediation flow:** Read [the campaign runbook](livetest-campaign-runbook.md) before execution. A reproduced defect gets a new LT-NNN entry in [the remediation register](livetest-remediation-register.md), plus a matching implementation-status section in [the remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md). Record per-check evidence here. Rename this file `_livetest_completed.md` only after every check passes.

## Runtime preflight, 15 September 2026

- `rtk proxy xcrun simctl list devices booted` returned no booted simulator.
- `rtk proxy xcrun devicectl list devices` found the paired JL iPhone 17.
- `rtk proxy xcrun devicectl device info apps --device 'JL iPhone 17' --filter 'bundleIdentifier == "com.shutupandshave.aiorchestrator"'` could not inspect the installed app: CoreDevice error 12040, underlying `kAMDMobileImageMounterDeviceLocked`. The phone must be unlocked before Xcode can inspect/install a build. This is a device-lock result, not evidence of a host/network outage.
- This task built the web app and tested its actual Angular UI with synthetic data. It did not install a phone build or verify native signing, permissions or APNs delivery.

## Runtime preflight, 25 September 2026

- The tracked iOS project and Live Activity extension passed `npm run sync` and an unsigned
  iPhoneOS workspace build. The built `App.app` contains `HarnessWidgets.appex` with bundle ID
  `com.shutupandshave.aiorchestrator.widgets`.
- `xcrun devicectl list devices` reported both known physical phones as `unavailable`, including
  `JL iPhone 18`. No signed install, launch, native-permission prompt, APNs delivery, or VoiceOver
  check was possible. This is not evidence of a product defect and no LT item was opened.
- Resume with `cd apps/mobile && npm run ios:device -- --device "JL iPhone 18" --team "your Apple
  team ID"` after the phone is connected, unlocked, and Developer Mode is enabled. See
  [the current improvement plan's live-test companion](2026-09-25-mobile-app-improvement_plan_livetest.md)
  for the consolidated execution and evidence steps.

## Moved checks

The keyboard/safe-area/text-size, photo/dictation/queue-race, VoiceOver/reduced-motion, App Lock and
pairing/notification assertions are now RES-013 steps 12–16. Record the device/iOS/build identifiers,
visible results, native permission and biometric behavior there when the physical device is available.
