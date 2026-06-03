# AI Orchestrator — Mobile Control App Plan

**Date:** 2026-05-30
**Owner:** James
**Status:** ✅ COMPLETE (2026-06-03). Phases 0–3 + all planned Phase 4 shipped and **verified running
on a real iPhone 17** (built, signed under Community Tech Ltd, installed, launched, exercised by James —
the final real-device sign-off). Backend re-verified 2026-06-03 (tsc electron + spec clean, **57 vitest
tests pass** in `src/main/mobile-gateway/`); phone app type-checks + AOT-builds (`ng build`,
strictTemplates) + eslint-clean. Phase 4 delivered: Face ID app-lock, completion pushes, mobile-token
expiry, optional **`wss://` TLS** (cert/key → https/wss, hostname from cert SAN), **camera-roll
attachments** (`@capacitor/camera` → canvas downscale → base64), plus a net-new persisted **history**
feature. A WS ping/pong **heartbeat** was added (reaps half-open cellular sockets) from the fresh-eyes
review. Backend committed earlier (`2aa21242`/`c0d358fc`/`910de7d8` + serializer refactor `402b0d76`);
the 2026-06-03 review/wss/camera changes are in the working tree, **not yet committed**.
**Reference UI:** `./codex-visual-reference.md` + `./reference-images/` (the Codex mobile app).

---

## Implementation status (2026-05-30)

Backend — `src/main/mobile-gateway/` (all in-process, no IPC trust gate):
- `mobile-gateway-server.ts` — HTTP+WS on 4879 bound to the tailscale iface. REST: `/pair`,
  `/api/instances` (+ `:id/messages|input|respond|interrupt|terminate|rename`), `POST /api/instances`,
  `/api/projects`, `/api/snapshot`, `/api/prompts`, `/api/pause` (GET/POST), `/api/recent-dirs`,
  `/api/devices/:id/apns-token`. WS: `snapshot`, `instance-output` (live transcript w/ per-instance
  `seq`), `permission-prompt`, `permission-cleared`, `pause-state`. Subscribes directly to the
  `InstanceManager` EventEmitter (`provider:normalized-event`, `instance:input-required`) +
  orchestration `user-action-request` + `PauseCoordinator`.
- `mobile-apns-sender.ts` — direct-to-Apple APNs over HTTP/2 with an ES256 `.p8` JWT (built-in
  `crypto`/`http2`, no new deps); JWT cached ≤50 min; no-ops when unconfigured.
- `mobile-device-registry.ts` — pairing/token expiry/revoke/APNs-token (pre-existing, +`apnsTokens()`).
- Settings keys `mobileGatewayApns*` (+ defaults); init step already constructs the gateway.
- Desktop **Settings → Mobile** gained a Push (APNs) config card.
- Tests (as of 2026-06-03): `mobile-gateway-server.spec.ts` (35), `mobile-apns-sender.spec.ts` (8),
  registry (9) — **52 pass**. Pure serialization moved to `mobile-gateway-serializers.ts`.

Phone app — `apps/mobile/` (Angular 21 standalone + Capacitor):
- Gateway client (REST + WS, reconnect, `seq` gap-fill, transcripts/prompts/pause signals),
  hosts (QR + paste pairing), projects (organize modes + pause toggle), session list,
  conversation (transcript + live + input + Stop/terminate/rename), global approval sheet,
  new-session flow, push registration + tap-to-approve. Builds with `ng build`.

Phase 4 — DONE since this plan was written: Face ID app lock (`core/app-lock.service.ts` +
`features/lock/lock-screen.component.ts`), completion (non-approval) pushes, mobile-token expiry,
plus a net-new persisted **history** browser (`features/history/*`, served by `/api/history*`).
Phase 4 — `wss://` TLS DONE (2026-06-03): gateway serves https/wss when `mobileGatewayTlsCertPath` +
`mobileGatewayTlsKeyPath` are set (Settings → Mobile → "Secure connection" card). It reads the cert's
DNS SAN and advertises that hostname in the pairing QR (`secure:true`), so the phone connects by the
cert name with no trust prompt — recommended source is `tailscale cert <mac>.<tailnet>.ts.net`. Default
(empty paths) = plain `ws://`, unchanged. Phone honours `secure` end-to-end (`wss`/`https` + a manual
checkbox). Also landed a WS ping/pong **heartbeat** that reaps half-open cellular sockets (review fix).
Phase 4 — camera-roll attachments DONE (2026-06-03): `@capacitor/camera` picker in the conversation
composer (`core/image-attachment.service.ts`) — picks photos, downscales/JPEG-re-encodes them through a
canvas (≤1600px, well under the 8 MB body cap, normalises HEIC), shows removable thumbnail chips, and
sends them as base64 data-URL `FileAttachment`s via the existing `sendInput`. Added
`NSPhotoLibraryUsageDescription`. Answering orchestration *questions* (user-action prompts) from the phone is
surfaced (deep-link to the session) but not yet a first-class in-sheet reply — the sheet handles the
permission flow, which is the high-value path.

