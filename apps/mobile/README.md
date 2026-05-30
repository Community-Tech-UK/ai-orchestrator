# AI Orchestrator — Mobile (Phase 0)

A small iPhone app (Angular + Capacitor) that connects to AI Orchestrator instances
over **Tailscale** and shows your projects + live session status. Built to be installed
on your own device — not an App Store release.

> **Phase 0 scope:** pair a host, list hosts (with an online dot), see projects
> (grouped by working directory) and live session status. Opening a session's
> transcript + sending prompts + approvals + push notifications come in later phases.

This app is a **standalone package** (not part of the root npm workspace). Its DTOs in
`src/app/core/models.ts` mirror `src/shared/types/mobile-gateway.types.ts` in the main repo.

## Prerequisites

- Node 20+ and Xcode (with your Apple Developer account signed in).
- **Tailscale** running on both this Mac and your iPhone, on the same tailnet.
- The desktop app's mobile gateway enabled (see "Pairing" below).

## One-time setup

```bash
cd apps/mobile
mv angular.json.template angular.json   # angular.json is git-protected in this repo
npm install
npx cap add ios
```

> Bundle ID defaults to `com.shutupandshave.aiorchestrator` (`capacitor.config.ts`).
> Change it there + in Xcode signing if you prefer.

## Build & run on your phone

```bash
npm run build            # Angular production build → www/
npx cap sync ios         # copy web assets + native deps into the iOS project
npx cap open ios         # opens Xcode
```

In Xcode: select your iPhone, set your signing Team, and Run. (`npm run ios` chains
build + sync + open.)

For fast UI iteration in the browser/simulator without native bits: `npm run start`.

## Pairing

1. On your Mac: **Settings → Mobile → Start gateway**, then **Generate pairing code**.
2. In the app: tap **＋ → Add a host**, and either paste the **connection code** shown on
   the desktop, or type the Tailscale IP + port + pairing token.
3. Tap **Pair**. The phone exchanges the one-time token for a long-lived device token
   (stored on-device) and connects. You'll see projects + live status.

(QR-scan pairing is a planned fast-follow; paste/manual works everywhere today.)

## Verification status

The TypeScript logic is type-checked against Angular 21. **Full Angular template
type-checking and the native iOS build run here on your Mac** (`npm run build` / Xcode) —
they can't be exercised in the headless dev environment where this was scaffolded.

## Layout

```
src/app/
├── core/
│   ├── models.ts                 # DTOs (mirror of the gateway's shared types)
│   ├── status.ts                 # status → colour/label (mirrors desktop)
│   ├── host-store.ts             # paired hosts + active selection (persisted)
│   └── gateway-client.service.ts # REST pair + live WebSocket (auto-reconnect)
└── features/
    ├── hosts/                    # host list + add-host (pairing)
    ├── projects/                 # projects grouped by working directory
    └── sessions/                 # sessions in a project, with live status dots
```
