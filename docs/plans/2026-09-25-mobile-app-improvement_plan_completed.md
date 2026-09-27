# Harness Mobile — Improvement Plan

**Status:** Approved by James on 2026-09-25 (review `2026-09-25-mobile-app-improvement`,
overall APPROVED, all 18 sections approved, no comments). Decisions are recorded in
section 3. Implementation is active: Phases 0–3 are implemented, all agent-runnable gates
pass, and their independent fresh reviews returned PASS; physical iPhone checks remain
deferred in the linked live-test document. Phases 4–6 remain. On 2026-09-25 James added
mobile active-turn steering to the approved scope; it is specified in M3.4.
**Date:** 2026-09-25
**Scope:** The iPhone app (`apps/mobile/`) and the desktop Mobile Gateway it talks to
(`src/main/mobile-gateway/`, `src/shared/types/mobile-gateway.types.ts`).
**Related documents:**
- Original build: `docs/mobile-app/2026-05-30-mobile-control-app-plan_completed.md`
- Last design pass: `docs/plans/2026-09-15-mobile-design-improvements_plan_completed.md`
- Open device checks: `docs/plans/2026-07-25-mobile-queue-interrupt-draft_livetest.md` (10 checks),
  `docs/plans/2026-09-15-mobile-design-improvements_livetest_completed.md` (5 checks moved to RES-013)
- Device signing snapshot: `docs/iphone18-harness-sideload-status.md`
- Live Activities setup: `docs/mobile-app/live-activities-setup.md`

---

## 1. Summary

The phone app works. You can pair it, browse projects, read and send messages, approve
requests, queue messages while an agent is busy, stop or close a session, start a new one,
switch models, read history, and get push alerts. The code is tidy, and every mobile gate
passes today (section 2.1).

The next round of improvement is not mainly about new screens. It is in this order:

1. **Get the app onto a phone reliably.** The iPhone 18 build will not launch ("Unable to
   Verify App"). The Xcode project is not in git, and the Live Activity widget target was
   never added. As a result, 15 device checks from earlier work are still open.
2. **Fix defects in the live connection.** The phone's gap detection uses the wrong counter,
   so it probably refetches whole transcripts after ordinary events and misses real gaps.
   The app does not reconnect when it returns to the foreground. Push-notification
   approvals find the host by name.
3. **Make long sessions fast.** Transcripts are fully rendered with no windowing. The
   markdown cache stops working once a transcript passes 300 messages.
4. **Build the test and preview tooling** so the work above can be checked without a
   device for everything except native behaviour.
5. **Add the away-from-desk features.** James chose all eight in section 3: loop
   monitoring, an attention inbox across hosts, quota/usage at a glance, browser approvals,
   continuing past sessions, automations, Plan Queue, and doc review.
6. **Finish the parked polish:** system light/dark appearance, Dynamic Type, pull to refresh,
   in-app sheets in place of browser `confirm()`/`prompt()`, pinned projects, and a
   two-column iPad layout.

Three large files are already at or over their size ceilings, so any feature work must
begin with extraction (section 2.4).

---

## 2. Current state (evidence)

### 2.1 Baseline gates, run 2026-09-25 on this checkout

| Check | Result |
|---|---|
| `apps/mobile`: `npm run typecheck` | Pass |
| `apps/mobile`: `npm run test:quiet` | Pass, 324 tests |
| `apps/mobile`: `npm run lint` | Pass |
| `apps/mobile`: `ng build` | Pass, initial bundle 316.9 kB raw / 88.3 kB transferred |
| Root `npm run check:ts-max-loc` | Pass (no mobile file reported over tolerance) |

The root gates other than `check:ts-max-loc` were not rerun for this plan. The plan changes
no code.

### 2.2 What the app does today

Screens are defined in `apps/mobile/src/app/app.routes.ts`: Hosts, Add host, Projects,
Sessions, Conversation, New session, History, and History detail. The approval sheet and
lock screen are global overlays (`app.component.ts`).

The gateway exposes about 27 REST routes and one WebSocket (`mobile-gateway-server.ts`
`handleRequest`, around line 1017). The WebSocket carries snapshot, instance-output,
permission-prompt/cleared, and pause-state events. It also supports idempotency keys, a
per-instance input queue (`mobile-input-queue.ts`, cap 20, 3 retries), APNs pushes for
prompts, completions, browser escalations, and Live Activity updates
(`mobile-gateway-push.ts`), a 30-second WS heartbeat, and optional TLS.

### 2.3 Findings

Labels: **Verified (code)** means I read the executing path. **Needs repro** means the
defect is inferred from code and must be reproduced before it is fixed (AGENTS.md rule).

| # | Finding | Evidence | Label |
|---|---|---|---|
| F1 | **Live-stream `seq` is the wrong counter.** The gateway broadcasts `seq: envelope.seq`, which is the provider adapter's event counter (`provider-interface.ts:75`, `this._seq++`). That counter advances for *every* runtime event kind. Only `output` events reach the phone (`provider-output-event.ts:83`), and tool-outcome frames are also dropped (`mobile-gateway-server.ts` `handleProviderEvent`, around line 764). The phone treats `seq > prev + 1` as a gap and refetches the transcript, up to 300 messages (`gateway-client.service.ts:267-275`). The counter also resets when an adapter respawns, for example after a model change, so real gaps after a respawn go undetected. | files cited | Verified (code); frequency needs repro |
| F2 | **Resume-from-cursor exists but is unused.** `GET /messages?fromSeq=N` uses the *buffer index* as its cursor (`mobile-gateway-history-handlers.ts:141-186`). The phone never sends `fromSeq` and does not declare `MobileMessagesResumeDto`. The WS seq and the replay seq are different numbering spaces, so they cannot be combined as things stand. | files cited | Verified (code) |
| F3 | **No foreground reconnect or client-side liveness check.** `GatewayClient` has no `appStateChange` listener. Only `app-lock.service.ts:78` and `draft-store.ts:87` listen. After iOS suspends the app, the socket may look open while being dead, and the UI can show stale "connected" data until the server heartbeat or TCP closes it. | `gateway-client.service.ts` | Verified (code); user impact needs device repro |
| F4 | **Fixed 3-second reconnect with no backoff or jitter** (`gateway-client.service.ts:33, 314-324`). | file | Verified (code) |
| F5 | **Push approval routes to a host by display name** (`respondFromPush`, `gateway-client.service.ts:533-566`). If it can't find the name, it falls back to the *active* host or the first host. Two Macs with the same name, or a renamed Mac, send the approval to the wrong host. The push payload should carry the device/host ID. | file | Verified (code) |
| F6 | **Push tap for a session that no longer exists** opens an empty conversation (`push.service.ts` `handleTap`). It does not show "this session has ended" or offer a way forward. | file | Verified (code) |
| F7 | **APNs error responses are only logged.** Nothing removes a token on `410 Unregistered` or `400 BadDeviceToken` (grep for `410` or `Unregistered` in `mobile-apns-sender.ts` and `mobile-gateway-push.ts` finds nothing). No `apns-collapse-id` is set, so Live Activity and status pushes are never coalesced. | grep | Verified (code) |
| F8 | **The markdown cache breaks down on long transcripts.** `renderMobileMarkdown` is called from the template for every message on every change detection (`conversation.component.html:112`). Its cache is a 300-entry LRU (`mobile-markdown.ts:5-6, 51-120`). When a transcript renders more than 300 distinct messages in order, every lookup misses, and each change detection re-parses and re-sanitizes the whole transcript. | files | Verified (code); jank needs measurement |
| F9 | **No transcript windowing.** The full transcript is rendered as a flat `@for`. There is no virtual scroll, no `content-visibility`, and no "load earlier". Each appended message copies the whole array (`appendMessage`, `gateway-client.service.ts:277-289`). | files | Verified (code) |
| F10 | **Only the active host shows as online.** `isOnline` is `id === activeId && state === 'connected'` (`hosts.component.ts:230-232`), so every other paired Mac always looks offline. There is no view of prompts across hosts. | file | Verified (code) |
| F11 | **Live Activities never set up on the device build.** The widget extension target is a manual Xcode step (`live-activities-setup.md`). The local `apps/mobile/ios/App/App.xcodeproj` has 0 references to `HarnessWidgets`. The Swift source exists in `apps/mobile/resources/native/HarnessWidgets/`. | grep | Verified (local project) |
| F12 | **The native iOS project is not in git.** `apps/mobile/ios/` is untracked. It is recreated by `cap add ios` plus four `ensure-*` patch scripts. Capabilities, signing, and the widget target cannot be reproduced from the repo. | `git ls-files apps/mobile/ios` is empty | Verified |
| F13 | **The device install path is broken on iPhone 18** ("Unable to Verify App" with both development and Ad Hoc signing). The current state has not been rechecked. | `docs/iphone18-harness-sideload-status.md` | Historical; recheck |
| F14 | **15 device checks are open** across two livetest docs. All logic and API layers passed. Only on-device rendering, haptics, keyboard, Face ID, APNs, and VoiceOver remain. | livetest docs | Verified (docs) |
| F15 | **Component tests cannot render.** The mobile `vitest.config.ts` has no `angularJitPlugin`, so every `*.component.spec.ts` checks source text with `readFileSync`/`toContain`. Templates are never rendered. | `apps/mobile/vitest.config.ts`; memory note 2026-09-06 | Verified |
| F16 | **DTOs are copied by hand** between `src/shared/types/mobile-gateway.types.ts` (435 lines) and `apps/mobile/src/app/core/models.ts` (238 lines), and nothing checks for drift. They already differ: the gateway has `seq?` on messages and `MobileMessagesResumeDto`, and the phone has neither. | diff of declarations | Verified |
| F17 | **The design-preview host is not reproducible.** The 2026-09-15 screenshots (`_scratch/mobile-design-review-2026-09-15/*.png`) came from a "Design preview host" that is not in the repo. | `rg` finds no source | Verified |
| F18 | **Browser `confirm()`/`prompt()` dialogs** are used for close, force-cancel, and rename (`conversation.component.ts:518, 574, 591`). They are unstyled, unreachable for tests, and not VoiceOver-friendly. | file | Verified (code) |
| F19 | **Appearance is dark-only** (`src/index.html:11`, `color-scheme: dark`). Light/system appearance was deferred in the 09-15 plan (Wave 3). There is no Dynamic Type support, because text sizes are fixed. | files | Verified (code) |
| F20 | **Security surface.** CORS is `*` (`mobile-gateway-http-utils.ts` `corsHeaders`). The WS device token travels in the URL query (`mobile-gateway-ws-handlers.ts:54`), so it can end up in URL logs. `POST /api/instances` accepts any `workingDirectory` string, so a stolen token can start an agent in any folder (`mobile-gateway-server.ts:1448-1451`). There is no audit trail of actions taken from a phone. Pairing tokens are 24 random bytes with a 10-minute TTL, so pairing brute force is not a concern. | files | Verified (code) |
| F21 | **Size ceilings block new work.** `mobile-gateway-server.ts` is 1,595 lines against an allowlisted 1,585 (`scripts/check-ts-max-loc.ts:326`, +50 tolerance). `gateway-client.service.ts` is 690 of 700 and `conversation.component.ts` is 690 of 700. Any added route or feature fails the gate unless code is extracted first. | `wc -l` | Verified |
| F22 | **Desktop features not reachable from the phone** (section 5). Loop runs can't be monitored or controlled (the phone only sees an `isLooping` flag). There's no desktop notification inbox, no quota/usage view, no browser-gateway approvals beyond escalation pushes, no way to continue or resume a past session, no automations, and no Plan Queue answers. | parity inventory (entry points confirmed to exist) | Verified (files exist); wiring not yet designed |
| F23 | **The phone cannot steer the active turn.** Mobile `POST /input` deliberately queues transient/busy input and the composer exposes only Stop plus ordinary Send. The desktop has a distinct steering path through `InstanceManager.steerInput`, including attachment support and active-turn interruption semantics, but the Mobile Gateway and phone UI do not expose it. | `mobile-gateway-instance-routes.ts`; `conversation-composer.component.*`; `instance-manager.ts` | Verified (code) |

**Findings from the audit agents that I rejected after checking** (recorded so nobody
re-raises them):
- "The App Lock toggle is not wired." It is: `hosts.component.ts:133, 210-221`.
- "The approval sheet stays pending forever after a host switch." The `finally` block in
  `approval-presentation.store.ts` `decide()` clears `pending`.
- "The gateway spec is 142 lines with no WS integration test." It is 2,068 lines.
  WS coverage is judged in M0.4, not assumed.

### 2.4 Constraints that shape the plan

- **Size ceilings (F21).** Extraction comes first in every phase that touches these files.
  `check:ts-max-loc` also scans `apps/mobile` even though root `tsc` excludes it.
- **The live Harness must not be restarted** while it has live sessions. Gateway runtime
  checks use a separate dev app bound to `all` with loopback pairing (memory: dev-app mobile
  gateway firewall).
- **DTO changes must be applied to both copies** until M0.3 lands.
- **Browser-based verification** of the preview build goes through the Browser Gateway on
  `windows-pc` by default (global routing rule). The Mac is used only if a preflight shows
  that worker is unavailable.
- **Native checks** (keyboard, Face ID, APNs, haptics, VoiceOver, Live Activities) can only
  be closed on a real iPhone. They go into a `_livetest.md` doc, never into claims of
  completion.

---

## 3. Decisions for James

**Answers recorded 2026-09-25** (from the review capture
`.aio-review/2026-09-25-mobile-app-improvement.decisions.json`):

| # | Decision | Answer | Effect on the plan |
|---|---|---|---|
| 1 | How builds reach the phone | **B: keep sideloading from Xcode**, and debug the iPhone 18 trust failure first | M1.2 is the sideload path. TestFlight is not built. |
| 2 | Commit the native iOS project | **A: yes** | M1.1 as written |
| 3 | New away-from-desk features | **All of a–h** | M4.a–M4.h are all in scope |
| 4 | Appearance | **A: follow the phone's setting, with an override** | M5.1 as written |
| 5 | Tighter phone permissions | **C: leave as is** | M6.1, M6.2 and M6.4 are dropped. M6.3 (transport hygiene; it does not change what a phone may do) stays. |
| 6 | iPad | **B: add a two-column iPad layout** | New item M5.9 |

The options as presented are kept below for the record.

Each item has a recommendation. Implementation follows the recommendation unless you pick
otherwise.

1. **How builds reach your phone.**
   - A. **TestFlight internal testing** (recommended). App Store Connect signs builds, so
     the "Unable to Verify App" problem on the iPhone 18 no longer applies, installs are
     over the air, and your phones stay in sync. This needs an App Store Connect app
     record for `com.shutupandshave.aiorchestrator`. Uploads use the API key Xcode already
     uses for export.
   - B. Keep sideloading from Xcode and debug the iPhone 18 trust failure first.
2. **Commit the native iOS project** (`apps/mobile/ios/App`, excluding `Pods/` and build
   folders), including the Live Activity widget target.
   - A. **Yes** (recommended; this is Capacitor's own guidance). Capabilities, signing
     team, deployment target, and the widget target become reproducible, and the four
     `ensure-*` patch scripts can mostly go.
   - B. No. Keep regenerating it and patching with scripts.
3. **New away-from-desk features** (choose any; recommended ones are marked ★):
   - ★ a. **Loop runs:** see progress (iteration, last result, elapsed time), and pause,
     resume, or stop a run. Push when a loop finishes or needs you.
   - ★ b. **One "Needs you" inbox across all paired Macs:** approvals, questions, finished
     sessions, and failures in one list, with the Mac shown on each item.
   - ★ c. **Usage at a glance:** how much quota each provider has left and when it resets,
     plus a push when a provider runs out.
   - ★ d. **Browser approvals:** approve or deny the browser actions an agent is waiting on
     (logins, form submits) without walking to the desk.
   - ★ e. **Continue a past session:** from History, reopen an archived session and keep
     talking. A hibernated session wakes when you open it.
   - f. **Automations:** see scheduled automations and their last run, and "Run now".
   - g. **Plan Queue:** see queued plans and answer their "needs you" questions.
   - h. **Doc review:** approve or reject items in review artifacts from the phone.
4. **Appearance.**
   - A. **Follow the phone's light/dark setting, with a manual override** (recommended).
   - B. Stay dark-only.
5. **Tighter phone permissions.**
   - A. **New sessions only in folders the Mac already knows about** (recent or pinned
     folders, or ones under a configured root), plus an activity log of actions taken from
     phones (recommended).
   - B. Also add a "view only" pairing type that can read and receive alerts but cannot
     send, approve, or stop.
   - C. Leave as is.
6. **iPad.**
   - A. **Not now** (recommended). Keep the phone layout, and make sure it doesn't break
     at iPad widths.
   - B. Add a two-column iPad layout (session list plus conversation).

---

## 4. Phases

Every phase ends with the verification in section 7. Each phase is independently useful,
and they are ordered so that tooling and correctness come before features.

### Phase 0 — Foundations: tooling, contracts, headroom

**Goal:** make later work testable and make room under the size ceilings. Nothing here
changes what the user sees.

**M0.1 Real component rendering in mobile tests.**
- Add the root repo's `angularJitPlugin()` (from the root `vitest.config.ts`) to
  `apps/mobile/vitest.config.ts`. It can be imported or, if the standalone package
  boundary blocks importing it, duplicated as a small local plugin.
- Prove it works by converting one text-assertion spec, `mobile-sheet.component.spec.ts`,
  to a real `TestBed.createComponent` render with signal inputs set.
- Accept: at least one component with `input.required()` renders in vitest. Keep the old
  text-assertion specs; convert them only where a phase touches that component.

**M0.2 Preview host fixture (committed).**
- Add `apps/mobile/scripts/preview-host/`: a small Node HTTP+WS server implementing the
  gateway contract from fixture JSON. It covers snapshot, messages (plain and `fromSeq`),
  prompts, queue, models, history, and pause. It also scripts scenarios: streaming, gap,
  disconnect, 401, and a 1,000-message transcript.
- Add `npm run preview` to start the fixture plus `ng serve`, and document pairing with the
  paste code the fixture prints.
- Accept: every screen in section 2.2 can be reached in a desktop browser at 375, 390, and
  430 px without a Mac gateway. The scenarios can be switched with a query flag.

**M0.3 One source for DTOs.**
- Move the phone-facing DTOs into a dependency-free module the phone can import, either
  `packages/contracts/src/types/mobile-gateway.types.ts` or a path the mobile tsconfig maps.
- If the standalone mobile build cannot import it cleanly, keep the copy and add a drift
  test in the root suite. That test parses both files' exported declarations and fails
  when a phone-used type diverges.
- Add the missing `seq?` and `MobileMessagesResumeDto` to the phone copy (F16).
- Accept: changing a field in the gateway type without updating the phone fails a test or
  typecheck.

**M0.4 Gateway extraction (headroom, F21).**
- Split `mobile-gateway-server.ts` by responsibility, keeping the existing handler-module
  pattern (`mobile-gateway-history-handlers.ts` and similar):
  - `mobile-gateway-instance-routes.ts` for input, respond, interrupt, terminate, rename,
    queue, and model
  - `mobile-gateway-prompt-store.ts` for prompt add/clear and user-action mapping
  - `mobile-gateway-events.ts` for attaching/detaching listeners, the status edge, and
    completion tracking
  - snapshot building and broadcast
- Lower the allowlist ceiling in `scripts/check-ts-max-loc.ts` to the new size (the ratchet
  only moves down).
- Before moving code, list which behaviours the 2,068-line spec covers through a real
  socket. Add a real-`ws` integration test for upgrade auth, snapshot on connect, output
  broadcast, and revoke-closes-socket if any of those is missing.
- Accept: no behaviour change, and the existing gateway specs pass unchanged.

**M0.5 Phone extraction (headroom, F21).**
- From `gateway-client.service.ts`, extract:
  - `transcript-store.ts` for the per-instance message store, append/replace/merge, and
    the seq and cursor state
  - `gateway-socket.ts` for the socket lifecycle, reconnect, and handshake diagnosis
  - keep REST commands in the client
- From `conversation.component.ts`, extract `conversation-composer.component.ts` (draft,
  attachments, dictation, send, queue notices) and a `transcript-view.component.ts`
  (rendering, scroll follow, tool groups).
- Accept: each file is under 450 lines, and every mobile spec passes unchanged apart from
  import paths.

**M0.6 Cleanup.**
- Remove the `$safeNavigationMigration(...)` migration leftover in
  `conversation.component.html:267`.

### Phase 1 — Device delivery and closing open device checks

**Goal:** a reproducible, installable build on James's phone, then close the 15 open
checks *before* new features, so regressions are easy to attribute.

**M1.1 Reproducible native project** (Decision 2).
- Commit `apps/mobile/ios/App` without `Pods/` or build output.
- Add the `HarnessWidgets` widget extension target, referencing
  `resources/native/HarnessWidgets/HarnessLiveActivity.swift` (F11). Set the deployment
  target to 16.0 (the MLKit requirement), and add the Push, Camera, Photos, Speech, and
  Face ID usage keys.
- Reduce the `ensure-*` scripts to those `cap sync` still needs.
- Accept: a fresh clone runs `npm ci && npm run sync && xcodebuild -scheme App -sdk iphoneos
  build` with only signing supplied.

**M1.2 Sideload delivery** (Decision 1B: keep sideloading from Xcode).
- First recheck the current state. The sideload status doc is a historical snapshot, so
  confirm the phone's connection with CoreDevice, which build is installed, and whether
  the "Unable to Verify App" alert still appears.
- If it does, get targeted evidence *before* changing signing. Capture the device console
  (`log collect` or Console.app streaming from the device, filtered to
  `installcoordinationd`, `online-auth-agent`, `amfid` and `trustd`) during a launch
  attempt. That shows which trust or verification check fails. Separate the likely causes
  with that evidence (certificate trust not granted on the device, the Apple verification
  service unreachable from the phone, a profile or entitlement mismatch) rather than
  guessing.
- Only then change signing or device settings. Any step that needs James's hands on the
  phone (Settings → VPN & Device Management trust, a reboot) is written up as an exact
  instruction.
- Add a scripted device build, `apps/mobile/scripts/build-device.mjs`: build, sync,
  `xcodebuild` for the connected device, then install and launch with `xcrun devicectl`.
  Document it in `apps/mobile/README.md`, and put the device and signing gotchas in
  `~/work/mobile-app-release-gotchas.md`.
- Accept: the current build installs and launches on the iPhone 18 from the script.

**M1.3 Close the open livetest docs.**
- Run both open livetest docs against the new build and record evidence in each doc.
- Any reproduced failure becomes an `LT-NNN` item in
  `docs/plans/livetest-remediation-register.md` per the runbook.
- These are James-on-device checks. The agent prepares the build, the fixture scenarios,
  and the step list, and records the results James reports.

### Phase 2 — Connection correctness (F1–F7)

**M2.1 Gateway-owned stream cursor** (fixes F1 and F2 together).
- The gateway keeps its own per-instance `streamSeq` and increments it only when it
  broadcasts an `instance-output` frame.
- It also sends `bufferIndex` (the message's position in `outputBuffer`) on every live
  frame, so a live frame and a replayed message share one cursor space.
- The phone keeps `lastBufferIndex` per instance. On a gap or reconnect it calls
  `GET /messages?fromSeq=<lastBufferIndex>` and merges the envelope. It does a full refetch
  only when `hasMore` is true or the instance's `adapterGeneration`/buffer has reset.
- Before implementing, reproduce: count `GET /messages` calls from the preview fixture and
  from a dev-app session during one normal tool-using turn. Record the count in the plan.
- Handle buffer trimming: if the output buffer is trimmed and indices shift, the gateway
  must detect it (for example by keeping a trim offset) and must not send a cursor that now
  points to a different message. See memory "prompt retention across buffer trims":
  identity is timestamp plus content, not ID.
- Tests: gateway unit test showing that non-output events do not advance `streamSeq`;
  phone unit test showing a mid-turn `status` event does not trigger a refetch; a gap
  triggers one `fromSeq` call; `hasMore` triggers a full refetch; an adapter respawn is
  handled.
- Accept: the refetch count per normal turn goes to 0 in the fixture's "no-gap" scenario.

**M2.2 Foreground and liveness (F3, F4).**
- Listen for `App.appStateChange` in `gateway-socket.ts`. When the app becomes active,
  send an app-level `{type:'ping'}` client frame and expect a `pong` server event within
  3 seconds. Otherwise tear down and reconnect immediately, then do a `fromSeq` catch-up
  for the open conversation.
- Add the `ping`/`pong` frames to both DTO copies (or the shared module after M0.3).
- Reconnect backoff: 1, 2, 4, 8, then a 15-second cap with ±20% jitter, reset on a
  successful open. The `unauthorized` path keeps its 30-second cadence.
- Show "Updated Xs ago" in the offline banner, driven by the time of the last server
  frame.
- Tests: fake timers for the backoff sequence; a resume with a dead socket reconnects; a
  resume with a live socket does not.

**M2.3 Push routing and lifecycle (F5–F7).**
- The gateway adds `hostDeviceId` (the device ID the phone got from `/pair`, which is
  already the phone's `PairedHost.id`) to every push payload. `respondFromPush` then routes
  by ID. It falls back to the name match only for older payloads, and it *never* falls
  back to the active or first host for an approval. On an unknown host it opens the app
  and shows the prompt.
- Handle a push tap for a session that has ended: show "This session has ended" with
  buttons for History and Projects.
- APNs: on `410`, or `400` with `BadDeviceToken`/`Unregistered`, clear that device's APNs
  token or that Live Activity token in the registry. Set `apns-collapse-id` per instance
  for Live Activity and status pushes. Throttle Live Activity updates per instance, for
  example to one every 15 seconds, so they stay within ActivityKit's push budget. Always
  send the final state. Check Apple's current guidance on the budget and priority when
  implementing.
- Tests: sender test with a stubbed HTTP/2 response of 410 that clears the token;
  routing test with two hosts of the same name.

**M2.4 Snapshot bandwidth (measure first).**
- Log the snapshot byte size and broadcast rate at debug level in the dev app for a
  10-session workload.
- Only if a snapshot exceeds about 32 kB or the rate exceeds 2 per second in steady state,
  add an `instance-state` delta path. The DTO already has the event type, and the phone
  ignores it today.
- Otherwise record "measured, not needed" here.

### Phase 3 — Long-session performance and conversation controls (F8, F9, F23)

**M3.1 Memoised message rendering.**
- Render markdown once per message ID and content hash inside the transcript store, or in
  a `computed` keyed per message, not from the template.
- Replace the global 300-entry LRU with per-transcript memoisation that is released when
  the instance is dropped.
- Test: rendering the same 1,000-message transcript twice calls `marked.parse` 1,000 times,
  not 2,000.

**M3.2 Windowed transcript.**
- Show the last 150 display items by default, with a "Show earlier" control that adds 150
  at a time.
- Apply `content-visibility: auto` with `contain-intrinsic-size` to message blocks.
- Keep the scroll anchor when earlier items are inserted.
- Add a gateway paging route, `GET /messages?beforeSeq=N&limit=100`, so History and very
  long live sessions can page beyond the 300-message replay limit.
- Test: the fixture's 1,000-message scenario. Record a Chrome performance trace at 390 px
  (preview build): the first render of the conversation is under 200 ms scripting on a
  4× CPU throttle, and streaming appends take under 16 ms each. Record the baseline before
  the change and the result after it.

**M3.3 Immutable-append cost.**
- Once windowing lands, re-measure `appendMessage` cost. Change the store to
  per-instance signals (so appending to one conversation doesn't notify every consumer of
  the transcript map) only if the trace shows it matters.

**M3.4 Steer the active turn.**
- Keep ordinary Send unchanged: while an instance is active, it queues the message.
- Add a distinct **Steer current turn** action, shown only for `busy`, `processing`,
  `thinking_deeply`, and `waiting_for_permission`. It is disabled while the phone is
  offline or another composer submission is in flight. Do not infer steerability from
  `isLooping` or offer it for transitional statuses.
- Add `MobileSteerRequest` and `MobileSteerResponse` to the shared contract and
  `POST /api/instances/:id/steer`. Extend `GatewayInstanceSource` with `steerInput`.
  The route calls `InstanceManager.steerInput` directly and must not pass through
  `MobileInputQueue` or the normal gateway `sendInput` path. This preserves the desktop
  semantics: an active turn is interrupted before the steering message is sent, while
  provider compaction is not interrupted and the message proceeds behind it. A status
  change between rendering the action and handling the request remains safe because
  `InstanceManager` owns the final status decision.
- Use one strict input-body validator for both `/input` and `/steer`: message at most
  500,000 characters, at most 10 attachments, attachment name at most 500 characters,
  MIME type at most 100 characters, declared size at most 50 MiB, plain-object
  attachments with correctly typed fields, and nonblank text or at least one attachment.
  The existing 8 MiB HTTP body cap remains the effective transfer-size limit. Never log
  attachment content.
- Steering uses the same text-and-attachment transaction as Send. On success, reconcile
  the optimistic message and consume the draft and attachments. On failure, remove the
  optimistic message and restore the composer state. Prevent duplicate submission.
- Tests: gateway authentication, missing instance, invalid and oversized bodies,
  attachment pass-through, exact `steerInput` invocation, rejection, and proof that the
  normal queue/send path is unused; client success and failure reconciliation; rendered
  status gating; distinct Send versus Steer behaviour; attachment consumption and
  restoration; and duplicate-submit protection.
- Runtime acceptance: during a real active provider turn, ordinary Send queues, while
  Steer interrupts and delivers exactly once. Verify the compaction case and one
  text-plus-attachment steering request. The physical-device/provider checks are recorded
  in the companion live-test document.

### Phase 4 — Away-from-desk features (Decision 3: all of a–h chosen)

Pattern for every item below:
- one gateway handler module (`mobile-gateway-<area>-handlers.ts`) calling the existing
  main-process service through an injected dependency, so it stays testable
- DTOs in the shared contract
- WS events only where live updates matter
- a phone feature folder under `features/<area>/`
- fixture support in M0.2
- gateway unit tests plus phone store tests plus rendered component tests (M0.1)

Service entry points were confirmed to exist on 2026-09-25. The exact methods must be read
before wiring.

**M4.a Loop runs.**
- Source: `src/main/orchestration/loop-coordinator.ts` (EventEmitter; iteration and state
  events) and `src/main/ipc/handlers/loop-handlers.ts` (the run list, by ID, and
  iterations channels already used by the desktop).
- Gateway:
  - `GET /api/loops` (active and recent runs: status, iteration N of max, last iteration
    summary, elapsed time, cost if available)
  - `GET /api/loops/:id`
  - `POST /api/loops/:id/(pause|resume|stop)`, calling the same coordinator methods as the
    desktop controls
  - WS `loop-state`
  - Push on completion, failure, or needs-review.
- Phone: a "Loop" card at the top of the conversation when `isLooping`, plus a Loops list
  reachable from Projects.
- Constraint: memory "ping-pong owns the only terminal path" and LT-538 (the resume
  setting does not gate loops). Stop and pause must call the coordinator's public control
  API, never flip status directly.

**M4.b Cross-host "Needs you" inbox.**
- Phone side only at first: a lightweight background probe of each non-active paired host
  (`GET /api/prompts` plus `GET /health`, every 60 s while the app is in the foreground,
  with backoff).
- The hosts list shows a real online state for each host (fixes F10).
- The inbox merges prompts and unread completions from all hosts, and each row switches
  host on tap.
- Push already works across hosts. After M2.3 its routing becomes ID-based.

**M4.c Usage at a glance.**
- Source: `src/main/core/system/provider-quota-service.ts` and
  `src/main/ipc/handlers/quota-handlers.ts` (quota-updated and exhausted events, and the
  pacing notification builder).
- Gateway: `GET /api/quota` (per provider: percentage used, window, reset time, whether
  exhausted) plus WS `quota-state`, and a push on the exhausted edge, rate-limited to one
  per provider per window.
- Phone: a compact usage row in the Projects header menu and a Usage sheet. In New
  Session, a warning chip when the chosen provider is exhausted.
- Note: `cost-tracker.ts` is available if James wants spend too. It is not included by
  default, because memory records that ACP cost entries are still empty.

**M4.d Browser approvals.**
- Source: `src/main/ipc/handlers/browser-gateway-handlers.ts` (list, approve, and deny
  approval-request channels) and the Browser Gateway service it wraps.
- Gateway: include browser approval requests in `prompts` as `kind: 'browser'` (new union
  member in both DTO copies), with site, action, and requesting instance. Respond through
  the existing approve and deny service methods.
- Phone: the approval sheet gets a browser variant. Credential entry, payment, and
  two-factor steps stay "Open on your Mac" and are never approvable from the phone. This
  matches the Browser Gateway rule that those go through manual steps.

**M4.e Continue a past session.**
- Source: the desktop resume path, `src/renderer/app/features/resume/` plus its
  main-process handlers (history restore) and `InstanceManager.wakeInstance`
  (`instance-manager.ts:1326`).
- Gateway: `POST /api/history/:id/continue` restores the session through the same service
  call the desktop resume picker uses, and returns the new or woken instance.
- Phone: a "Continue" button in History detail; opening a hibernated session shows
  "Waking…".
- Constraint: memory "native Claude import rewrites archives on relaunch" and
  "hibernated session had no wake path". Test on a copy of real history, never on James's
  live archives.

**M4.f Automations.**
- Source: `src/main/ipc/handlers/automation-handlers.ts` and the scheduler and runner in
  `src/main/automations/` (`getAutomationScheduler`, `getAutomationRunner`,
  `getAutomationStore`).
- Gateway:
  - `GET /api/automations` (name, schedule, enabled, next run, last run status and time)
  - `POST /api/automations/:id/run` calling the same run-now path as the desktop
  - push when a run fails
- Phone: an Automations list reachable from the Projects menu, with a "Run now" button
  that asks for confirmation. A run that starts an instance shows up in Projects as usual.
- Constraints:
  - respect `providersExcludedFromAutomation` (memory: Copilot work-pilot exclusion)
  - automations with no pinned model resolve to the favourite model when they fire
    (memory), so show the model that will actually be used
  - creating and editing automations stays on the desktop

**M4.g Plan Queue.**
- Source: `src/main/plan-queue/plan-queue-coordinator.ts` and
  `src/main/ipc/handlers/plan-queue-handlers.ts` (list, answer, control and diffstat
  channels).
- Gateway:
  - `GET /api/plan-queue` (items, state, current worker, needs-you questions)
  - `POST /api/plan-queue/:id/answer`
  - `POST /api/plan-queue/:id/control`, limited to pause, resume and cancel
  - WS `plan-queue-state` and a push when an item needs an answer
- Phone: a Plan Queue list and item detail showing questions with the answer controls and
  the diffstat.
- Constraints:
  - memory "plan queue feature": landing runs repo hooks, and its defects hide in crash
    and concurrency paths, so test the answer and control routes against concurrent
    desktop actions
  - landing and harvest stay on the desktop

**M4.h Doc review.**
- Source: `src/main/doc-review/doc-review-service.ts` and
  `src/main/ipc/handlers/doc-review-handlers.ts` (list, get, read-artifact and
  submit-decision channels).
- Gateway:
  - `GET /api/doc-reviews` for pending reviews
  - `GET /api/doc-reviews/:id` returning the review items and their options as structured
    data, not the HTML artifact
  - `POST /api/doc-reviews/:id/decision` taking the same payload the artifact runtime
    submits
- Phone: a native review screen, one card per review item, with approve/reject, the
  radio or checkbox options (memory: James won't type option letters), a comment field,
  and an overall verdict.
- Constraint: the decision payload must match the canonical feedback block exactly.
  Include a round-trip test from phone submission to the service's recorded decision.

### Phase 5 — Polish (F18, F19, deferred Wave 3)

**M5.1 Appearance** (Decision 4).
- Add a light token set in `styles.scss`, `color-scheme: light dark`, and a
  `prefers-color-scheme` default with an in-app override (System / Light / Dark) stored in
  Preferences.
- Run a contrast pass: WCAG AA 4.5:1 for text and 3:1 for UI, checked by an automated
  contrast script over the token pairs.
- Set the status bar style with `@capacitor/status-bar` if it is already a transitive
  dependency. Otherwise ask before adding a package.

**M5.2 Dynamic Type.**
- Base font on `-apple-system-body` (`font: -apple-system-body` on the root) with rem
  sizing everywhere.
- Check the 200% text-size case already listed in the 09-15 livetest.

**M5.3 In-app dialogs.**
- Replace `confirm()`/`prompt()` with `MobileSheetComponent` variants: a confirm sheet
  with a destructive style, and a rename sheet with a text field. These are testable with
  M0.1.

**M5.4 Pull to refresh** on Projects, Sessions, History, and Conversation. On
Conversation it triggers the `fromSeq` catch-up.

**M5.5 Keyboard.** Blur the textarea after send when the send was a button tap (not a
hardware-keyboard shortcut). Keep the composer above the keyboard using
`visualViewport` resize.

**M5.6 Pinned projects** (deferred Wave 3). Pin per host, stored in Preferences, with
pinned projects shown first.

**M5.7 Transcript search** within a conversation. It is client-side over loaded items,
with "search earlier" using the M3.2 paging route.

**M5.8 Accessibility.** Give the "New output" pill a polite live-region announcement and
announce connection-state changes. Run an automated axe pass on every fixture screen
(in-browser, preview build). VoiceOver checks go to the livetest doc.

**M5.9 Two-column iPad layout** (Decision 6B).
- At widths of 768 px and up, show a split view: the project and session list on the
  left (about 320–380 px) and the selected conversation, or the History, Loops or review
  detail, on the right. Below 768 px, including iPad Slide Over and narrow Split View,
  keep the current single-column phone layout.
- Build it as a shell layout component that hosts the existing list and detail
  components, reusing the M0.5 extractions. Do not fork the screens. Routing stays
  URL-driven, so deep links, push taps and the saved resume route open the right pane.
- Handle both orientations, Stage Manager resizing (width changes at runtime), a hardware
  keyboard (⌘↩ to send already exists; add ↑/↓ to move through sessions and ⌘N for a new
  session), and pointer hover states.
- Native side: the local Xcode project already targets iPad (`TARGETED_DEVICE_FAMILY =
  "1,2"`), so today the iPad gets the stretched phone layout. When the project is
  committed (M1.1), keep that setting, and confirm the iPad orientation keys
  (`UISupportedInterfaceOrientations~ipad`) allow all four orientations and
  multitasking. Keep the phone's current orientation settings.
- Tests: rendered layout tests at 768, 1024 and 1366 px (M0.1), and fixture screenshots at
  those widths in both orientations. On-device iPad checks (Split View, Stage Manager,
  keyboard) go into the livetest doc.
- Risk: an iPad on the same Apple ID gets its own device token and APNs token. Pairing and
  push already handle devices separately, so an iPad pairs like a second phone.

### Phase 6 — Security hardening (Decision 5C: permissions left as they are)

James chose to leave phone permissions unchanged, so these items are **declined and will
not be built**:
- M6.1: restricting new sessions to known folders
- M6.2: a phone action log
- M6.4: view-only devices

Their findings (F20) remain accurate and are left on record here.

M6.3 below does not change what a paired phone may do. It removes the token from URLs and
narrows CORS, so it stays in scope as transport hygiene.

**M6.3 Token out of the URL.**
- Authenticate the WebSocket with the `Sec-WebSocket-Protocol` header
  (`aio.v1, bearer.<token>`), which browsers can set. The query form stays for one release
  for older installs, and the gateway strips `token` from any logged URL.
- Restrict CORS to the Capacitor origin (`capacitor://localhost`) plus the `ng serve` and
  fixture origins when the gateway is in dev mode.


---

## 5. Parity reference (desktop capability → phone status)

| Capability | Phone today | Plan item |
|---|---|---|
| Sessions: read, send, steer, queue, stop, close, rename, model | Active-turn steering missing | M3.4 adds steering; Phases 2–3 improve reliability and performance |
| Approvals (tool permissions, orchestration questions) | Yes | M2.3, M4.b |
| New session (recent folders, provider, model, effort) | Yes | Unchanged (M6.1 declined) |
| History (read) | Yes | M4.e adds Continue, M3.2 paging |
| Global pause | Yes | none |
| Loop runs | Status flag only | M4.a |
| Browser approvals | Escalation push only | M4.d |
| Quota / usage | No | M4.c |
| Hibernated wake / continue past session | No | M4.e |
| Automations | No | M4.f |
| Plan Queue | No | M4.g |
| Doc review | No | M4.h |
| iPad layout | Phone layout stretched | M5.9 |
| Remote worker nodes, file explorer, diffs outside approvals, worktrees, MCP, codemem, settings | No | Out of scope: desktop-only by design (2026-05-30 plan) |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| The M2.1 cursor change breaks resync for installed phones | The gateway keeps sending the old `seq` field alongside the new fields for one release. The phone prefers the new fields when present. |
| Buffer trimming makes the index cursor ambiguous | Trim offset in the gateway; content-plus-timestamp check on merge; test with a trimmed buffer. |
| Committing `ios/` collides with the global git-protect hook (as `angular.json` did) | Check the hook before M1.1. If it blocks, ask James before changing hook config. |
| Phase 4 features need desktop services that are not yet safe to call remotely | Each item reads the service first and records its concurrency and rate rules. Stop and pause only go through public control APIs. |
| The iPhone 18 trust failure has no fix reachable from Xcode (Decision 1B keeps sideloading) | Evidence first (M1.2). If the device logs show the failure is outside our signing (for example, Apple's verification service unreachable from the phone), report that with the evidence and offer TestFlight again as the fallback. Do not switch without James. |
| iPad split view doubles the layouts to verify | One shell component over shared screens; rendered tests at three widths; iPad on-device checks in the livetest doc. |
| Device checks stall because the phone isn't available | Phase 1 comes first. Everything else is verifiable through the fixture and the dev app, and native checks are deferred into a livetest doc. |
| Concurrent loop agents edit this repo (memory: concurrent loop-writer hazard) | Check for in-repo writers before each phase. Never `git stash`. |

---

## 7. Verification (per phase)

1. **Targeted tests while working:** `npm run test:quiet -- <spec>` at the root for gateway
   specs, and `cd apps/mobile && npm run test:quiet` for the phone.
2. **Phone gates:** `npm run typecheck`, `npm run test:quiet`, `npm run lint`, and
   `ng build` in `apps/mobile`.
3. **Root canonical checklist** (AGENTS.md), including `check:ts-max-loc`, which covers
   `apps/mobile`: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
   `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and
   `npm run test:quiet`.
4. **Fixture UI check:** the preview build plus fixture on `windows-pc` via the Browser
   Gateway, with screenshots at 375, 390, and 430 px for every changed screen. Include the
   performance trace for Phase 3.
5. **Gateway runtime check:** a dev-app instance (not the live Harness) with the gateway
   bound to `all`, a synthetic paired client, and the exact scenario for the phase (for
   example, counting `/messages` requests per turn for M2.1).
6. **Device checks:** added to a new `2026-09-25-mobile-app-improvement_plan_livetest.md`
   with steps, expected result, and why it needs a device.
7. **Fresh-eyes gate:** an independent `task-completion-gate` review per phase. Fix, then
   re-review until PASS.

---

## 8. Document lifecycle

- This plan stays untracked while work is active.
- After every chosen item is implemented and verified, update the as-built notes, move any
  device-only checks into the `_livetest.md` doc, and rename this file to
  `2026-09-25-mobile-app-improvement_plan_completed.md` last.

## 9. As-built notes

- Phases 0 and 1 are implemented and independently passed the completion gate. Physical iPhone
  assertions remain explicitly deferred in the companion `_livetest.md` document because both
  registered phones were unavailable during the 2026-09-25 preflight.
- Phase 2 is implemented, every agent-runnable gate passes, and the independent fresh-eyes
  completion review returned `VERDICT: PASS`. Physical iPhone-only checks remain explicitly
  deferred in the companion `_livetest.md` document. M2.1 reproduced one false full-refetch from a
  provider-sequence skip; the corrected no-gap scenario makes zero transcript requests and real
  gaps use one incremental `fromSeq` request. M2.4 measured a ten-session snapshot at 3,986 bytes
  and 2 broadcasts/second, below both thresholds, so the full-snapshot protocol remains.
- Phase 3 is implemented and its final independent fresh-eyes completion review returned
  `VERDICT: PASS` with no unresolved actionable findings. M3.1 uses released, per-transcript
  markdown memoisation. M3.2 renders a 150-display-item window with authenticated backwards paging,
  stable timestamp/tool-group/all-rekeyed scroll anchors, settlement-safe paging ownership, and
  authoritative-coverage checks that replace disjoint cached prefixes after a refresh. M3.3 retained
  the immutable transcript map because measurement showed append mutation was not the bottleneck.
  M3.4 provides the separate, strictly validated Steer transaction while preserving ordinary Send
  queueing and optimistic draft/attachment recovery.
- Phase 3's final 390 px, 4× CPU trace measured 156.569 ms initial scripting and 4.604–8.210 ms
  append/render samples. All 436 mobile tests, the fresh review's 91 focused tests, and 151 focused
  gateway tests passed. TypeScript, spec TypeScript, lint, LOC ratchet, main build, and renderer build
  passed. The first full-suite invocation under Node 26 failed only the two SEA-fuse environment
  checks; with the repository's `.nvmrc` Node 24, the canonical suite passed 2,234 files / 26,674
  tests (`_scratch/test-run.pid-20310.log`). Physical-device/provider steering and iPhone checks
  remain explicitly deferred in the companion `_livetest.md` document.
- Phases 4, 5, and 6 (M6.3 only) are implemented in the gateway and the phone. Loops, Plan Queue,
  doc review, browser approvals, and history continue/wake go through the desktop services.
  Credential, payment, and identity browser steps stay Mac-only. The phone WebSocket sends
  `Sec-WebSocket-Protocol: aio.v1, bearer.<token>` and the query token remains accepted for one
  release. Appearance follows System, Light, or Dark without a new status-bar package. Device
  checks for these phases are in the companion `_livetest.md` (sections 7 and 8). A jsdom axe
  pass of the rendered route screens is `apps/mobile/src/app/accessibility-axe.spec.ts` (11 screens,
  WCAG 2 A/AA, color-contrast excluded because jsdom does not compute used colors; that pair check
  is `apps/mobile/scripts/check-appearance-contrast.mjs`). The in-browser preview axe and VoiceOver
  stay in the livetest doc. Desktop `tsc --noEmit`, `typecheck:spec`, lint, the file-size ratchet,
  `build:main` / `build:renderer`, and the full suite passed (`_scratch/test-run.pid-89490.log`,
  2244 files / 26820 tests). Mobile typecheck, lint, and the axe spec passed. A later review
  found two defects: history continue kept the `inst:` / `chat:` list prefix, and a finished
  wake left the header on Waking…. Continue now restores the unprefixed instance-history id
  and refuses chat records; wake clears only for the generation that is still current.
  Those fixes passed `mobile-gateway-away-handlers.spec.ts` and
  `conversation.render.spec.ts` (`mobile-tests-81339.log`, 24 tests). The fresh completion
  review then returned VERDICT: PASS.