---

## 0. Decisions locked

1. **Client = Angular + Capacitor.** Reuses your stack (standalone + signals, matches the
   repo's Angular conventions), lets the app **share the repo's `packages/contracts` types**,
   and produces a real iOS app distributed via **TestFlight** (you have a paid Apple Developer
   account + release experience). Makes **APNs push first-class** (§4.4), so "ping me when an
   agent needs approval" is core, not a stretch.
2. **Scope = full control, phased.** Each milestone is usable on its own:
   monitor → open + prompt → approve/stop → create. Stop after any phase you're happy with.
3. **Access = remote-first, over Tailscale.** You won't use the phone at home (you'll use the
   desktop), so it's built for **away-from-home use from day one**. Connectivity rides a
   **Tailscale (WireGuard) tunnel** between phone and Mac — encrypted E2E, works over cellular,
   no port-forwarding, nothing public-facing. Same overlay the worker docs already use
   (`docs/REMOTE_ACCESS.md`).
   - **Prerequisite:** Tailscale on both the Mac and the iPhone, on the same tailnet (free for
     personal use). Alternatives (Cloudflare Tunnel, etc.) are possible — say if you prefer one.
     **Public port-forwarding is not recommended** for a shell-capable control server.

Still genuinely open: **Instances vs Chats focus** (§7), and confirming **Tailscale** as the tunnel.

---

## 1. Goal

A phone app that connects to **one or more** running AI Orchestrator instances (each = the desktop
app on a machine, e.g. `MacBook-Pro`) **from anywhere**, and lets you **see and control the agents**:
watch sessions and live status, read transcripts, send prompts, **answer the approval prompts agents
block on**, and stop/start work. Codex mobile is the model: host + online dot → Projects → Chats →
conversation.

Explicitly **out of scope** (this is why it stays small): we are **not** mirroring the whole desktop
renderer. No file explorer, native folder dialogs, drag-drop, diff editing, MCP config, Doctor,
settings sprawl. The phone is a focused control surface.

---

## 2. The big advantage — most of the backend already exists

The investigation (grounded, file:line) found AI Orchestrator already has the hard parts of "let an
external client drive it over the network." We **reuse**, not rebuild:

| Need | Already in the codebase | File |
|---|---|---|
| HTTP + push server pattern | `RemoteObserverServer` (HTTP + SSE, bearer auth, binds `0.0.0.0`) | `src/main/remote/observer-server.ts` (`mode:'read-only'` :126) |
| Token pairing / auth | `RemoteAuthService` — enrollment tokens, one-time + manual pairing, **persisted** per-device tokens, timing-safe validation, revocation | `src/main/auth/remote-auth.ts` (`authenticateRegistration` :76, `validateSessionToken` :124, `setManualPairingCredential` :189) |
| WS server, incl. TLS | raw `ws` `WebSocketServer`, with an HTTPS/mTLS branch to copy | `src/main/remote-node/worker-node-connection.ts` (:96; TLS branch :76–94) |
| Libraries | `ws` ^8.20, **`qrcode` ^1.5.4** (pairing QR), `zod` ^4 — all already deps | `package.json` |
| Shared types/schemas | `Instance`, `InstanceStatus`, `OutputMessage`, `ContextUsage`, `FileAttachment`; Zod payload schemas | `src/shared/types/instance.types.ts`; `packages/contracts/src/schemas/instance.schemas.ts` |
| (Not used) mDNS discovery | `DiscoveryService` + `bonjour-service` — **LAN-only**, so irrelevant to a remote-first phone; the phone connects to a stored **Tailscale hostname** instead | `src/main/remote-node/discovery-service.ts` |

