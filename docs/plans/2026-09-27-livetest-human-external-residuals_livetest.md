# Consolidated Human / External Live-Test Residuals

## Status — 2026-09-27

Open: 28 · Closed: 0 · Failed: 0 · Retired duplicate: 1

This document consolidates the small number of residual checks that cannot be completed safely by
an autonomous agent because they require explicit production-change authority, human judgment or
an unavailable external system. Source live-test documents link to the exact residual moved here.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching active remediation implementation record. A pending or unrun
> check is not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in the owning live-test file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

## Prerequisites

- Use the current rebuilt coordinator and deployed `windows-pc` worker.
- Confirm `windows-pc` is online and Browser Gateway health reports its extension channel ready.
- Preserve the current worker config before mutating it so the single root can be restored if the
  post-removal upload fails.

## RES-001 — Remove the Windows worker browser-upload safety-net root

**Source:** [Worker ↔ Controller File Movement live test](2026-07-16-worker-controller-file-movement_livetest_completed.md), former check 7.

**Why this remains:** the 2026-09-27 agent run proved automatic coordinator→`windows-pc` upload
staging works while the safety-net transfer root is present. Removing a root from James's live
worker file-transfer configuration is a production mutation and needs his explicit sign-off; the
test must then prove the root is genuinely unnecessary.

**Current state:** `windows-pc` still declares the `browser-uploads` transfer root labelled
“Browser upload staging (safety net until fix confirmed live)”. The live Browser Gateway upload
probe succeeded and selected the exact staged filename on the remote page without submitting it.

**Authorised steps:**

1. Record the current `browser-uploads` root definition for rollback.
2. Remove only that safety-net root from `windows-pc`'s file-transfer config; do not change any
   other worker root.
3. Restart/reload only the worker service if the config mechanism requires it.
4. From the coordinator, call `browser.upload_file` on a harmless file against a disposable shared
   tab on `windows-pc`.
5. Verify the file control reports the exact filename, the audit outcome is `succeeded`, and no
   `browser-uploads` root was reintroduced.
6. Close only the disposable tab and delete the harmless local source file.

**Expected:** upload staging uses `<workingDir>\_scratch\aio-browser-uploads`; the browser input
receives the file and the audit succeeds with no dedicated safety-net transfer root.

**Rollback:** if staging fails, restore the exact saved root definition, verify worker health, and
record the failure as a new LT item before attempting a code change.

## RES-002 — Authenticated SPA stale-session and save-rejection detection

**Source:** [Browser Gateway reliability live test](2026-07-17-browser-gateway-reliability_livetest_completed.md), former check 4.

**Why this remains:** the check deliberately takes an authenticated, stateful form offline mid-edit
and then attempts a write after connectivity returns while the application's stale/save-failed banner
remains. Running that against one of James's real logged-in business tabs could lose or corrupt work.
The Browser Gateway has no safe way to create a throwaway authenticated account, and its shared-tab
driver does not expose per-tab network emulation. A disposable authenticated SPA session and explicit
approval for the network cut are therefore required.

**Required setup:** James supplies or authorises creation of a throwaway authenticated account on a
SPA with a save-on-type form and a reliable disconnected/save-failed state. A sandbox Google Ads
account is suitable; no live campaign or production data should be used.

**Authorised steps:**

1. Open a disposable form in the throwaway account and record the shared tab's `profileId` and
   `targetId`.
2. Enter harmless disposable data and confirm the page is in a clean, saved state.
3. Cut that machine's network until the SPA visibly reports disconnection or failed saving.
4. Restore the network but leave the stale/save-failed banner present.
5. Attempt `browser.type` into the disposable field.
6. Run `browser.write_journal` for the target and `browser.assert_persisted` for the attempted value.
7. Restore/delete the disposable data and close only the throwaway tab.

**Expected:** the write never reports success. It is refused with
`browser_target_session_stale` before dispatch or fails with `browser_target_save_rejected` after the
sentinel scan. The journal records the failed verdict, and `browser.assert_persisted` returns
`persisted: false` with the matched stale/save-rejected pattern.

**Failure handling:** if the write reports `succeeded`, preserve the audit and journal identifiers,
restore the network and disposable data, then register a new LT defect before any code change.

## RES-003 — Packaged Harness provider sign-in launcher and interactive login

**Source:** [In-session auth repair live test](2026-07-21-in-session-auth-repair_livetest_completed.md), former check 2.

**Why this remains:** only the signed packaged `Harness.app` can prove that macOS Automation consent
allows that application to control Terminal. Completing the check then requires a real interactive
provider OAuth/TTY login and credential handling. An agent shell or unpackaged Electron process has
a different TCC identity and cannot establish the packaged-app behavior; Computer Use cannot control
Terminal or type credentials.

**Required setup:** a deliberately signed-out provider that James is willing to sign back into, with
the packaged Harness build running. The existing fake-`HOME` dev evidence must not be treated as a
substitute for the packaged app's TCC identity.

**James steps:**

1. In packaged Harness, open **Doctor → Provider Health** and confirm the chosen provider shows the
   authentication-missing remediation and an enabled **Sign in** button.
2. Press **Sign in** and handle any macOS Automation consent prompt for Harness controlling Terminal.
3. Confirm Terminal opens already running the provider's documented login command (for Claude,
   `claude auth login`) and Harness reports that the terminal was opened.
4. Complete the provider login in Terminal.
5. Return to Harness and press **Refresh** in Provider Health.

**Expected:** the correct command is already running in Terminal; after successful login, Refresh
re-probes the provider and clears the authentication warning without restarting Harness.

**Failure handling:** capture the exact Harness banner/Doctor state and whether macOS denied the
Automation event; do not paste credentials or terminal output into the remediation record. Register
a new LT item only if the packaged-app launch or refresh behavior fails after login succeeds.

## RES-004 — Local Chrome shutdown fast-fail

**Source:** [Local + remote shared-browser control live test](2026-07-22-local-shared-browser-control_livetest_completed.md), former check 3.

**Why this remains:** the check must quit James's real shared Chrome, which drops the native-host
connection for every concurrent AIO session and can disturb open tabs. It therefore needs an
explicit exclusive window with no other Browser Gateway work in progress.

**Authorised steps:**

1. Confirm no other AIO session is using local shared Chrome and that its tabs are recoverable.
2. Quit Chrome entirely.
3. Time `browser.find_or_open { computer: "local", url: "https://example.com" }`.
4. Reopen Chrome, reload the Harness extension if needed, and verify `browser.health` returns the
   local extension to `ready`.

**Expected:** the call returns well under 90 seconds with
`browser_local_extension_unreachable (<state>: …)`, repair text, and “did NOT run — safe to retry
once repaired”, rather than waiting about 90 seconds for a generic command-delivery failure.

## RES-005 — Local shared-tab discovery and preflight

**Source:** [Local + remote shared-browser control live test](2026-07-22-local-shared-browser-control_livetest_completed.md), former check 4.

**Current evidence:** the negative isolation half passed on 2026-08-12: a forced local target refresh
returned no targets while an unshared real-Chrome tab remained open. On 2026-09-27 local extension
health was `ready`, but no tab was shared and the bounded Chrome input grant expired without approval.

**James-assisted steps:**

1. In local Chrome, use the Harness extension popup to share exactly one harmless logged-in tab.
2. Run `browser.list_targets { computer: "local", refresh: true }` and
   `browser.preflight_target { url: <shared URL>, computer: "local" }`.
3. Unshare the tab immediately after recording the result.

**Expected:** only the shared tab appears, with `driver: "extension"` and no `nodeId`; preflight
selects `channel: "local-extension"`, `computer: "local"`, and `usesRealUserSession: true`. No
unshared tab is exposed. A managed profile at the same URL, if present, appears only under
`rejected` with `managed_profile_is_not_the_user_session`.

## RES-006 — Computer Use multi-window activation

**Sources:** [Local + remote shared-browser control live test](2026-07-22-local-shared-browser-control_livetest_completed.md), former check 5; [Computer Use Consent And Targeting live test](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest_completed.md), former check 4; [Computer Use Autonomy Level live test](../superpowers/plans/2026-08-26-computer-use-autonomy-level_livetest_completed.md), former checks 3, 4 and 6; [Session-Scoped Computer Use Autonomy live test](../superpowers/plans/2026-08-26-session-scoped-computer-use-autonomy_plan_livetest_completed.md), former check 3.

**Current evidence:** on 2026-09-27 `computer.health` reported healthy macOS capture,
Accessibility and input capability with no setup actions, but Chrome had only one visible window.
The bounded `observeAndInput` grant request expired without approval, so no desktop input occurred.

**James-assisted steps:**

