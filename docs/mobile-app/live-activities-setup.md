# Live Activities — one-time Xcode setup

Everything except the widget-extension *target* is already in place:

- App side: `LiveActivityPlugin` lives in the managed `AppDelegate.swift`
  (source of truth: `apps/mobile/resources/native/AppDelegate.swift`).
- `Info.plist` gets `NSSupportsLiveActivities` from the ensure-script.
- The widget UI code is ready at
  `apps/mobile/resources/native/HarnessWidgets/HarnessLiveActivity.swift`.
- The Mac gateway already pushes `liveactivity` updates for registered tokens.

Adding an Xcode *target* can't be scripted safely (pbxproj surgery), so this
one is a 3-minute manual step:

## Steps (Xcode 15+)

1. `cd apps/mobile && npm run ios` (builds, syncs, opens Xcode).
2. File → New → Target… → **Widget Extension**.
   - Product Name: `HarnessWidgets`
   - UNCHECK "Include Configuration App Intent".
   - CHECK "Include Live Activity" (harmless either way — we replace the files).
   - Embed in: App. Finish. "Activate scheme" → Activate.
3. In the new `HarnessWidgets` group, delete every template `.swift` file
   (Move to Trash).
4. Right-click the `HarnessWidgets` group → "Add Files to 'App'…" → select
   `apps/mobile/resources/native/HarnessWidgets/HarnessLiveActivity.swift`
   - UNCHECK "Copy items if destination" (add by reference → future edits to
     the resources/ file flow straight into builds).
   - Target membership: **HarnessWidgets only** (not App).
5. Widget extension's `Info.plist` needs no changes (the template's
   `NSExtension` entry is correct).
6. Build & run the App scheme on the phone.

## Verify

- Start a session from the phone, background the app → the activity appears on
  the lock screen with the session name + status.
- With APNs configured in desktop Settings (`mobileGatewayApns*`), status
  changes keep updating the activity even after iOS suspends the app
  (per-activity token flow: plugin → gateway `POST
  /api/devices/:id/live-activity-token` → `apns-push-type: liveactivity`).
- Session ends → activity dismisses within a few minutes.

## Gotchas

- The `HarnessSessionAttributes` struct is compiled into BOTH targets (one
  copy in the managed AppDelegate, one in HarnessLiveActivity.swift). ActivityKit
  matches them by name + Codable shape — if you change one, change both.
- Live Activities require iOS 16.2+ and the user not having disabled them
  (Settings → harness → Live Activities).
- The activity push token is per-activity and in-memory on the gateway; a Mac
  restart just means updates resume on the next activity start.
