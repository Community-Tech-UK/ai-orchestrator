# iPhone 18 Harness sideload — historical continuation snapshot

**Status reconciliation — 2026-09-24:** this preserves the continuation snapshot taken after
the reboot and James's launch retry that day. It is not a completed-work claim or a fresh device
inspection. The phone's present connection, installed build and launch/trust state are unknown
unless independently rechecked; no device or signing operation was performed for this note update.

**Fresh CoreDevice recheck — 2026-09-25:** `xcrun devicectl list devices` still knows both
`JL iPhone 17` and `JL iPhone 18`, but reports both physical phones as `unavailable`.
Consequently the installed Harness build, present launch result, and device-side trust alert
could not be inspected in this run. No signing, install, launch, or phone setting was changed.
The repo now has a repeatable `npm run ios:device` build/install/launch command ready for the
next time the iPhone is connected and unlocked; the unresolved trust diagnosis below remains
historical until a connected-device launch reproduces it with logs.

Device, team and provisioning identifiers below identify the historical run only. They are not
credentials or authority to alter signing. The `/tmp` paths are transient evidence locations,
not durable artifacts; their continued existence and contents have not been verified.

## Request and device recorded in the snapshot

- James asked to add his new iPhone 18 to Xcode and sideload Harness.
- Xcode 27.0 then showed **JL iPhone 18**, an iPhone 18 Pro Max on iOS 27.0 (24A437), UDID `00008160-000E59C11EA0000A`. CoreDevice showed it paired with Developer Mode enabled.
- The phone was registered and enabled in Apple Developer team `GJL9WJ4S4W`.

## Work observed during that run

- A development build of Harness 1.0 (2), bundle `com.shutupandshave.aiorchestrator`, built and installed. Its profile `62D827E8-0004-4CE9-AD4D-E79CB09C9713` includes this UDID. The profile appeared **Valid** on the phone, and `codesign --deep --strict --verify` passed locally.
- iOS refused to launch that build. James saw **Unable to Verify App**. Xcode reported that the Developer App Certificate was not trusted. James checked Settings > General > VPN & Device Management and found no Developer App entry. Disabling the phone VPN did not change the alert. Safari on the phone loaded `https://ppq.apple.com/` and received `ok`; this alone does not prove the full verification service works.
- Xcode's first normal Run attempt selected an older automatic profile that excluded this phone and showed no configured account. A later Xcode report from James showed the same device-side trust denial. A newer Xcode-managed profile subsequently appeared on the phone; do not assume the first signing error is the current blocker.
- An **Ad Hoc** archive and IPA were built and exported with Xcode's App Store Connect API authentication. The exported app was signed by `Apple Distribution: James Lawrence (GJL9WJ4S4W)`; `codesign --deep --strict --verify` passed. Its profile `05D9350B-5EE7-43EF-A929-0C6B3E067A9E` includes this UDID and appeared **Valid** on the phone. The Ad Hoc app was installed over the development app without an uninstall. A `devicectl` launch still failed with `CoreDeviceError 10002` / `FBSOpenApplicationServiceErrorDomain` security denial. Thus changing from development to distribution signing did not resolve the launch block.
- The Ad Hoc IPA was written to `/tmp/harness-mobile-iphone18-adhoc-export/harness.ipa`. The extracted installed bundle was at `/tmp/harness-mobile-iphone18-adhoc-inspect/Payload/App.app`. Build and export logs were `/tmp/harness-mobile-iphone18-adhoc-archive.log` and `/tmp/harness-mobile-iphone18-adhoc-export.log`.
- No mobile project files were changed during that run. Its `git diff -- apps/mobile/ios` was empty; its unrelated dirty documentation was preserved. These are historical checkout observations, not a current Git status.

## Handoff recorded after the retry — not current device state

- A full reboot was requested on the phone after the Ad Hoc launch failed. CoreDevice then reported the phone **unavailable**, and `system_profiler SPUSBDataType` showed no iPhone USB connection. Its later CoreDevice connection state has not been rechecked.
- James unlocked the phone and tapped Harness after the reboot. He clarified that it still says **Unable to Verify App** and that an internet connection is required to verify trust of the developer, showing team ID `GJL9WJ4S4W`. This is James's transcription of the alert; its exact on-screen punctuation was not captured.
- At the last reported retry, the app was installed but had not been verified to open. The underlying reason for iOS's trust rejection was unresolved. Its present state remains unverified in this document. If investigation resumes, obtain targeted device-side verification evidence before changing signing again.