1. Open two harmless Chrome windows on different monitors and approve an `observeAndInput` grant
   for Chrome.
2. Confirm `computer.list_apps` reports both window IDs and bounds.
3. Snapshot Chrome, activate the background window by its exact `windowId`, then take a fresh
   snapshot and click a harmless control in that window.
4. Verify an ID belonging to another app returns `computer_use_target_not_found` and that a denied
   app such as Terminal remains denied. Do not attempt to control Terminal.
5. In one uninterrupted sequence against a harmless allowlisted control, activate the approved
   background window, take a fresh accessibility snapshot, query the control and click it. Record
   activation-to-observation and observation-to-input timings from the audit log.
6. Repeat with a deliberate focus change to the other approved Chrome window between observation
   and input. Require the stale token/input to be denied by the active-app/window check; Harness
   must not silently reactivate the target or steal focus.
7. If Chrome exposes no harmless eligible control, try one additional ordinary non-denied app before
   treating this as a product finding. Never substitute Harness, Terminal, a provider app, System
   Settings or another hard-denied target.
8. With James setting the autonomy level to `trusted`, approve a bounded `observeAndInput` grant for
   a disposable TextEdit window. Snapshot/query a blank text field, then send Space and Enter with
   fresh observation tokens; require the visible character and newline.
9. In that same disposable app at `trusted`, send Cmd+Q and require
   `computer_use_sensitive_action_blocked`. Have James set `unrestricted`, take a fresh observation,
   repeat Cmd+Q and require only the disposable app to quit. Restore the prior autonomy level.
10. Reopen the disposable text field at `trusted`, type a runtime-generated non-secret high-entropy
    fixture, and immediately inspect the Computer Use audit row. Require the action to succeed, the
    stored `text` field to equal `[redacted]`, and the literal fixture to be absent from every audit
    field. Retain only a one-way hash for comparison; never paste the fixture into this document.
11. With two disposable live sessions, set one session's override to Unrestricted and start a
    deliberately slow but harmless observation against the approved fixture app. While it is in
    flight, return that session control to Global. Require the first audit row to retain the
    captured `unrestricted/session` decision, the next observation to use `trusted/global`, and
    both sessions/turns to remain alive with no sibling inheritance.
12. Revoke every Chrome/TextEdit fixture grant when finished and confirm global and session
    autonomy settings are restored.

**Expected:** activation returns `activated: true`, the requested `activeWindow`, and
`reobserveRequired: true`; the uninterrupted follow-up click succeeds without
`computer_use_target_not_active`; the deliberate focus change fails closed without silent
reactivation; the harmless-app hotkey and audit-redaction outcomes match steps 8–10. Terminal,
System Settings, password managers, provider apps and Harness remain hard-denied throughout and
must never be requested as fixture targets.

## RES-007 — ProContract withdrawal flow

**Source:** [Local + remote shared-browser control live test](2026-07-22-local-shared-browser-control_livetest_completed.md), former check 8.

**Why this remains:** secure automatic relogin to the authenticated ProContract account succeeded,
but the requested tender, “Website design, development and Hosting 2026”, was absent from exact,
`Website`, and `Hosting` opportunity searches even with expired and withdrawn records included. The
available original response is ERSP1073223 / ERFX1008859, “Dedicated Housing Tenant Website”, which
is a different Cardiff Council tender. The tab was restored to that response. The local conversation
ledger had no match for the requested title, and targeted historical-session search found no portal
URL attached to the named breadcrumb.

**Required input:** James identifies the correct ProContract account, opportunity URL/reference, or
corrected tender title. Do not act on ERSP1073223 / ERFX1008859.

**Steps once identified:**

1. Preflight and open the identified opportunity on `windows-pc` using the authenticated shared tab.
2. Navigate to “PA23 - 07A - Publish Tender Pack (Auto Invite)” and read the control that
   distinguishes stopping notifications from withdrawing interest.
3. Go only as far as the final withdrawal control. Do not send free-text messaging.
4. Use the Browser Gateway destructive-action approval flow. After approval, retry with the same
   request ID and verify the action executes exactly once.

**Expected:** breadcrumb navigation is not falsely blocked as sensitive; the final control yields one
approval request; the approved retry executes once; the portal then visibly reports the opportunity
as withdrawn.

## RES-008 — Discord bot mobile-parity campaign

**Sources:** [Discord bot mobile-parity live test](2026-07-23-discord-bot-parity_livetest_completed.md), former checks 1–10; [Sibling-Audit Round 2](2026-07-30-sibling-audit-round2_livetest_completed.md), former A5 and B8/C8 residuals.

**Why this remains:** the production bot is connected and freshly registered 21 slash commands on
2026-09-27, but every assertion starts with an inbound message, button click or reaction from
James's allow-listed Discord identity. The app's outbound API cannot simulate an allowed inbound
sender. No Discord message was posted during the autonomous campaign.

**One-sitting sequence:**

1. DM the bot `hi` with no project pin. Confirm the new session uses a recent project or home as its
   working directory, never `/`; there is no repo-map maximum-call-stack error or roughly 36-second
   spawn delay.
2. Trigger an approval or question. Confirm Approve/Deny or option buttons appear. Approve once and
   verify the agent resumes, the message becomes `✅ Approved`, and the ephemeral confirmation
   appears. Repeat and reply `no` to verify denial; exercise one option button too.
3. Trigger an approval on the first turn of a brand-new instance and verify the buffered prompt is
   delivered after the reply stream begins rather than being lost.
4. Send a several-second prompt. Verify 👀 on receipt and ✅ only once the instance is idle. Force a
   failing turn and verify ⚠️ instead of ✅.
5. Request a harmless generated file/image and verify exactly one real Discord attachment, with no
   duplicate on later chunks.
6. Save the current `channelToolHeartbeat` value, enable it, run a tool-heavy turn longer than 30
   seconds, and verify one throttled “🛠️ still working… (running X)” line. Restore the original
   value and verify the heartbeat disappears.
7. In a DM with `notifyOnAgentCompletion` enabled, run a turn longer than 20 seconds that emits no
   text and verify one `✅ Finished (…)` notification. A text-producing turn and a short turn must
   not receive the extra ping.
8. Park a non-YOLO session on a genuine deferred permission prompt, then send an inbound Discord
   message to that exact session. Verify its session-admission row is suppressed with an
   awaiting-human reason, nothing reaches provider stdin while parked, and the Discord write is
   delivered exactly once after the permission resolves.
9. With `channelToolHeartbeat` enabled, run a tool-heavy Discord turn longer than 30 seconds.
   Verify one evolving “Working…” draft is edited in place no more often than every five seconds,
   collapses to a one-line receipt immediately before the final answer, and never forms a message
   stack. A separate turn shorter than eight seconds must create no draft.
10. If WhatsApp remains configured, run the corresponding long turn there and verify it produces no
    progress draft. If WhatsApp is no longer configured, record that prerequisite rather than
    silently treating the negative assertion as passed.

**Cleanup:** restore both settings to their original values and leave no disposable instance or
attachment behind. Record per-step evidence before closing this residual.

## RES-009 — Microsoft Graph calendar connection and live round trips

**Source:** [Outlook / Microsoft 365 Graph calendar connector live test](2026-07-23-outlook-graph-calendar-connector_livetest_completed.md), former checks 2–5.

**Current state:** a 2026-09-27 read-only query of the production operator database found zero
connected Graph accounts. The business account needs a one-time delegated OAuth sign-in/consent in
James's authenticated browser; tokens and cache contents must never be copied into evidence.

**A. Connect the Community Tech account**

1. Call `graph_calendar_connect` and approve the one operator request.
2. Complete Microsoft consent as `james@communitytech.co.uk`. If the browser cannot open or consent
   is abandoned for five minutes, verify the operator-visible device-code fallback.
3. Call `graph_calendar_status` and `graph_calendar_list_accounts`.

Expected: the account appears with `tokenStatus: valid` and the scopes reported by MSAL; no access
token, refresh token, authorization header, secret or serialized cache is returned.

**B. Safe temporary create/read/delete**

1. Choose a 15-minute slot at least one hour ahead. Create `TEST - IGNORE - AIO Graph calendar live
   check` on `james@communitytech.co.uk`, in `Europe/London`, with no attendees.
2. Verify one operator approval produces exactly one event. List a bounded offset-bearing window and
   verify it appears once.
3. Delete it with one approval and verify it is absent from the same window.

Expected: the per-call `transactionId` prevents duplication and cleanup removes the event.

**C. Spark MI recurring reminder, only after James supplies/approves content**

