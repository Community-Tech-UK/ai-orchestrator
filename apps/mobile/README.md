# harness — Mobile

A small iPhone app (Angular + Capacitor) that connects to harness instances
over **Tailscale** and lets you watch and **control** your agents from anywhere: read
transcripts, send prompts, **approve/deny** the permission prompts agents block on,
stop/start work, and get **push alerts** when an agent needs you. Built to be installed
on your own device — not an App Store release.

> **Implemented:** pairing (QR + paste), hosts list with live online dot, projects
> (grouped by working dir) + live session status, the **conversation screen**
> (transcript + live stream + input bar), the **approval sheet** (Allow/Deny + scope),
> Stop/terminate/rename, pause toggle, **new-session** flow (host recent dirs +
> provider/model), organize modes (By project / Chronological), and **APNs push**
> registration with tap-to-approve.

This app is a **standalone package** (not part of the root npm workspace). Its DTOs in
`src/app/core/models.ts` mirror `src/shared/types/mobile-gateway.types.ts` in the main repo.
If the gateway DTOs change, update both.

## Prerequisites

- Node 20+ and Xcode (with your Apple Developer account signed in).
- **Tailscale** running on both this Mac and your iPhone, on the same tailnet.
- The desktop app's mobile gateway enabled (**Settings → Mobile → Start gateway**).
- For push: an App ID with the **Push Notifications** capability and an **APNs Auth Key
  (`.p8`)**, configured in the desktop **Settings → Mobile → Push notifications** card.

## One-time setup

```bash
cd apps/mobile
cp angular.json.template angular.json   # angular.json is git-ignored in this repo
npm install
npx cap add ios
```

> Bundle ID defaults to `com.shutupandshave.aiorchestrator` (`capacitor.config.ts`).
> Change it there + in Xcode signing + the desktop APNs **Bundle ID** field if you prefer.

### Native capabilities (Xcode, after `cap add ios`)

- **iOS deployment target ≥ 16.0** (required): the QR scanner pulls in GoogleMLKit 7,
  which needs iOS 15.5+. `cap add ios` defaults the project + Podfile to 14.0, so
  `pod install` fails until you bump it. Set it to 16.0 in `ios/App/Podfile`
  (`platform :ios, '16.0'`) **and** the App target's *Minimum Deployments* in Xcode,
  then `cd ios/App && pod install`. (Because `cap sync` regenerates these files, consider
  committing the `ios/` project so the bump + capabilities persist.)
- **Push Notifications**: add the *Push Notifications* capability to the App target.
- **Camera** (QR pairing): add an `NSCameraUsageDescription` to `ios/App/App/Info.plist`,
  e.g. *"Scan the pairing QR code shown on your Mac."* The barcode scanner uses
  `@capacitor-mlkit/barcode-scanning` (Google ML Kit pods are added by `cap sync`).
- **Simulator caveat**: GoogleMLKit ships **no arm64-simulator slice**, so with the QR
  plugin the app builds for the simulator only as x86_64 and won't run on Apple-Silicon
  simulators. Run on a **real device** (the intended target — push + camera need one), or
  temporarily comment the `CapacitorMlkitBarcodeScanning` pod out of the Podfile to run the
  rest of the app in a simulator. Verified here: a sim build (sans MLKit) launches and
  renders correctly; full `ng build` + a device-SDK native build both succeed.

## Build & run on your phone

```bash
npm run sync             # build + copy native deps + patch iOS display metadata
npx cap open ios         # opens Xcode
```

In Xcode: select your iPhone, set your signing Team, and Run. (`npm run ios` chains
build + sync + the tracked iOS display-name patch + open.) For fast UI iteration without native bits: `npm run start`
(push + QR scanning are no-ops in the browser; paste-pairing still works).

## Pairing

1. On your Mac: **Settings → Mobile → Start gateway**, then **Generate pairing code**.
2. In the app: **＋ Add a host** → **Scan QR code** (or paste the connection code).
3. The phone exchanges the one-time token for a long-lived device token (stored
   on-device) and connects. You'll see projects + live status, and can open any session.

## Verification status

- **Type-checked + AOT-built here**: `npm run typecheck` (tsc) and `ng build`
  (Angular `strictTemplates`) both pass; ESLint is clean.
- **Not exercisable in this dev environment**: the native iOS build/run (Xcode),
  real APNs delivery (needs a device + the `.p8` configured on the Mac), and the live
  Tailscale link. Run those on your Mac.

## Layout

```
src/app/
├── core/
│   ├── models.ts                 # DTOs (mirror of the gateway's shared types)
│   ├── status.ts                 # status → colour/label (mirrors desktop)
│   ├── host-store.ts             # paired hosts + active selection (persisted)
│   ├── gateway-client.service.ts # REST + live WebSocket (events, transcripts, reconnect, seq)
│   ├── push.service.ts           # APNs register + token sync + tap deep-link (native only)
│   └── qr-scanner.service.ts     # camera QR pairing (native only)
└── features/
    ├── hosts/                    # host list + add-host (QR / paste pairing)
    ├── projects/                 # projects by working dir + organize modes + pause toggle
    ├── sessions/                 # sessions in a project, with live status dots
    ├── conversation/             # transcript + live stream + input bar + controls
    ├── new-session/              # start a session (host recent dirs + provider/model)
    └── approval/                 # the Allow/Deny + scope bottom sheet (global)
```