**Crucially, why this is *not* the deferred "thin-client replatform"** (`docs/plans/2026-05-28-thin-client-replatform-followup.md`): that plan tried to tunnel the *entire* `window.electronAPI` over WS, which hit three walls — the IPC trust gate that rejects non-window senders (`ipc-main-handler.ts:107`), event fan-out scattered across ~40 `webContents.send` sites, and a "feature tail" (~⅓ of UX) of local-Mac-only features. **Our gateway sidesteps all three**: it calls main-process services **in-process** (no IPC trust gate), subscribes to the `InstanceManager` EventEmitter **directly** (the same source the renderer fan-out uses — no refactor), and deliberately omits the local-Mac feature tail. It's a small, purpose-built API, not a renderer mirror.

---

## 3. Architecture

```
   iPhone (Angular + Capacitor)                       Mac running AI Orchestrator
 ┌────────────────────────────┐                     ┌─────────────────────────────────────┐
 │ Hosts + online dots        │                     │ Electron main process               │
 │ Projects (by workingDir)   │   ws:// over the    │ ┌─────────────────────────────────┐ │
 │ Sessions + live status     │   Tailscale tunnel  │ │ NEW: MobileGatewayServer        │ │
 │ Transcript + input         │◀═══════════════════▶│ │ http + ws (:4879)               │ │
 │ Approve / Deny / Stop      │  (WireGuard E2E,    │ │ bind → tailscale interface      │ │
 └────────────────────────────┘   over cellular)    │ │ auth → RemoteAuthService        │ │
        ▲                                            │ └──────────────┬──────────────────┘ │
        │ APNs push (Apple's network, cellular)      │     in-process calls / events       │
        └──────────── api.push.apple.com ◀───────────│ InstanceManager · PauseCoordinator  │
                                                      │ RemoteObserverServer prompt store   │
                                                      └─────────────────────────────────────┘
```

Two control paths reach the phone: **(1)** the Tailscale tunnel (live data + commands), and **(2)**
APNs over Apple's network (alerts), which works even when the app is closed. Two deliverables:
**(A) a Mobile Gateway** in the Electron main process, and **(B) the phone app**.

---

## 4. (A) The Mobile Gateway — `src/main/mobile-gateway/`

A new subsystem modeled on the worker-node subsystem (its own `enabled` settings flag + boot init
step). **One HTTP server**, **REST for commands** + a **WebSocket (upgrade on the same port) for the
live event stream**. Default port **4879** (4877 = observer, 4878 = worker). Binds to the **Tailscale
interface** (falls back to `0.0.0.0`, still token-gated).

### 4.1 Transport & endpoints

REST (JSON, `Authorization: Bearer <token>`):

| Method + path | Maps to |
|---|---|
| `POST /pair` (one-time pairing token → long-lived device token) | `RemoteAuthService.authenticateRegistration` (paired path) |
| `GET /api/instances` | `InstanceManager.getAllInstancesForIpc()` (`instance-manager.ts` ~:1090, transport-safe) |
| `GET /api/instances/:id/messages` | observer's existing message-replay bundle |
| `GET /api/projects` | derived: group instances by `workingDirectory` (mirror `ProjectGroupComputationService`) + `recent-dirs:get` for empty projects |
| `GET /api/prompts` | observer pending-prompt store (the "needs approval" list) |
| `GET /api/pause` / `POST /api/pause` | `PauseCoordinator` (`pause:get-state` / `pause:set-manual`) |
| `POST /api/instances/:id/input` `{message, attachments?}` | `InstanceManager.sendInput()` (:1280) |
| `POST /api/instances/:id/respond` `{requestId, decisionAction:'allow'|'deny', decisionScope?, response, metadata}` | permission answer → `resumeAfterDeferredPermission()` (handler logic `instance-handlers.ts:944–964`) |
| `POST /api/instances/:id/interrupt` | `InstanceManager.interruptInstance()` (:1244; 2nd call escalates to kill) |
| `POST /api/instances/:id/terminate` | `InstanceManager.terminateInstance()` (:1188) |
| `POST /api/instances` `{workingDirectory, provider, model?, initialPrompt?}` | `InstanceManager.createInstanceWithMessage()` |
| `POST /api/devices/:id/apns-token` | store the phone's APNs token for push (§4.4) |