James must first specify the exact subject, first start/end date-time, monthly pattern, recurrence
end, body, location and attendees. Present the full payload and whether invitations will be sent for
one approval; create exactly one series; then read back its subject, local time, timezone,
recurrence and attendee state.

**D. Optional personal-account compatibility, only after an explicit registration decision**

This is outside the current single-tenant work-calendar scope. If James later changes the Entra
registration to support personal Microsoft accounts and changes `graphAuthority` to the `common`
authority, connect `shutupandshave@hotmail.com` for read-only listing, then verify every mutation is
rejected locally while that family account remains absent from `graphAgentWritableAccountsJson`.
Never add the family account to the writable allow-list for work or personal agent reminders.

## RES-010 — Packaged macOS Computer Use permission ownership and repair

**Sources:** [Computer Use Permission Onboarding live test](../superpowers/plans/2026-07-11-computer-use-permission-onboarding-plan_livetest_completed.md), former checks 1–3; [Local macOS Computer Use Signing live test](../superpowers/plans/2026-07-13-local-macos-computer-use-signing-plan_livetest_completed.md), former steps 3–5.

**Why this remains:** the remaining assertions require a newly signed packaged Harness, a clean or
deliberately stale macOS TCC registration, System Settings permission prompts, and restarting the
packaged coordinator. Computer Use cannot control System Settings security panes, and resetting the
current grants would interrupt the app coordinating this campaign.

**One packaged-app campaign:**

1. Install the current signed arm64 package containing desktop-helper protocol 1.1.0 and the
   permission-repair controls. Use a fresh macOS user or, during an exclusive maintenance window,
   reset only Harness's Screen Recording and Accessibility decisions.
2. Enable Computer Use with both grants missing. Confirm the root banner appears, dismissal leaves
   the title-bar `Computer Use: 2 needed` chip, the chip opens Settings → Computer Use, and relaunch
   shows the banner again rather than persisting dismissal.
3. Use the banner actions for Accessibility and Screen Recording. Confirm macOS attributes both to
   **Harness**, never a raw temporary or `desktop-helper` path.
4. Exercise denied, granted and revoked states for both permissions. Refocus Harness after each
   System Settings change and confirm banner, chip and settings rows update without restarting.
5. Exercise exact-pane failure or rejection. Confirm fallback to the Privacy & Security root; if
   that also fails, confirm the in-app manual-opening error copy.
6. With a deliberately stale Harness registration, use **Repair permissions** in the banner and
   **Repair macOS permissions** in Settings. Confirm only Harness decisions are cleared, re-enable
   the new Screen Recording and Accessibility entries, then use **Restart AIO**.
7. After relaunch, confirm Screen Recording, Accessibility and Input synthesis all report **Ready**
   and the root warning is gone.

**Expected:** ownership belongs to the signed Harness app, every state transition refreshes in-app,
and stale registration is repaired entirely through Harness. If macOS exposes a raw helper entry or
the repaired build still reports a missing grant, capture that exact state and register a new LT
defect before changing code.

## RES-011 — Signed cross-platform N-to-N+1 auto-update release campaign

**Source:** [Harness Cross-Platform Auto-Update live test](../superpowers/plans/2026-07-11-harness-auto-update-plan_livetest_completed.md), all former live checks.

**Current external state (2026-09-27):** the repository has zero Actions secrets, zero `v*` tags,
zero GitHub Releases and zero `release.yml` runs; `package.json` remains `0.1.0`. The live tests
therefore have no signed N or N+1 artifacts. No updater defect was reproduced.

**Release prerequisites:** configure `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `WINDOWS_CSC_LINK`, and
`WINDOWS_CSC_KEY_PASSWORD`; bump `package.json#version`; push a matching stable `vX.Y.Z` tag; and
allow `.github/workflows/release.yml` to publish a public release whose assets pass
`npm run release:validate-assets`. A signed version N must already be installed on each target
before N+1 is published.

**Target matrix:** macOS arm64, macOS x64, Windows x64, Linux x64 AppImage and Linux arm64 AppImage.
On every target, create harmless durable settings/session/workspace/remote-node state and start a
long-running agent before publishing N+1. Verify automatic download and the global ready notice,
**Later** without restart, Settings still reporting ready, explicit **Restart to update**, the
install-on-normal-quit path on a separate run/machine, preserved data, and offline check failure
followed by a successful online retry.

**Trust checks:** on both macOS architectures run `codesign --verify --deep --strict`, Gatekeeper
assessment and stapler validation, and confirm both Electron and the Swift helper match the target
architecture. On Windows confirm Authenticode `Status: Valid` for both installed executable and
NSIS installer. On Linux launch the actual architecture-matched AppImage with `APPIMAGE` present
and confirm N+1 replaces and relaunches N through the AppImage update path.

**Completion evidence:** record release tags, OS/machine versions, exact artifact names, both install
paths and preserved-state results for every target. This campaign requires production release
authority and real target machines; it is not safe to synthesize with unsigned local packages.

## RES-012 — Decide Codex tool safety semantics

**Source:** [Codex Context-Pressure Controlled Reproduction live test](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest_completed.md), former §2.5.

**Verified evidence:** the full literal protocol passed on 2026-09-21 in a rebuilt isolated app
against a real authenticated Codex app-server. The live tool UI was continuously compared with the
exact disposable workspace, and a deliberate mismatch caused the real Stop control to yield one
terminal `turn-complete` with `completionStatus: interrupted`. LT-601 and LT-602 were subsequently
confirmed fixed live on 2026-09-24.

**Decision needed:** choose one product contract:

1. **Keep detect-and-interrupt (recommended).** Rewrite the old §2.5 wording to require continuous
   live target comparison and immediate Stop on mismatch. This matches the control that exists and
   has already passed end to end.
2. **Add pre-execution approval.** Implement a new Codex command/sandbox/rules/permission gate that
   reveals the exact target before execution and waits for approval.

**Why this is a real product decision:** `resolveCodexAppServerApprovalPolicy` currently disables
all of those approval categories except MCP elicitations; a target first appears in the UI while the
tool is already `phase: running`; and `yoloMode: false` selects Codex's read-only sandbox, which
blocks writes but does not confine reads to the workspace. Another live run cannot resolve which
contract James wants.

**Recommendation basis:** detect-and-interrupt is already shipped, bounded, and live-proven. A new
pre-execution gate changes provider semantics, UI, state handling and latency, so it should be a
separate feature only if James specifically wants that stronger interaction model.

## RES-013 — Physical-iPhone mobile queue, design, permissions and rendering campaign

**Sources:** [Mobile Queue / Stop / Draft Duplication live test](2026-07-25-mobile-queue-interrupt-draft_livetest_completed.md), former checks 1–10; [Sibling-Audit Round 2](2026-07-30-sibling-audit-round2_livetest_completed.md), former C2 mobile-parity residual; [Mobile design improvements](2026-09-15-mobile-design-improvements_livetest_completed.md), former checks 1–5. Later mobile live-test documents should add only non-duplicate device assertions to this campaign.

**Current state:** the production queue/interrupt/pause/attachment logic and REST/WebSocket paths
have passed live. The actual iOS app and Live Activity extension compile, but on 2026-09-25 both
`JL iPhone 17` and `JL iPhone 18` were unavailable to `xcrun devicectl`. A Simulator cannot prove
haptics, native confirmation dialogs, real device networking or the signed extension.

**Prerequisites:** connect and unlock `JL iPhone 18`, enable Developer Mode, keep phone and Mac on
the same tailnet, run the current gateway, then install the current app with
`cd apps/mobile && npm run ios:device -- --device "JL iPhone 18" --team "<Apple team ID>"` and pair
the device to the coordinator.

**One-device sequence:**

1. During a long Codex turn, send from the phone. Verify the composer clears, the queued strip and
   preview appear, no active-turn error appears, and delivery occurs after idle.
2. Queue three messages and verify strip order and one-turn-at-a-time delivery order.
3. Cancel a queued row with `×`; confirm it returns to the composer without being delivered.
4. Tap the composer Stop button while busy; confirm haptic feedback, “Stopping…”, temporary disable,
   interruption and idle settlement.
5. Invoke menu Stop while idle; confirm “Nothing to stop — this session is not running a turn.”
6. Stop twice during settlement; confirm the label changes to **Force-cancel (stop again)** and a
   native confirmation dialog prevents accidental escalation.
7. Queue a correction, then Stop; confirm the correction delivers immediately after recovery.
8. Pause from the phone, send to an idle session, then unpause; confirm queued-then-delivered flow.
9. Using a safe fixture or naturally failed delivery, confirm the row turns red with
   `Couldn't send: <reason>`, blocks later rows, and `×` clears it so the queue resumes. The old
   request for a production timing hook is closed: 30/30 production-class tests plus two ruled-out
   live mechanisms are accepted; do not add a shipped delay solely for this test.
