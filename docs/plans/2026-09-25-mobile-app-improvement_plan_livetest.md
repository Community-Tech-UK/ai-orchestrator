# Harness mobile improvement plan — deferred physical-device checks

**Status:** Pending physical-device validation. Code, browser, and unsigned iPhoneOS build
checks belong in the owning implementation plan and must pass before this file is run.

**Implementation plan:** [Harness mobile improvement plan](2026-09-25-mobile-app-improvement_plan.md).

**Prerequisites:** Connect and unlock `JL iPhone 18`; enable Developer Mode; confirm
`xcrun devicectl list devices` reports it as `available`; have the Apple Developer team
identifier available at runtime; run a disposable desktop gateway and session on the same
tailnet. App Lock must be enabled where a check says so. Do not target James's live work.

**Why these checks are deferred:** On 2026-09-25 CoreDevice reported both known physical
iPhones as `unavailable`. The checks below require a signed app, hardware capabilities,
device trust, APNs, or human observation. A simulator or browser preview cannot establish them.

**Remediation flow:** Read [the campaign runbook](livetest-campaign-runbook.md) before
execution. A reproduced defect gets a new LT-NNN entry in
[the remediation register](livetest-remediation-register.md), plus a matching
implementation-status section in
[the remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md). Record
per-check evidence in the owning live-test document. Rename this file
`_livetest_completed.md` only after every check below passes.

## 1. Signed install, launch, and trust diagnosis

1. Confirm the phone is available:
   `xcrun devicectl list devices`.
2. From `apps/mobile`, run:
   `npm run ios:device -- --device "JL iPhone 18" --team "your Apple team ID"`.
3. Confirm the command builds, installs, launches Harness in the foreground, and the home
   screen renders. Record the app build number, device model, and iOS version.

**Expected:** The command exits successfully and Harness opens without an **Unable to Verify
App** alert. The installed app contains the Live Activity extension.

If the trust alert recurs, do not change signing first. In Console.app on the Mac, select the
connected iPhone, start streaming, filter for `installcoordinationd`, `online-auth-agent`,
`amfid`, or `trustd`, then reproduce exactly one launch. Export the timestamped matching rows
and record whether they identify certificate trust, network verification, or a
profile/entitlement mismatch. Any phone-side trust, reboot, or settings action is performed by
James after that evidence identifies it.

## 2. Live Activity and push entry

1. Pair the newly installed app with the disposable gateway.
2. Open a running session long enough for a Live Activity to start; lock the phone and inspect
   the Lock Screen and Dynamic Island. Let the session finish.
3. Send a real test notification with the app foregrounded, backgrounded, and cold. Repeat
   while a different host is selected.

**Expected:** The Live Activity names the correct session, updates status, and ends. Each push
opens the correct host/session or request with a safe Back destination. No token or connection
code is exposed in the UI or captured evidence.

## 3. Foreground liveness after real iOS suspension

Use the disposable gateway with debug logging enabled and a conversation that has already
loaded at least one message. Record the gateway request/connection log alongside the phone
screen recording.

1. With the conversation open and connected, send Harness to the background for 10 seconds
   without changing network connectivity, then foreground it.
2. Confirm the app performs its foreground ping/pong check and remains on the same socket. It
   must not flash offline, reconnect, or issue a full transcript request.
3. Background Harness again, enable Airplane Mode on the phone, and let the disposable agent
   produce at least two identifiable messages while the phone is disconnected.
4. Foreground Harness while still offline, then disable Airplane Mode.
5. Confirm the dead socket is detected, the app reconnects without waiting for the old TCP
   timeout, and exactly one incremental
   `GET /api/instances/<id>/messages?fromSeq=<last-buffer-index>` catch-up restores both missed
   messages in order. It must not issue a full transcript request unless the gateway explicitly
   reports a buffer reset or `hasMore`.

**Expected:** A still-live suspended connection survives the foreground liveness probe without
reconnecting. A dead suspended connection reconnects promptly, resumes from the last retained
buffer cursor, shows each missed message once, and returns to Connected without stale content or
an unnecessary full refetch.

## 4. Queue, Stop, draft, and attachment rendering

Run checks 1–10 in
[the queue/interrupt/draft live-test document](2026-07-25-mobile-queue-interrupt-draft_livetest.md)
against disposable sessions. Record its requested logs and on-device observations in that file.

**Expected:** Queue order, cancellation, Stop and force-cancel states, pause steering, failure
feedback, haptics, draft recovery, and attachment indicators match each check's expected result.
The remaining gap is physical rendering and native feedback; the logic/API evidence is already
recorded there.

## 5. Keyboard, permissions, accessibility, and App Lock

