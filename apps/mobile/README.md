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

The phone-facing gateway DTOs come from the repo's dependency-free `@contracts` package.
`src/app/core/models.ts` re-exports them alongside phone-only view models, so desktop and
phone wire types cannot drift independently.

## Prerequisites

- Node 20+ and Xcode (with your Apple Developer account signed in).
- **Tailscale** running on both this Mac and your iPhone, on the same tailnet.
- The desktop app's mobile gateway enabled (**Settings → Mobile → Start gateway**).
- For push: an App ID with the **Push Notifications** capability and an **APNs Auth Key
  (`.p8`)**, configured in the desktop **Settings → Mobile → Push notifications** card.

## Clone setup

```bash
cd /path/to/ai-orchestrator/apps/mobile
npm ci
npm run sync
```

> Bundle ID defaults to `com.shutupandshave.aiorchestrator` (`capacitor.config.ts`).
> Change it there + in Xcode signing + the desktop APNs **Bundle ID** field if you prefer.

### Tracked native project

- `ios/App` is source-controlled. Do not run `npx cap add ios` over it.
- The app target is iOS 16.0; the Live Activity widget is iOS 16.1 because ActivityKit
  does not exist on 16.0. The Podfile, widget target, embed phase, push entitlement,
  scene lifecycle, and Camera/Photos/Microphone/Speech/Face ID descriptions are tracked.
- `npm run sync` builds Angular, runs `cap sync ios`, refreshes Pods, and verifies the
  generated brand assets. It no longer patches tracked Swift or plist source files.
- **Simulator caveat**: GoogleMLKit ships **no arm64-simulator slice**, so with the QR
  plugin the app builds for the simulator only as x86_64 and won't run on Apple-Silicon
  simulators. Run on a **real device** (the intended target — push + camera need one), or
  temporarily comment the `CapacitorMlkitBarcodeScanning` pod out of the Podfile to run the
  rest of the app in a simulator. Verified here: a sim build (sans MLKit) launches and
  renders correctly; full `ng build` + a device-SDK native build both succeed.

## Build & run on your phone

```bash
npm run ios:device -- --device "your iPhone name" --team "your Apple team ID"
```

The command builds Angular, syncs Capacitor and Pods, signs for that device, installs the
result with CoreDevice, then launches `com.shutupandshave.aiorchestrator`. Set
`HARNESS_IOS_DEVICE_ID` and `HARNESS_IOS_TEAM_ID` instead of flags for repeated runs.
`xcrun devicectl list devices` must show the phone as `available`; unlock it, connect it,
and enable Developer Mode first. Signing is supplied at runtime and is not stored in the
project. `npm run ios` remains the interactive Xcode path.

For fast browser iteration, run `npm run start` (push and QR scanning are no-ops there;
paste-pairing still works).

## Deterministic browser preview

Run the phone UI without a desktop Harness gateway:

```bash
npm run preview
```

The command starts the Angular dev server behind a fixture gateway at
`http://127.0.0.1:4173`, then prints a preview-only connection code. Open the printed
URL, choose **Add host → Paste connection code**, paste that complete JSON value, and
pair. The fixture contains live and completed sessions, two projects, an approval,
queued input, model choices, recent folders, and history.

Switch deterministic transport cases with the page query string. Reload after changing
it so the fixture selects the case before the app reconnects:

- `?scenario=default`
- `?scenario=streaming`
- `?scenario=gap`
- `?scenario=disconnect`
- `?scenario=401`
- `?scenario=transcript-1000`

Override the fixture origin when another device or worker needs it with
`HARNESS_PREVIEW_HOST` and `HARNESS_PREVIEW_PORT`. Set `HARNESS_PREVIEW_BIND=0.0.0.0`
only for that remote run; the default remains loopback-only. These fixtures contain
placeholders only; they do not connect to or expose a real Harness gateway.

## Pairing

1. On your Mac: **Settings → Mobile → Start gateway**, then **Generate pairing code**.
2. In the app: **＋ Add a host** → **Scan QR code** (or paste the connection code).
3. The phone exchanges the one-time token for a long-lived device token (stored
   on-device) and connects. You'll see projects + live status, and can open any session.

## Verification status

- **Type-checked + AOT-built here**: `npm run typecheck` (tsc), the rendered Vitest suite,
  ESLint, and `ng build` pass.
- **Native build checked here**: `npm run sync` followed by an unsigned iPhoneOS workspace
  build compiles the app and embedded Live Activity extension. A signed install/launch
  still requires an available physical phone and runtime signing.
- **Physical-device-only**: APNs delivery, camera, Face ID, haptics, keyboard behaviour,
  VoiceOver, and the live Tailscale link remain device checks.

## Layout

```
src/app/
├── core/
│   ├── models.ts                 # shared wire DTO re-exports + phone view models
│   ├── status.ts                 # status → colour/label (mirrors desktop)
│   ├── host-store.ts             # paired hosts + active selection (persisted)
│   ├── gateway-client.service.ts # REST commands and feature orchestration
│   ├── gateway-socket.ts         # live WebSocket lifecycle
│   ├── transcript-store.ts       # transcript state and replay merging
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