10. Queue a photo attachment while busy; confirm the paperclip icon and eventual delivered photo.
11. Put disposable sessions into failed, error and degraded states. Compare Workboard and session
    picker urgency with the mobile badge and `needsAttentionCount`; verify the physical client
    includes all three states and reports the same count/priority as the coordinator.
12. In live-conversation and New Session composers, enter multiline text with Return and an IME;
    require no accidental send. Require physical Ctrl/Command+Return to submit once. With keyboard
    open, rotate both ways and open folder/model/attachment sheets; all actions, bounded textarea,
    safe areas and home-indicator spacing must remain reachable. Repeat at Larger Accessibility
    Sizes with no clipped decision or horizontal page scroll.
13. In both composers, add/remove/paste harmless photos, cancel the picker, deny permission and
    follow recovery advice. Start dictation, background/foreground, switch sessions and hosts, then
    resolve a delayed permission prompt; old speech must never enter the new draft. Return a queued
    text/photo message into an existing draft and exercise delayed-cancel/delivery races without
    duplicate sends or lost input.
14. With VoiceOver, traverse Projects, approvals, all option sheets and queue actions. Require useful
    names, selected/unread announcements and focus restoration. With Reduce Motion, require readable
    working/loading state, usable sheets, long titles and expanded long tool results.
15. Keep App Lock enabled. Background with a decision sheet open, cancel authentication and require
    complete visual/input coverage with no underlying activation. Unlock successfully and require
    the same sheet/draft to return with safe focus/navigation.
16. Pair a disposable host by QR and separately by pasted fresh code. Require endpoint/security
    review before Pair, masked tokens, manual setup and useful expired-code/device-token recovery.
    Deliver one real test notification and open it foregrounded, backgrounded and cold, including
    when another host was last selected; the correct host/request must open with a safe Back path.

**Evidence:** record device/iOS/build identifiers, per-step visible result, haptic/native-dialog
observations and cleanup. Restore pause state, leave no disposable session or attachment, and do
not expose device pairing secrets or signing credentials.

## RES-014 — Windows Chrome Harness tab-group lifecycle campaign

**Source:** [Browser Harness Group Lifecycle live test](../superpowers/plans/2026-07-26-browser-harness-group-lifecycle_livetest_completed.md), former checks 1–4.

**Current evidence (2026-09-27):** `browser.health` reports the `windows-pc` extension channel
ready on v0.2.36, and a refreshed target inventory reports live tab IDs, window IDs, indexes and
page state. The current Browser Gateway contract still exposes neither Chrome `groupId`/group title
nor a browser-chrome/tab-strip screenshot. `browser.screenshot` captures page content only. The
available Computer Use service reports a healthy coordinator-local macOS driver, not a Windows
desktop driver. The four visual assertions therefore remain unprovable without a bounded view of
James's Windows Chrome tab strip; no product defect was reproduced.

**Prerequisites:** approve a bounded Chrome observation/input session on `windows-pc`, use the
currently deployed v0.2.36 extension (or the then-current build), and crop evidence to the Chrome
window's top strip so page/customer content is excluded. Preserve all ordinary tabs and original
group assignments.

**One-window sequence:**

1. Open two harmless HTTP(S) tabs in one window. Run overlapping Browser Gateway operations against
   them and confirm both use one blue group titled **Harness**, with no duplicate chip.
2. Start from an ungrouped harmless tab, run one operation, let it finish, and confirm the tab is
   ungrouped and no Harness chip remains after the final controlled operation.
3. Put a harmless tab in a user-created group whose title is not `Harness`, run one operation, and
   confirm the tab returns to that exact original group after cleanup.
4. Deliberately stage at least two historical `Harness` group chips in the same window without
   closing or moving their tabs manually. Run one operation against a tab in either group. While
   active, confirm every historically grouped tab is consolidated into one canonical Harness
   group; after completion, confirm every tab remains open and ungrouped and no Harness chip
   remains.

**Expected:** one canonical temporary Harness group is reused during control, final cleanup removes
only Harness-owned grouping, original user grouping is restored, historical duplicates are
consolidated and cleaned, and no tab is closed. Record a cropped before/during/after capture for each
step and revoke the bounded Chrome grant afterward.

## RES-015 — Retired duplicate: LT-196 contract already implemented

**Not open; retained as a tombstone so completed source links stay valid.** The sibling-audit
transfer was generated from the pre-implementation LT-196 finding. The completed
[specification](../superpowers/specs/2026-09-06-lt196-correction-miner_spec_completed.md) selected a
provider-normalised, transcript-invisible `tool_outcome` record, and the completed
[implementation plan](../superpowers/plans/2026-09-06-lt196-correction-miner_plan_completed.md)
delivered it. The [live owner](../superpowers/plans/2026-09-06-lt196-correction-miner_livetest_completed.md)
records real Claude, Cursor and Grok correction scans passing.

No product-contract decision remains for James and the LT-196 spec must not be commissioned again.
Only the narrow ACP terminal-failure-with-no-renderable-output branch remains unobserved; it is
agent-runnable [AR-007](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-007--acp-no-output-terminal-failure-fallback).

## RES-016 — Real push and pull-request native approval round trip

**Source:** [Sibling-Audit Round 2](2026-07-30-sibling-audit-round2_livetest_completed.md), former B1 Gate 2.

**Known passed half:** the opt-in UI, refusal wiring and typed error copy passed. What remains is the
native Electron approval dialog around a genuine remote push and PR creation. Approval is an
external repository mutation and is not implied by this documentation campaign.

**Prerequisites:** James explicitly authorises a disposable repository/branch and remote, confirms
that creating and later deleting one test PR is acceptable, and is present to operate the native
dialog. Use no production branch or customer repository.

**One bounded sequence:**

1. Prepare one harmless commit on the authorised disposable branch and record the remote state.
2. Invoke PR creation. Confirm the native dialog defaults to **Cancel**; cancel once and require the
   typed `permissionDenied` result with no push, branch or PR created.
3. Invoke again and approve once. Require one approval to cover exactly one push plus one PR, return
   the PR URL, and record it as loop evidence when a disposable `loopId` is supplied.
4. In a separate unauthenticated `gh` fixture, require a clear `authRequired` result and no token or
   credential prompt.
5. Close the test PR and delete only the disposable remote branch under the same explicit cleanup
   authority.

## RES-017 — Guardian adjudication with a reachable auxiliary LLM

**Source:** [Sibling-Audit Round 2](2026-07-30-sibling-audit-round2_livetest_completed.md), former B3.

**Current external state (rechecked 2026-09-27):** the isolated current app has no configured
auxiliary endpoint; `ollama` is not on `PATH`; and `http://127.0.0.1:11434/api/tags` refuses the
connection. Earlier credential lookup found no auxiliary-model credential that could safely be
used for this campaign. No adjudicator defect has been reproduced.

**Prerequisite:** provide or authorise one disposable reachable auxiliary endpoint and model that
can be stopped during the test. Store credentials through the normal trusted resolver; never put a
raw key into this document, a command argument, a screenshot or test output.

**One bounded sequence:**

1. In an isolated rebuilt app, configure the endpoint only for the approval-adjudication slot and
   enable `approvalAdjudicationEnabled`; save the prior settings for restoration.
2. Run an unattended loop that raises a clearly low-risk deferred permission. Require automatic
   resolution with `resolved_by='adjudicator'` plus durable risk/reason evidence.
3. Raise a credential- or publish-shaped permission. Require it to remain human-only and verify no
   request content is sent to an ineligible fallback.
4. Stop the endpoint mid-run. Require pending/new asks to escalate to human without deadlock.
5. Produce three consecutive adjudicator denials. Require one breaker notification and human
   escalation for every later ask until a human decision resets the state.
6. Restore every setting, remove the disposable endpoint, terminate fixture sessions and confirm
   no credential value entered logs or evidence.

## RES-018 — Authorised Local AI Guard enrolment and duplicate refusal

**Source:** [Local AI Guard CLI live test](../superpowers/plans/2026-07-30-local-ai-guard-cli_plan_livetest_completed.md), former checks 2–3.

**Known passed half:** CLI parsing, authenticated parent RPC, discovery, full endpoint/model/inference
validation and validation-before-create passed. The earlier live validation completed in 640 ms with
both model and canary checks healthy.

**Current prerequisite state (2026-09-27):** `windows-pc` is online for Browser Gateway, but the
rebuilt app's auxiliary discovery exposes only unreachable localhost Ollama with zero models. The
live settings contain zero configured auxiliary endpoints; no local Ollama binary or listener is
available. Restore or advertise a compatible endpoint before attempting enrolment.