Run sections 1–5 in
[the mobile design live-test document](2026-09-15-mobile-design-improvements_livetest_completed.md),
using harmless photos and disposable pairing/session data. Test the onscreen keyboard, a
physical keyboard, IME input, rotation, Larger Accessibility Sizes, camera/photos/clipboard,
dictation lifecycle, VoiceOver, Reduce Motion, Face ID cancellation/success, QR and paste
pairing, and notification entry.

**Expected:** No accidental sends, keyboard-obscured actions, clipped controls, cross-session
draft leakage, stale dictation, inaccessible modal focus, exposed tokens, lock-screen content
leak, or wrong-host push routing. Record the exact build/device/iOS details and results in the
2026-09-15 document.

## 6. Active-turn steering against a live provider

Use a disposable live provider session on the disposable gateway. Run this on the signed
physical-device build so the actual mobile composer, attachment picker, socket lifecycle, and
provider interruption path are exercised together. Do not target James's live work.

1. Start a harmless turn that runs long enough to accept intervention. While it is active, use
   ordinary **Send** for a clearly identifiable message.
2. Confirm the message is shown as queued and is delivered only after the active turn finishes.
3. Start another long-running turn. Confirm **Steer current turn** is available only while the
   instance is `busy`, `processing`, `thinking_deeply`, or `waiting_for_permission`, then steer
   with a different clearly identifiable message.
4. Confirm the active provider turn is interrupted and the steering message is delivered exactly
   once. Confirm the draft and attachments clear on success and no duplicate optimistic message
   remains.
5. Repeat with one harmless attachment. Then force or wait for a real provider compaction and
   steer during compaction.
6. Confirm compaction is not interrupted, the steering message follows it exactly once, and the
   attachment remains associated with the correct message. If either request fails, confirm the
   draft and attachment are restored for retry.

**Expected:** Ordinary Send retains queue semantics. Steer is offered only for the four supported
active statuses, interrupts a normal active turn, preserves provider-owned compaction, and delivers
text and attachments exactly once without transcript duplication or draft loss.

## 7. Loops, Plan Queue, doc review, browser approvals, and continue

Use the signed build and a disposable gateway. Do not target James's live work.

1. Start a loop on the desktop. On the phone, open Loops, then the run. Pause, resume, and stop it.
2. Open a Plan Queue run that is waiting for an answer. Answer from the phone. Confirm landing and harvest are not offered.
3. Open a pending doc review. Approve one item, reject another, pick an option without typing a letter, add a comment, and submit an overall verdict. Confirm the desktop session receives the same feedback block.
4. Raise a normal browser approval (read or navigate). Allow it from the phone, then deny a second one. Raise a credential, payment, or identity approval and confirm the phone says **Open on your Mac** and has no Allow or Deny.
5. Open a past session and tap Continue. Confirm it opens the restored live session. Open a hibernated session and confirm the header says **Waking…** until it is awake.

**Expected:** Phone controls call the desktop coordinator, queue, and doc-review services. Blocked browser classes cannot be decided on the phone. Continue and wake open the right session.

## 8. Appearance, Dynamic Type, pull to refresh, pins, and iPad

1. On Hosts, set Appearance to Light, Dark, and System. Confirm the status bar and page colors follow the choice, and System follows the phone's setting.
2. Set the iPhone text size to 200% (Larger Accessibility Sizes). Walk Projects, a conversation, and a review. Confirm text grows and controls stay reachable.
3. Pull to refresh Projects, Sessions, History, and a conversation. On the conversation, confirm a missed message arrives through the incremental catch-up rather than a blank reload.
4. Pin a project, leave the app, and reopen it. Confirm that project is listed first for that host only.
5. On an iPad, or an iPhone in a window at least 768 px wide, confirm the list stays on the left and the open session, loop, review, or history detail stays on the right. Narrow the window below 768 px and confirm it returns to one column. With a hardware keyboard, confirm ⌘N starts a session and ↑/↓ move between sessions when the cursor is not in a text field.
6. Turn on VoiceOver. Confirm **New output** is announced when the transcript is scrolled up, and connection changes are announced.

**Expected:** Appearance, type size, refresh, pins, and the split layout match the controls above. VoiceOver hears new output and connection changes. A jsdom axe pass of the rendered route screens is in `apps/mobile/src/app/accessibility-axe.spec.ts`. The in-browser preview-build axe pass is still open: it needs a browser, the local Mac browser must not be driven, and the remote browser cannot reach the Mac preview. VoiceOver on device stays in this check.

## Evidence

Append dated evidence here only for the delivery, Live Activity, and active-turn steering checks.
Queue/design evidence belongs in their linked owning documents. Keep every unrun item explicit.