WebSocket `GET /ws` (after auth): server pushes a `snapshot` on connect, then live events, re-using
the exact event set the observer already forwards:

| WS event | Source (main-process emitter) |
|---|---|
| `snapshot` | full instance list on connect / resync |
| `instance-output` | `provider:runtime-event` — **the one transcript stream** (`instance-event-forwarding.ts:164`) |
| `instance-state` | `instance:state-update` (:145) + `instance:batch-update` (:204) |
| `instance-created` / `instance-removed` | (:106 / :124) |
| `permission-prompt` | `instance:input-required` w/ `metadata.type==='deferred_permission'` (:310) |
| `pause-state` | `pause:state-changed` |

The gateway **subscribes to the `InstanceManager` EventEmitter directly** (same signals as
`src/main/app/instance-event-forwarding.ts`) and fans them out to connected phones. The output
envelope (`ProviderRuntimeEventEnvelope`, `packages/contracts/src/types/provider-runtime-events.ts:250`)
carries a **monotonic `seq` per instance** → the phone uses it for gap detection on reconnect (which
matters more on a flaky cellular link).

> Why REST+WS over "all WebSocket JSON-RPC": more debuggable (curl-able over the tailnet) and it
> mirrors the two patterns already proven in this repo (observer = HTTP+SSE; worker = WS).

### 4.2 Auth & pairing (reuse, don't reinvent)

- Desktop **Settings → Mobile** shows a **QR code** (existing `qrcode` dep) encoding
  `{ host: '<tailscale-magicdns-or-100.x.y.z>', port: 4879, pairingToken }`. Encoding the **tailnet
  address** (not a LAN IP) is what makes pairing work later from cellular. `pairingToken` is a
  one-time credential from `RemoteAuthService.issuePairingCredential()` (TTL ~1h).
- Phone scans → `POST /pair` → gateway calls `authenticateRegistration` → mints a **persisted device
  token** (server-side in settings `remoteNodesRegisteredNodes`; on the phone in the **iOS Keychain**
  via Capacitor secure storage).
- Every request carries `Bearer <deviceToken>`, validated by `validateSessionToken`. **Revoke** a
  phone from the desktop (same path as a worker node).
- **Transport:** plain `ws://` is fine — **Tailscale/WireGuard already encrypts the link E2E** (same
  stance the worker docs take for Tailscale). `wss://`/TLS stays available via the existing TLS
  branch as optional extra hardening, not required on the tailnet.
- **Mobile-token expiry (new):** worker tokens never expire; mobile tokens should. Small add to
  `RemoteAuthService`; re-pair (re-scan QR) on expiry.

### 4.3 Wiring

- New settings keys mirroring the worker ones: `mobileGatewayEnabled` (default **false**),
  `mobileGatewayPort` (4879), `mobileGatewayBindInterface` (`'tailscale'|'all'`, default `tailscale`)
  in `src/shared/types/settings.types.ts`.
- New boot init step in `src/main/app/initialization-steps.ts`, gated on `mobileGatewayEnabled`,
  that constructs `MobileGatewayServer`, **resolves + binds the Tailscale interface IP** (fallback
  `0.0.0.0` + token auth), and subscribes to `InstanceManager` events. Singleton
  (`getMobileGatewayServer()` + `_resetForTesting()`). mDNS advertise is skipped (LAN-only).
- IPC handlers (desktop UI): start/stop gateway, get status + tailnet URL, generate pairing QR,
  list/revoke paired devices — pattern from `src/main/ipc/handlers/remote-node-handlers.ts`.