**Authority required:** the first `local-ai enrol` command reroutes eleven real auxiliary-LLM roles
in the live app. James must explicitly authorise that mutation and identify whether any pre-existing
target should be preserved. Do not infer permission from this documentation consolidation.

**One bounded sequence:**

1. Record the current Local AI Guard target list and routing state without exposing credentials.
2. From a fresh Harness-spawned agent with the injected `AIO_MCP` and authenticated RPC variables,
   run the saved `_scratch/lag-config.json` only after confirming its endpoint and exact two model
   IDs are currently advertised and healthy. Never print the injected variables.
3. Run `local-ai enrol` once. Require validation to repeat, exactly one matching target to be
   created, and the returned target/validation to match the requested endpoint, two models, eleven
   roles, timing/fallback policy and disabled automatic repair.
4. Run `local-ai list --json` and inspect **Monitoring → Local AI Guard** read-only. Require CLI,
   repository and UI to agree on the target ID and every non-secret configuration field.
5. Repeat the exact enrol command. Require a typed already-enrolled refusal, the same target ID and
   exactly one matching target after the attempt.
6. Under the same explicit authority, either retain the confirmed target or restore the exact prior
   target/routing state. Record the chosen cleanup; do not delete an unexplained target silently.

## RES-019 — MyTradeMail production Sentry, alert and Firebase IAM campaign

**Source:** [GitHub Actions remediation live checks](../superpowers/plans/2026-08-03-github-actions-remediation_livetest_completed.md), former checks 1–3.

**Known state:** the 2026-09-23 production deploy passed; the three deployed DSNs mapped to separate
Community Tech Sentry projects; and the dedicated SBE FCM sender account/key matched its Firebase
project. Those configuration observations do not prove live ingestion, notification delivery or
inherited IAM. Use the then-current production release, never historical workflow `30717081873`.

**One controlled production window:**

1. Through each app's normal reporting path, emit one synthetic non-sensitive error from the
   backend, MyTradeMail frontend and Simple Business Email frontend. Avoid user/payment data.
2. In the Community Tech EU Sentry organisation, require each event to appear only in its matching
   project (`mytrademail-backend`, `mytrademail-frontend`, or
   `simplebusinessemail-frontend`) with production environment, deployed release and expected
   frontend tags. Record event IDs and tags, never DSNs or tokens.
3. Confirm the backend payment, provisioning and global high-priority rules are enabled. Emit safe
   matching synthetic events, verify one intended notification per event, and have the owner
   acknowledge them. Record event/alert IDs and timestamps; compare with the 15-minute critical and
   30-minute high-priority runbook targets.
4. As an account administrator, inspect the effective IAM of the dedicated
   `MyTradeMail FCM sender`, including organisation/folder inheritance. Do not create or rotate a
   key. Require only the permissions needed to send FCM messages; record inherited role names and
   the effective conclusion without secrets.
5. Remove or resolve synthetic issues according to the production runbook and confirm no customer
   state was changed.

## RES-020 — Authenticated Copilot ACP long-running tool timeout

**Source:** [ACP Long-Running Tool Timeout live test](../superpowers/plans/2026-08-25-acp-long-tool-timeout_livetest_completed.md), former check 1.

**Why external:** two agent runs never reached an ACP tool call. Automation is deliberately barred
from auto-picking Copilot, and the later real user-originated preflight found the only resolved
profile unsigned. Interactive Copilot sign-in is the sole missing human prerequisite; neither
attempt is evidence for or against the timeout fix.

**Prerequisites:** sign a disposable Copilot profile in on this device, use a quiet host below the
campaign runbook's load threshold, and launch the rebuilt app in a disposable workspace. Keep the
provider choice user-originated; do not weaken the automation exclusion.

**Bounded sequence:**

1. Start a new authenticated Copilot ACP session and ask it to run this repository's
   `rtk npm run test:quiet` (or another safe 10–60 minute command with full output retained locally).
2. Confirm ACP `tool_call` activity appears, then send nothing and do not cancel for at least ten
   minutes.
3. Require no `ACP session/prompt request timed out after 600000ms`, no automatic
   `session/cancel`, and no “Operation cancelled by user” at the ordinary timeout boundary.
4. Confirm the command remains active past ten minutes, the repeating operator stall warning remains
   available, and Copilot reports the real command result before sixty minutes.
5. Record session ID, start/end timestamps and exit result without authentication material, then
   terminate only the disposable session/profile state.

## RES-021 — Two-account Copilot routing, attribution and worker binding

**Source:** [GitHub Copilot Account Routing live test](../superpowers/plans/2026-08-25-copilot-account-routing_plan_livetest_completed.md), former checks 1–9. Its account-independent menu checks 10–11 already pass.

**Current prerequisite state:** the rebuilt dev app reports no signed-in Copilot account. This
campaign needs two genuinely different Copilot-entitled GitHub identities (personal and
work/enterprise), OAuth consent for each isolated profile, and a corresponding work-profile login
on `windows-pc`. Never copy profile config contents; they may contain plaintext tokens.

**One ordered campaign:**

1. In **Settings → GitHub Copilot Accounts**, verify migration of the legacy profile, add an
   `Enterprise` work profile, and complete the work-account browser/terminal OAuth flow. Check both
   cards independently; require two different logins and separate profile directories.
2. Read only `lastLoggedInUser` from each profile config through a redacting helper and compare the
   two values with the UI cards. Emit no token or full config.
3. Map an authorised disposable work repository to Enterprise while a personal repository remains
   on the default profile. Start simultaneous Copilot sessions; require stable account chips and
   per-instance badges throughout.
4. Confirm provider-side attribution through `/user` or the two accounts' usage pages. Each turn
   must appear only under its intended identity.
5. Switch ambient `gh` and ordinary Copilot identities outside Harness, then repeat the two sessions.
   Require routing to remain pinned to the isolated profiles rather than host-global state.
6. In a disposable relaunch, set the six documented ambient token variables to obvious placeholders.
   Inspect the Copilot child through a redacting environment helper: none of the six may survive;
   `COPILOT_HOME`/host routing must remain correct; Doctor may name variables but never values.
7. Relaunch and restore both conversations, delete the work owner rule, then send to the restored
   work session. Require the existing session to retain Enterprise while a new session resolves to
   the default profile.
8. Redeploy the current worker agent to `windows-pc`. Before worker sign-in, require a mapped work
   session to park with the exact not-signed-in-on-this-node error and never fall back to another
   identity. Complete work-profile login on the worker, retry successfully, then perform one bounded
   reconnect and require the stamped profile to persist under the durable worker profile directory.
9. Run Verification Dashboard in the mapped work repository. Require the child config directory and
   `COPILOT_HOME` to point at Enterprise, ambient token names to be absent, attribution to the work
   account, and the accepted `Skipping Copilot server mode for a routed account session` log. If the
   SDK now supports an explicit config-directory option, reopen the documented server-mode decision
   instead of silently retaining the trade.
10. Restore all ambient account selections and disposable routing changes, terminate both sessions,
    and record only non-secret profile labels, login names, account attribution and worker state.

## RES-022 — Secure browser credential origin and escalation boundaries

**Source:** [Browser Gateway Secure Remote Credential Workflow live test](../superpowers/plans/2026-08-28-browser-gateway-secure-remote-credential_livetest_completed.md), former check 4. Later browser credential-login checklists should merge their non-duplicate assertions here.

**Known evidence:** the eager secure tool surface passed; a real extension-bound Meta preflight plus
an unauthorised register attempt failed closed with `credential_not_authorized`, `outcome:not_run`,
redacted audit and no grant/journal mutation. Focused automated coverage already exercises missing
grants, exact vault-bound origins and CAPTCHA/2FA/legal/ambiguous-submit escalation. The remaining
value is one end-to-end extension run, not another synthetic unit rerun.

**Prerequisites:** James authorises one disposable agent-owned credential and its exact throwaway
login origin, plus a second harmless origin that must never receive it. Use Browser Gateway secure
vault fill only; never expose the password through shell args, logs, screenshots or chat. Do not use
the real Meta/Instagram accounts as fixtures.

**One bounded sequence:**

1. With no authorization, call the relevant register/fill path and require a typed fail-closed
   result, `outcome:not_run`, redacted audit and no journal/grant mutation.
2. Authorise/create one agent-owned credential for the disposable origin through the supported
   approval flow. Confirm only an opaque vault reference returns.
3. Fill the exact authorised login origin through the secure extension path and verify persistence
   without reading the secret back.
4. Attempt the same vault reference on the second and a related-but-not-exact origin. Require local
   refusal before dispatch, no page write, and redacted failure audit.
