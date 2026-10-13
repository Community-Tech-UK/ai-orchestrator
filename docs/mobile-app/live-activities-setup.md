# Live Activities — tracked native setup

The app target, widget-extension target, embed phase, plists, entitlements, and Swift sources
are tracked in the repository. No one-time Xcode target creation is required.

## Source layout

- App-side ActivityKit plugin and shared attributes:
  `apps/mobile/ios/App/App/AppDelegate.swift`
- Widget UI and its matching attributes:
  `apps/mobile/resources/native/HarnessWidgets/HarnessLiveActivity.swift`
- Widget plist:
  `apps/mobile/resources/native/HarnessWidgets/Info.plist`
- Xcode target and embed configuration:
  `apps/mobile/ios/App/App.xcodeproj/project.pbxproj`

The App target deploys to iOS 16.0 for the wider phone app. `HarnessWidgets` deploys to
iOS 16.1, the first ActivityKit release, and is embedded as `HarnessWidgets.appex`.

## Build and install

```bash
cd apps/mobile
npm ci
npm run sync
npm run ios:device -- --device "your iPhone name" --team "your Apple team ID"
```

`npm run sync` preserves the widget target while refreshing Angular assets, Capacitor
configuration, plugins, Pods, and generated brand assets. Signing is supplied at runtime;
the tracked Xcode project deliberately contains no developer-team identifier.

## Verify on a physical phone

1. Pair Harness with a disposable desktop gateway and open a running session.
2. Background or lock the phone. Confirm the activity appears with the correct session name,
   project, and status.
3. Change the session status and confirm the activity updates after iOS suspends the app.
4. Finish the session and confirm the activity ends.

With APNs configured in desktop Settings (`mobileGatewayApns*`), the per-activity token flows
from the plugin to `POST /api/devices/:id/live-activity-token`; the gateway then sends
`apns-push-type: liveactivity` updates.

## Gotchas

- `HarnessSessionAttributes` is intentionally compiled into both targets. ActivityKit matches
  the definitions by type name and Codable shape; change both copies together.
- Live Activities require iOS 16.1+, and remote token updates in this app require iOS 16.2+.
  The user can also disable Live Activities in Settings → harness.
- The activity push token is per activity and held in memory by the gateway. After a Mac
  restart, remote updates resume when the next activity starts.
- Build this CocoaPods app through `App.xcworkspace`, not `App.xcodeproj`, or plugin frameworks
  will be missing.