- New IPC channels go through the generated-channel pipeline (`packages/contracts/src/channels/*`
  → `src/preload/generated/channels.ts`); honour the runtime alias rule (AGENTS.md "Packaging
  Gotchas") for any new `@contracts/...` subpaths.

### 4.4 Push notifications — APNs direct from the Mac

With your paid account the Mac gateway pushes **straight to Apple**, **no third-party relay**:
- One **APNs Auth Key (`.p8`)** in the developer account (doesn't expire; works across apps). The
  gateway holds `.p8` + key ID + team ID + bundle ID and POSTs to APNs HTTP/2 (`api.push.apple.com`)
  with a short-lived signed JWT — ~100 lines, no extra service.
- On pairing, the phone registers for remote notifications and sends its **APNs device token** to the
  gateway (`POST /api/devices/:id/apns-token`), stored on the device record.
- On `waiting_for_permission` / user-action-request (hooks exist: `window-manager.ts:471` + the
  observer prompt store), the gateway sends a push — "Bash needs approval" — and tapping it
  deep-links into the approval sheet.
- Push rides **Apple's network**, so alerts arrive over cellular independent of the Tailscale link;
  and because control is remote-first, the tap can immediately act, wherever you are.

---

## 5. (B) The phone app — `apps/mobile/` (Angular + Capacitor)

A **workspace package** in the monorepo (the repo already uses `packages/` + `turbo.json`), depending
on `packages/contracts` for shared Zod schemas/types so gateway and client never drift. *(Confirm
npm-workspaces config during scaffolding.)*

Stack: Angular 21 standalone + signals (project conventions); Capacitor iOS shell;
`@capacitor/preferences`/Keychain for the token; `@capacitor/barcode-scanner` for pairing;
`@capacitor/push-notifications` for APNs (§4.4); a small WS client with reconnect + `seq` gap-fill.
Distribute via **TestFlight** (wireless, multi-device) or cabled Xcode for dev iteration. Styling per
`codex-visual-reference.md` tokens (true-black iOS dark, one green accent + amber for "needs you").

### 5.1 Screens (mapped to the Codex reference)

1. **Hosts / connection** (drawer; ref screenshot 1 header + screenshot 2 drawer)
   - Paired AI Orchestrator instances, each with an **online dot** = live WS reachability over the
     tailnet (green = gateway reachable now). Switch active host. "+ Add" → QR-scan pairing. This is
     the **"potentially more than one"** requirement.
2. **Home / Projects** (ref screenshot 1)
   - Active host name + dot at top. **Projects = instances grouped by `workingDirectory`**, each row
     a per-project status rollup (mirror `getProjectStateSummary`, `project-group-computation.service.ts:140`)
     + a pending-approval badge. Floating **search** pill + white **"New"** CTA. Overflow menu =
     organize modes (By project / Chronological), per ref screenshot 3.
3. **Session list** (within a project) — rows: provider icon, name, **status dot** (reuse desktop
   `STATUS_COLORS`/`STATUS_LABELS`, `status-indicator.component.ts:8`), unread dot (`hasUnreadCompletion`),
   **"Awaiting approval"** chip (`waiting_for_permission` / `pendingApprovalCount`).
4. **Conversation** — transcript from `instance-output` history + live stream (render `OutputMessage`s
   like desktop `OutputStreamComponent`), status/context header, prompt **input bar** (`POST .../input`),
   mirroring `InputPanelComponent`.
5. **Approval sheet** — on a `permission-prompt`, a bottom sheet shows the tool + args
   (`metadata.tool_name`, `metadata.tool_input`) with **Allow / Deny** + scope (Once / Session /
   Always) → `POST .../respond`. *The single most valuable screen.*

### 5.2 What we deliberately don't build on mobile
Native folder dialogs, drag-drop, local file paths, reveal/open-in-editor, MCP config. "New session"
picks a directory from the **host's recent dirs** (`recent-dirs:get`), never a local picker.
Attachments (Phase 4) come from the **camera roll** → `FileAttachment` base64 (already supported by
`sendInput`). This keeps the desktop "feature tail" off the phone.

---

## 6. Phasing (each phase independently useful)

**Prerequisite (one-time):** Tailscale on Mac + iPhone, same tailnet; an App ID with Push enabled +
an APNs `.p8` key (needed by Phase 2).

| Phase | Gateway | Phone | Outcome |
|---|---|---|---|
| **0 — Connect (remote)** | new module, HTTP+WS on 4879 **bound to the tailscale iface**, auth via `RemoteAuthService`, `/pair` (QR encodes tailnet addr), `/api/instances`, WS `snapshot`+`instance-state` | scaffold, design tokens, QR pairing, Hosts + Projects + Session list with **live status over Tailscale** | See all sessions + status **from anywhere** |
| **1 — Read + prompt** | `/api/instances/:id/messages`, WS `instance-output` | Conversation screen (transcript + live), input bar → `/input` | Read transcripts, send prompts remotely |
| **2 — Control + push** | `/respond`, `/interrupt`, `/api/prompts`, pause routes, **APNs sender (`.p8`)**, `apns-token` route | Approval sheet, Stop, pending badge, pause toggle, **push register + receive, tap-to-approve** | **Get pinged anywhere + approve/deny + stop** |
| **3 — Create/manage** | `POST /api/instances`, terminate/rename | New-session flow (recent dirs + provider/model), organize modes | Start & manage work |
| **4 — Stretch** | token-expiry hardening, optional `wss://` | Face ID lock, camera-roll attachments, completion pushes, organize extras | Polish + extras |

A genuinely valuable, use-it-from-anywhere app exists at **end of Phase 2**.

---

## 7. Risks & honest caveats

- **Tailscale is a prerequisite.** Both devices on one tailnet (free, personal). WireGuard handles
  NAT traversal + encryption, so no port-forwarding and nothing public-facing. Don't want Tailscale?
  Use a tunnel (e.g. Cloudflare Tunnel) — but **don't expose the port directly to the internet**.
- **This is a remotely-reachable control server for a shell-capable machine — take security
  seriously.** Defense in depth: bind to the tailscale interface only; token auth on every request
  (`validateSessionToken`); **mobile-token expiry** (new); per-device revoke; Tailscale ACLs limiting
  which devices can route to the Mac; a Face ID app lock (Phase 4) for a lost/unlocked phone.
- **Push setup chores.** App ID + Push capability + APNs `.p8`; push needs a real device (Simulator
  push is limited). All things you've done before.
- **Reconnect/resync on cellular.** The WS client must, on reconnect, re-fetch the snapshot and use
  per-instance `seq` for gap detection — more important on mobile networks than on LAN. Designed in,
  but it's the fiddly part.
- **Two session systems.** The app has an **Instance** system (live agents, project-grouped) and a
  **Chat** system (`chat.types.ts`, persistent, provider-agnostic). The plan centers on **Instances**
  (that's what "control" means). If you'd rather the phone be chat-history-centric, we pivot to the
  Chat domain — say so and I'll re-aim §5. *(This is the main open product question.)*
- **node-pty/terminal not included.** A remote shell is the desktop's Piece C work, intentionally not
  a v1 mobile feature.

---

## 8. Concrete first-PR work list (Phase 0)

Backend:
1. `src/shared/types/settings.types.ts` — add `mobileGateway*` settings keys (incl. bind interface).
2. `src/main/mobile-gateway/mobile-gateway-server.ts` — HTTP+WS server bound to the tailscale iface; `/pair`, `/api/instances`, WS snapshot+state; singleton.
3. `src/main/mobile-gateway/mobile-gateway-auth.ts` — thin wrapper over `RemoteAuthService` (+ token expiry).
4. `src/main/mobile-gateway/tailscale-interface.ts` — resolve the tailscale interface IP (fallback `0.0.0.0`).
5. Init step in `src/main/app/initialization-steps.ts` (gated on `mobileGatewayEnabled`).
6. IPC handlers + channels: start/stop/status (+ tailnet URL), pairing QR, list/revoke devices.
7. Desktop **Settings → Mobile** tab: enable toggle, QR, paired-device list, tailnet URL.
8. Vitest: auth (pair/validate/expire), instance-list serialization, WS snapshot + a state event.

Client:
9. `apps/mobile/` Angular+Capacitor scaffold, depends on `packages/contracts`; iOS project.
10. Design-token stylesheet from `codex-visual-reference.md`.
11. `GatewayClient` (REST + WS, reconnect, `seq`), `HostStore` (paired hosts + active), pairing (QR → `/pair` → Keychain).
12. Hosts, Projects, Session-list screens with live status.

Verification gate (per AGENTS.md): `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
`npm run lint`, `npm run test` for backend. **Phase-0 done = connect from the phone over Tailscale
with wifi off (cellular) and see live session status.**

---

## 9. Open for you

1. **Tailscale** as the tunnel — confirm, or name your preferred alternative.
2. **Instances vs Chats** — control live agents (assumed) vs a chat-history-centric phone app.
3. Anything to cut/reorder in the phasing.