5. On synthetic pages only, present CAPTCHA, 2FA/verification-code, legal-declaration and ambiguous
   submit states. Require the existing manual/escalation result and prove no blind retry or submit.
6. Remove the disposable account/authorization/vault item under the same approval authority, close
   only disposable tabs, and verify no secret appears in audit, journal or retained evidence.

<a id="res-023--reload-browser-gateway-v0237-and-confirm-lt-658-live"></a>

## RES-023 — Reload Browser Gateway v0.2.37 and confirm extension-bound fixes live

**Source:** [Browser Gateway unattended portal fixes live test](2026-08-28-browser-gateway-unattended-portal-fixes_livetest_completed.md), remaining disabled/readonly assertions from former check 3 / LT-658.

**Additional source:** [Browser secret observation recovery live test](2026-09-05-browser-secret-observation-recovery_livetest_completed.md), whose nine Windows checks pinned obsolete v0.2.19 assets and share this same reload/operator boundary.

**Additional source:** [Browser secret-observation protection-setting live test](2026-09-10-browser-secret-observation-protection-setting_livetest_completed.md), whose remaining popup, payload-propagation and authenticated Diamond assertions require the same extension reload plus operator-owned tab state.

**Additional source:** [Worker Stale-Socket Close Loop live test](2026-09-15-worker-stale-socket-close-loop_livetest_completed.md), whose coordinator storm reset and both operator/tool connection-reset paths passed; only the live Windows relay incident and human CAPTCHA solve share this extension/operator boundary.

**Known passed behavior:** the loaded v0.2.36 extension passed the same check's plain-`div`,
iframe-backed TinyMCE contenteditable and additive multi-select assertions. The reproduced
disabled/readonly mutation is fixed in both selector and accessibility-UID write paths. Manifest
v0.2.37 uniquely identifies the fixed bundle; the focused extension suites pass 148/148.

**Why this remains:** Browser Gateway can reload ordinary web pages but exposes no operation that
reloads an unpacked extension. Worker command execution is expressly barred from driving James's
shared Chrome. The source can be staged by an agent, but one click on the development extension's
**Reload Extension** popup action (or Chrome's extension reload control) must be performed by James.

On 2026-09-27 the current Windows preflight found the worker registered and running, but its
extension relay in `commands_unanswered`. A later sanctioned `browser.recover_extension` returned
`recovered` after 29.8 seconds and briefly changed the channel to `fresh`; the immediately following
`list_targets(refresh: true)` still timed out and returned only stale cached inventory. This is an
extension-channel incident, not evidence that `windows-pc` is down. Health also reported
secret-observation protection disabled with zero tainted origins/tabs, so there is no current
protected real tab to reset safely.

A later controlled CAPTCHA-page attempt began with the same worker channel reported `fresh`, but
`browser.find_or_open` timed out before the tab opened. Health then reported the channel `silent`
with unchanged coordinator and relay contact timestamps, and a sanctioned recovery timed out after
60.5 seconds. No page action was dispatched. This is further evidence that the extension reload is
the prerequisite, not a CAPTCHA-product failure.

**Bounded sequence:**

1. Stage the current `resources/browser-extension` bundle on `windows-pc` through the normal worker
   deployment path. Confirm `manifest.json` reports v0.2.37 and these SHA-256 values:
   `background.js` `7b8b2245d0afdae5191b565644a8e16a88334363e326f45df0a0c9b037da204f`,
   `popup.js` `7f7a8bcff590c2b0e755604aee062bfbe24c91ebaa2d24b2cd361707e432b0f9`,
   `popup.html` `07e52f076fbd92b3c6c87f5dedd0c7d3bc2105b2f26ca08de26c3238fe630410`,
   and `manifest.json` `a8470bbf184b397391d4b16a701f9c0bed7e45934671426f083dd978b9c02833`.
2. James reloads only the unpacked Harness Browser Gateway extension. Do not restart Chrome or
   close/navigate unrelated tabs.
3. Confirm the worker reports extension v0.2.37, a new extension start/reload time, fresh contact,
   and `registration: ok`.
4. Reload Selenium's public `web-form.html` fixture. Confirm the disabled input starts empty and
   disabled, and the readonly input starts with `Readonly input`.
5. Call selector-path `browser.type` on the disabled input and accessibility-UID `browser.type` on
   the readonly input. Require an explicit failure naming `<input>` and the relevant
   disabled/readonly state, plus the enabled/editable remedy.
6. Read both controls back. Require the disabled value still empty and the readonly value still
   `Readonly input`; no `input` or `change` effect may be reported.
7. Run `browser.preflight_target` with explicit `computer: "windows-pc"` against a harmless test
   page. Require the selected target to report the Windows node and normal command delivery.
8. Do not manufacture taint on James's real sites. If a genuinely protected test-only origin is
   already present, request one snapshot and require
   `browser_secret_observation_blocked_for_tainted_origin: command not run`, with no implication
   that a write may have applied. Otherwise record the zero-taint state and defer this branch until
   the next explicitly authorised test-only protected fill.
9. For a protected test-only origin only, James turns Browser Gateway off and reviews the popup's
   affected sites/tabs/data warning. If he approves **Reset secret protection**, require success
   while the gateway stays off and verify no cookies, passwords, sessions or site data were
   deleted. Turn the gateway back on and require a safe read to succeed.
10. In a disposable Windows test profile, induce one frame-inspection failure on an unrelated test
    tab while a test origin is protected. Require
    `browser_secret_inspection_unavailable: command not run` with no permanent unrelated-tab taint;
    after inspection recovers, the unrelated tab must read normally while the genuinely protected
    origin/iframe/opener remains protected.
11. With **Lock shared tabs after a credential fill** still OFF in Harness, run one harmless
    shared-tab command and confirm the v0.2.37 extension applies
    `secretObservationProtectionEnabled: false`, clears only its taint flags, and reports the
    disabled state back through health. Open the extension popup and require the protection-off
    message with no protected-origin list.
12. On an explicitly authorised disposable Diamond/ProContract login tab, use the secure
    `fill_credential` path. Immediately snapshot that same origin and require ordinary page content,
    not `browser_secret_observation_blocked_for_tainted_origin`.
13. Download one harmless test pack from that origin and require the download to succeed without a
    popup protection reset. Remove the test download and leave the account/session unchanged.
14. If health naturally reports `relay_not_forwarding` during this bounded campaign, record
    `relayContactAgeMs`, `coordinatorPollAgeMs` and `connectionFlap`, then call
    `browser.recover_extension`. Require `recoveryAction: "connection_reset"`, a newer
    `after.coordinatorPollAt`, and no native-host restart RPC. Do not downgrade the production worker
    merely to manufacture the incident; both explicit reset paths already passed live.
15. On the agent-served controlled v3-only page, click the ordinary button with action hint
    `Enable the reCAPTCHA Enterprise API`. Require the click to execute rather than park; the page
    must include only an invisible/badge marker, not a visible interactive challenge.
16. On the controlled visible-v2 page using Google's public test key, click an ordinary button and
    call `browser.evaluate` before solving. Require both to return `requires_user` with a CAPTCHA
    reason and no dispatch. James then solves the checkbox by hand; repeat the harmless click and
    require it to execute. Close only the two controlled tabs and remove the temporary local server.

**Pass:** the channel is healthy on v0.2.37; both type calls fail before mutation and retain the
original values; Windows target routing is explicit; the disabled protection flag reaches the
extension and allows the authorised Diamond read/download; and every applicable protected-origin/
reset/inspection-uncertainty assertion holds on test-only state. The v3 action is not parked, the
unsolved v2 click/evaluate are parked, and the post-human-solve click executes. Update LT-658 to
live-confirmed and close this residual. If no protected test-only state exists, retain only steps
8–10 rather than touching a real secret-bearing tab.

<a id="res-024--voiceover-announcement-for-loop-diagnosis-cards"></a>

## RES-024 — VoiceOver announcement for loop diagnosis cards

**Source:** [Loop issue diagnosis UX live test](2026-09-02-loop-issue-diagnosis-ux_livetest_completed.md), former LT-3.

**Known passed behavior:** the real rendered card exposes CRITICAL as `role="alert"` (assertive)
and WARN as `role="status"` (polite), both atomic. The live region contains only diagnosis prose;
opening/closing its disclosure and focusing every action produced zero live-region mutations. Real
Tab traversal reached the native disclosure and every correctly named native button in visual
order. LT-590 through LT-592 are confirmed fixed live.

**Why this remains:** the only unproved assertion is what VoiceOver actually speaks. macOS exposes
no safe read surface for recent speech, and turning VoiceOver on changes audio, keyboard and focus
for the physical machine. Computer Use cannot make or judge that auditory assertion on James's
behalf.

**James-assisted sequence:**

1. Run a current build and turn on VoiceOver with Cmd+F5.
2. Put a disposable loop into a CRITICAL last iteration. Confirm the diagnosis is spoken once and
   interrupts the current speech.
3. Repeat with WARN. Confirm the diagnosis queues politely instead of interrupting.
4. Expand **Why the loop thinks this**, then Tab through **Give a hint**, **See why** and **Stop**.
   Confirm the diagnosis panel is not re-announced.
5. Turn VoiceOver back off and terminate only the disposable loop.

**Pass:** both severity politeness modes match, each diagnosis is spoken once, and disclosure/focus
changes do not trigger a second full-card announcement.

<a id="res-025--provider-billed-input-comparison-campaign"></a>

## RES-025 — Provider billed-input comparison campaign

**Source:** [Enhancements backlog live test](2026-09-03-enhancements-backlog_livetest_completed.md),
former checks 20 and 21 (G42/G43).

**Why this remains:** both assertions require deliberate paid provider use and readings from an
authenticated provider billing pane. The source explicitly reserved that spend decision for James;
Harness-internal token counters and `rtk gain` are not substitutes for uncached billed input.

**James-authorised bounded sequence:**

1. Choose Claude or Codex for the continuation comparison, approve a fixed maximum provider spend,
   and open the provider's billing/usage pane. Use one disposable short Loop task in this repository
   with review-driven mode and default recycle threshold 0.85.
2. Record uncached billed input for iteration 0 and one later same-thread iteration without recycle.
   Require the later continuation-card turn to be materially smaller than the full-constitution
   first turn.
3. Repeat the same bounded task on the current exec-per-message provider (historically Gemini;
   use Antigravity if it is the supported current route). Require later iterations to remain near
   first-turn input because each invocation reanchors.
4. With Codex resume and `resetAtUtilization: 0.85`, run at most 20 short/read-only iterations and
   record recycle count, rounds and uncached billed input. Repeat once on a fresh session with 0.60.
5. Require 0.85 to recycle less often than 0.60. If the 0.85 run shows context rot (repeated reads
   or missed notes), preserve the evidence for pruning/retrieval remediation rather than silently
   lowering the threshold.
6. Stop at the approved spend ceiling, terminate only disposable sessions and retain redacted
   provider-billing evidence with timestamps and model identifiers.

**Pass:** same-thread continuation is materially cheaper than its reanchor, exec-per-message turns
remain reanchor-sized, and the 0.85 Codex run recycles less often than the 0.60 control without
unacceptable context rot.

<a id="res-026--token-efficiency-longitudinal-decision-experiment"></a>

## RES-026 — Token-efficiency longitudinal decision experiment

**Source:** [Token efficiency remediation rollout checks](2026-09-05-token-efficiency-remediation_livetest_completed.md), former checks 4.1 and 4.2. All eight actual rollout/repair checks in that source are closed; LT-596, LT-597 and LT-598 are confirmed fixed live.

**Known evidence:** the matched eager-versus-stable Codex A/B reduced initially injected Browser
Gateway schema bytes by 83% but produced no measurable delivered-token reduction (30,992 versus
31,061 total input); the cost gap was cache placement, not schema savings. The pre-remediation app
arm no longer exists, and the source expressly rejects an agent-manufactured benchmark as a
substitute for James's ordinary completed work.

**Why this remains:** the remaining questions are longitudinal product experiments, not release
acceptance. They require comparable real tasks James actually needs, his chosen settings, provider
billing/usage evidence and his judgment of quality and rework before any default model/effort or
worker-routing policy changes.

**James-led bounded experiment:**

1. Select a small set of genuinely needed, repeatable work items and define success/review-quality
   criteria before running either arm. Do not generate extra paid work only to populate the table.
2. For the before/current comparison, record model, effort, concurrency, outcome, independent review
   result, uncached/cached input, output/reasoning, tool bytes/calls, compactions and estimated
   credits. If a trustworthy pre-remediation arm cannot be reconstructed, report the comparison as
   unavailable rather than inventing a baseline.
3. On separate needed tasks of comparable difficulty, compare Medium versus High and any cheaper
   bounded worker route while preserving mandatory independent review and James's selected safety
   settings. Record retries, corrections and human rework alongside spend.
4. James decides whether the observed quality/rework trade-off warrants any default-policy change.
   This residual itself authorises no routing, model, effort or spend-policy mutation.

**Pass:** enough comparable real-work evidence exists for James to make an explicit decision, with
quality/rework and provider consumption reported together. “No change” is a valid completed
decision; a synthetic benchmark or prompt-cache percentage alone is not.

<a id="res-027--remote-node-lan-discovery-failover-and-notification-campaign"></a>

## RES-027 — Remote-node LAN discovery, failover and notification campaign

**Source:** [Remote Node Resilience live test](2026-09-07-remote-node-resilience_livetest_completed.md),
former LT-A through LT-E.

**Known evidence:** the rebuilt coordinator does call the real Bonjour publisher. On 2026-09-27 an
isolated dev app started the server on loopback port 4971, then performed the same stop/start IPC
sequence as the Settings toggle. Its live `DiscoveryService` log was exactly publish → unpublished
→ publish. A real `dns-sd -B _ai-orchestrator._tcp local` browse still found no service, and the
publisher recorded `EHOSTUNREACH 224.0.0.251:5353` with the Local Network permission remediation.
This is the already-registered LT-619 environment boundary, not a new defect. The autonomous run
did not cut Tailscale, stop `windows-pc`, change quiet hours or manufacture a multi-node outage.

**Why this remains:** granting the packaged Harness Local Network permission requires macOS System
Settings, which is hard-denied. The remaining checks deliberately sever James's live worker path,
stop a production worker, display real desktop notifications, or require human judgment of an
alert burst. They must be run as one supervised campaign after permission is granted.

**James-assisted sequence:**

1. In macOS System Settings → Privacy & Security → Local Network, enable Harness, then fully quit
   and reopen the current packaged app. Do not treat the setting as applied until the new process is
   running.
2. Confirm the current `app.log` records `mDNS service published` on port 4878 with no later
   `EHOSTUNREACH`, and run `dns-sd -B _ai-orchestrator._tcp local` long enough to see exactly one
   `orchestrator-<namespace prefix>` service.
3. Toggle Remote Nodes off and on once. Require one unpublish followed by one publish in the log and
   still exactly one browse result; two results or a stale old-port result fails LT-B.
4. Before testing failover, schedule an unconditional `tailscale up` on `windows-pc` about five
   minutes ahead. Then run `tailscale down` there and require the worker to reconnect within about a
   minute over a `192.168.0.x` address. Record which candidate won; the static LAN fallback means a
   reconnect alone does not prove mDNS discovery.
5. With `notifyOnNodeDisconnect` enabled, stop the worker using its documented Windows service/task
   procedure and wait for deregistration. Require one “Worker node disconnected” notification
   naming the node. Repeat within the dedupe window, then with a different disposable node, and
   require same-node dedupe without suppressing the other node.
6. Set quiet hours to cover the current time and repeat one safe disconnect. Because the alert is
   critical, the notification must still appear. Restore the prior quiet-hours setting immediately.
7. With two disposable/approved worker nodes connected, cause one shared-cause outage and observe
   the two close-together named notifications. James records whether that small burst is tolerable
   or requires a rolled-up critical-alert design. Restore every network path and worker service.

**Pass:** packaged-app multicast is visible, the Settings restart leaves exactly one advertised
service, the worker recovers over LAN with the winning route identified, disconnect alerts obey
dedupe and critical quiet-hours bypass, and James explicitly accepts or rejects the multi-node
alert burst.

<a id="res-028--authenticated-etendersni-cdp-hop-deadline"></a>

## RES-028 — Authenticated eTendersNI CDP-hop deadline

**Source:** [Bounded CDP hops for existing-tab commands live test](../browser-gateway-cdp-hop-deadlines_livetest_completed.md), former check 1.

**Known evidence:** five of the six source checks are closed. Unit and integration coverage proves
the extension bounds attach, CDP commands and detach; names the stalled CDP step; decorates the
coordinator error as not a permission problem; records reliability evidence; and always detaches.
Healthy live query, snapshot, click, evaluate and screenshot paths have passed on ordinary public
tabs. The one missing assertion is specific to the original authenticated tender workspace page.

**Why this remains:** the current Windows inventory contains no eTendersNI tab. Opening the URL
without James's authenticated session would redirect to login and give a fast but meaningless
answer. Login/MFA and sharing the authenticated tab are human boundaries. The 2026-09-27 worker
itself is healthy, but the extension relay also needs to remain command-deliverable after its
v0.2.37 reload.

**James-assisted sequence:**

1. On `windows-pc`, open the exact eTendersNI CfT workspace page while logged in, complete any MFA,
   and share that one tab through Harness Browser Gateway.
2. Confirm Browser Gateway health reports v0.2.37, `registration: ok`, fresh contact and a ready
   command channel. Run a one-line `browser.query_elements` probe first; a host-permission refusal
   must be surfaced, not accepted as a successful empty result.
3. Call `browser.accessibility_snapshot` with `limit: 2000` and record wall-clock time.
4. Good case: nodes return within the 48-second page-work window. Bad-but-correct case: it fails at
   roughly 48 seconds as
   `browser_extension_cdp_timeout:Accessibility.getFullAXTree after 48000ms`.
5. After a bounded failure, immediately repeat one safe read. Require a clean attach or the same
   named timeout, never `browser_tab_debugger_busy`. Confirm health/app log expose the timeout and
   still say it is not a permission problem.

**Pass:** either the authenticated AX tree returns within the bound or the precise named 48-second
timeout is reported, visible and detached cleanly. A bare 60-second
`browser_extension_command_timeout` means the current extension was not actually loaded. If the
named 48-second timeout reproduces, register a new LT item for incremental AX collection
(`Accessibility.getRootAXNode` plus bounded `getChildAXNodes`) before changing code.

## RES-029 — Real Claude/Codex account-pool campaign

**Source:** [Provider Account Pools live test](2026-09-13-provider-account-pools_livetest_completed.md), former checks 1–8.

**Current evidence:** the rebuilt 2026-09-27 runtime contains only the two migration-created legacy
profiles, one for Claude and one for Codex. Neither has a verified identity/account key, both pools
remain in `ask` failover mode, and ownership acknowledgement is unset. There is therefore no second
owned subscription to test and no safe autonomous way to manufacture the required real usage-limit
state. All code and automated gates from the source plan already pass.

**Why this remains:** the campaign requires two real subscriptions per provider, interactive
provider login/Keychain state, ownership acknowledgement, deliberate consumption to a real plan
limit, desktop-notification judgment and node-local login on `windows-pc`. Credentials must stay in
the vendor login flow/Keychain; never paste tokens, `auth.json` or Keychain values into evidence.

**James-assisted sequence:**

1. In Settings → Claude & Codex Accounts, add and sign in a second owned Claude subscription.
   Confirm the created `Claude Code-credentials-<8 hex>` service-name suffix matches
   `claudeKeychainServiceName(realpath(profileHome))`, then Verify shows the correct identity.
2. Run `CLAUDE_CONFIG_DIR=<profileHome> claude -p 'say ok' --output-format json`. Require a clean
   headless JSON result with no onboarding, theme or login prompt.
3. With continuation `shared-store`, begin on Claude profile A, ask it to remember `pelican`, switch
   to profile B, then ask for the word. Require a visible account-switch notice, the correct answer
   and native `--resume` under profile B rather than transcript replay.
4. Enable automatic failover and, within an explicitly approved spend/window, reach a genuine
   Claude usage limit. Require the exhausted profile alone in `provider_limit_events`, one
   `account_failover_performed`, a single resend, separate quota rows and one desktop notification.
5. Add/sign in a second owned Codex account by the vendor device-auth flow. Verify distinct identity
   and account key, run a real session with `cli_auth_credentials_store=file`, then repeat the
   bounded real-limit failover and require `codexErrorInfo.usageLimitExceeded` for the failed turn.
6. Continue one provider until every profile is genuinely limited. Require `account_pool_exhausted`,
   parking until the soonest reset, then automatic early-probe resume on the first available profile.
7. Launch Harness from a shell containing `ANTHROPIC_API_KEY=placeholder-not-a-key`, start Claude on
   the second profile and inspect `claude auth status --json`. Require subscription auth for that
   profile, not ambient API-key auth, and zero API-priced cost. Restore the original environment.
8. Redeploy the current worker build. Sign the same second Claude profile in under the worker's own
   derived home, then launch a bound remote session and require it to answer without any controller
   path in the worker log. A deliberately nonexistent profile ID must fail locally with the explicit
   not-signed-in-on-this-node message; heartbeat capabilities must list only local profile IDs.

**Pass:** all eight provider-owned assertions pass with secret-free profile IDs, lifecycle event
names and hashes as evidence. If native cross-profile Claude resume fails, register a new LT item
and change the default to `replay` only after that live evidence. Restore pool policy, environment,
worker deployment and any deliberately consumed test sessions when finished.

## Evidence run — 2026-10-04 (orchestrating session, packaged app built 19:06, restarted 20:45:59)

Only residual groups whose external prerequisite has changed were re-examined. Every other group's
boundary (James's authority, a physical device, a login, a signed release, a decision) still holds
and was not touched.

### RES-023 — extension 0.2.37 is now loaded; agent-runnable steps 3–7 PASS, LT-658 confirmed live

The reload prerequisite (step 2) has been met by James since this residual was written:
`list_remote_nodes` at 23:19 reports `windows-pc` `extensionRelay.extensionVersion: "0.2.37"`,
`extensionReloadedAt 1790928909485` (2026-10-02), `registration: "ok"`, recent contact; `browser.health`
reports the channel `fresh`, `commandsDeliverable: true`, no contact gaps, no flap storm.

- **Step 1** — bundle hashes on `windows-pc` not re-read (the reported version is 0.2.37, which the
  residual says uniquely identifies the fixed bundle).
- **Step 3 — PASS** (above).
- **Step 4 — PASS.** `browser.find_or_open {computer: "windows-pc", url:
  https://www.selenium.dev/selenium/web/web-form.html}` opened new tab `771569502` on `windows-pc`.
  `query_elements`: `input[name="my-disabled"]` `value: ""`, `disabled: true`;
  `input[name="my-readonly"]` `value: "Readonly input"`. Accessibility snapshot: uid 5 disabled
  textbox, uid 6 `Readonly input`.
- **Step 5 — PASS.** Selector-path `browser.type` on the disabled input → `failed`: "type target
  cannot accept typed text: <input> is disabled. Enable the control or choose an enabled typeable
  target before retrying." (audit `99449911`). UID-path `browser.type` on uid 6 → `failed`: "uid type
  target cannot accept typed text: <input> is readonly. Remove readonly or choose an editable target
  before retrying." (audit `4e74c824`). Cosmetic only: the UID message is prefixed `Error:` and ends
  with a raw stack frame (`at HTMLInputElement.uidTypeFn (<anonymous>:23:11)`); not filed.
- **Step 6 — PASS.** Read-back after both calls: disabled `""`, readonly `"Readonly input"`; neither
  call reported an input/change effect.
- **Step 7 — PASS.** `browser.preflight_target {computer: "windows-pc", url: <the fixture>}` evaluated
  only `remote-extension` candidates on `computer: "windows-pc"` and explained each rejection; the
  subsequent open landed on `nodeName: "windows-pc"`.
- **Step 11 — health half PASS; popup half open.** With **Lock shared tabs after a credential fill**
  off, health reports `secretObservation {reported: true, protectionEnabled: false,
  taintedOriginCount: 0, taintedTabCount: 0}` after harmless shared-tab commands. The extension
  popup's protection-off message needs James's eyes.
- Steps 8–10, 12–16 — not run: they need a test-only protected origin, James operating the popup,
  an authorised Diamond/ProContract login, or controlled CAPTCHA pages with a human solve.
- Cleanup: the fixture tab was closed with `browser.close_tab` (audit `790c7ca8`; authorised by
  this session's YOLO auto-approval grant `9bd1352f-…`, scoped to `https://www.selenium.dev` and
  consumed once).

**LT-658's disabled/readonly half is confirmed fixed live on v0.2.37.** RES-023 stays open for
steps 8–16.

### Other groups

- RES-017 (Guardian adjudication) — an auxiliary endpoint now exists (LM Studio on `windows-pc`,
  enrolled and healthy), but it is reachable only through the packaged app's paired worker, and the
  procedure needs an isolated rebuilt app plus James's authority to switch on
  `approvalAdjudicationEnabled`. Not run.
- RES-018 (Local AI Guard enrolment) — a compatible endpoint is now enrolled (`afa37744-…`), so the
  "restore or advertise a compatible endpoint" prerequisite is met; the explicit-authority boundary
  for a live `enrol` still applies. Not run.

## Status — 2026-10-04

Open: 28 groups (unchanged; RES-023 narrowed to steps 8–16) · Closed: 0 · Failed: 0 · Retired duplicate: 1.
