# Live tests — mobile queue / Stop / draft duplication

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-07-25-mobile-queue-interrupt-draft_plan_completed.md](./2026-07-25-mobile-queue-interrupt-draft_plan_completed.md)

## Status — completed by consolidation 2026-09-27

Open here: 0 · Closed logic/API layers: 10 · Transferred device campaign: 10 · Failed: 0

Every main-process, queue, interrupt, pause, retry and attachment path has passed live or through
the accepted production-class test boundary below. The remaining physical-iPhone rendering,
haptic and native-dialog assertions moved intact to consolidated
[RES-013](2026-09-27-livetest-human-external-residuals_livetest.md#res-013--physical-iphone-mobile-queue-interrupt-and-rendering-campaign).
That residual is now the sole active owner; no open item remains here.

## Evidence run — 2026-09-25

- The mobile project now tracks its native iOS app and Live Activity target. `npm run sync`
  passed, and an unsigned iPhoneOS workspace build compiled the app plus embedded
  `HarnessWidgets.appex`.
- `xcrun devicectl list devices` reported both `JL iPhone 17` and `JL iPhone 18` as
  `unavailable`. That blocks signed install, launch, haptics, native dialogs, and every
  remaining on-device rendering assertion in checks 1–10. This is a connection state, not
  a reproduced product defect, so no LT item was opened.
- The repeatable next step is `cd apps/mobile && npm run ios:device -- --device "JL iPhone 18"
  --team "your Apple team ID"` after the phone is connected, unlocked, and Developer Mode is
  enabled. The consolidated prerequisites and evidence procedure are in
  [the current improvement plan's live-test companion](2026-09-25-mobile-app-improvement_plan_livetest.md).

Prerequisites, all of them:

1. **Rebuild Harness** (`npm run build` + relaunch, or `npm run dev`). The gateway
   queue lives in the main process, so the running app predates it.
2. **Rebuild + reinstall the phone app**: `cd apps/mobile && npm run sync && npm run ios`
   then run on the device from Xcode. The web assets are bundled, so `cap sync` alone
   on an old binary is not enough for the new Stop button/queue strip.
3. Phone and Mac on the same tailnet, gateway running, device already paired.

Each check lists what to do and what should happen. None of these can run in-loop:
they need the rebuilt binaries, a real device, and a real provider turn.

---

## 1. Queue while busy (the reported bug)

1. Start a codex session on the Mac and send it something long-running.
2. While the header shows `busy`, type a follow-up on the phone and hit send.

Expect:
- The composer clears, and a strip appears above it: `1 · message queued` with the
  message preview and an `×`.
- A one-line notice: "Queued — it will send when this session is free."
- **No** `Codex error: Codex app-server runtime already has an active turn` in the transcript.
- **No** copy of the text left in the input field (this was the original complaint).
- `~/Library/Application Support/Harness/logs/app.log` has no
  `MobileGateway "Request handler error" … /input` entry for this send.

When the turn finishes:
- The queued strip empties, the message appears as a normal user bubble, and the agent
  starts working on it.
- The log shows `Delivered queued mobile message`.

**Status:** Logic/API layer PASSED — see Closed checks. **Blocker: [C]** — the visual strip,
notice banner, and composer-clear animation are on-device rendering, unverified without
James's physical iPhone.

## 2. Queue ordering

Send three messages in a row while busy. Expect all three in the strip in order, then
delivered in the same order, one turn each.

**Status:** Logic/API layer PASSED — see Closed checks. **Blocker: [C]** — the ordered visual
strip is on-device rendering, unverified without James's physical iPhone.

## 3. Cancel a queued message

Queue a message, tap its `×`.

Expect: it leaves the strip, its text lands back in the composer (appended on a new line
if you had started typing something else), and it is never delivered.

**Status:** Logic/API layer PASSED — see Closed checks. **Blocker: [C]** — the strip removal
and composer text-return are on-device rendering, unverified without James's physical iPhone.

## 4. Stop from the composer

While the agent is working, tap the square Stop button to the left of send.

Expect: haptic, notice "Stopping…", the turn stops, and the session settles to idle.
While it is settling the Stop button is disabled (guard against the escalation below).

**Status:** API-layer PASSED, re-confirmed fresh 2026-08-24 (Batch G) with a new instance and
timestamp, not just carried forward from git-log absence-of-change. **Blocker: [C]** — haptic
feedback is a Capacitor plugin call with no web/CDP equivalent; the composer's disabled-while-
settling DOM attribute (`conversation.component.html:204`, driven by signals already proven
correct server-side) is rendering-only. Both need James's physical iPhone.

## 5. Stop when there is nothing to stop

Open `⋯ → Stop (interrupt)` on an idle session.

Expect: "Nothing to stop — this session is not running a turn." Previously this looked
like it had worked.

**Status:** API-layer PASSED, and the client-side message mapping is source-confirmed
(`conversation.component.ts:415-421` maps `accepted:false` to this exact string) — see Closed
checks. **Blocker: [C]** — the string actually rendering on screen is unverified without
James's physical iPhone.

## 6. Escalation is confirmed, not accidental

Stop a working session, and while it shows `respawning`/`interrupting` open
`⋯` — the item should read **Force-cancel (stop again)** and ask for confirmation
before cancelling the session.

**Status:** Server escalation behaviour PASSED, re-confirmed fresh 2026-08-24 (Batch G) with a
new double-interrupt race against a fresh instance. The client gate is source-confirmed
(`conversation.component.ts:399-410`: `stopping()` + `confirm(...)`; label swap at
`conversation.component.html:34`). **Blocker: [C]** — the native `confirm()` dialog rendering
as an on-screen OS alert (no web/CDP equivalent) and the literal menu-label text swap are
unverified without James's physical iPhone.

## 7. Steer (queue + stop together)

While the agent is working: type a correction, send it (queues), then tap Stop.

Expect: the current turn is interrupted and the queued correction is delivered as soon
as the session comes back — the phone equivalent of desktop steering.

**Status:** Logic/API layer PASSED — see Closed checks. **Blocker: [C]** — on-device rendering
of the interrupt/redelivery sequence is unverified without James's physical iPhone.

## 8. Paused orchestrator

Pause from the phone (`⏸`), send a message to an idle session.

Expect: it queues rather than failing, and delivers when you unpause.

**Status:** Logic/API layer PASSED — see Closed checks. **Blocker: [C]** — the phone-side
pause/unpause UI is unverified without James's physical iPhone.

## 9. Failed delivery is visible, not silent

Hard to force deliberately; if you ever see it, the queued row turns red with
`Couldn't send: <reason>` and blocks the queue until cancelled. Confirm the `×`
clears it and the rest of the queue then flows.

**Status:** Not independently forced via the real HTTP surface across three separate batches
(2026-08-18, 2026-08-24, 2026-08-25). Two real, non-destructive live mechanisms were tried and
ruled out with documented reasons (pulling `auth.json` mid-turn does not affect an
already-running `codex app-server` session; a concurrent double-interrupt hits a different
`isTerminalForQueue()` branch than the retry-then-park path this check describes). The
production class itself (`MobileInputQueue`) was freshly executed 2026-08-24:
`npm run test:quiet -- src/main/mobile-gateway/mobile-input-queue.spec.ts` → 30/30, covering
both the `MAX_DELIVERY_ATTEMPTS`-retry-then-park behaviour and the cancel-and-resume behaviour
with the real class (not a rewritten double). Reaching the real retry-then-park path
deterministically over live HTTP would need a narrow timing window between a ready-edge firing
and `sendInput()` reaching the adapter — forcing it needs either an artificial delay hook in
`dispatchSend()`/`deliverNext()` (a source change, out of scope without a reproduced defect) or
accepting the current unit-execution + ruled-out-live-mechanisms evidence as sufficient.

**Decided 2026-09-06 — accept the existing evidence; add no timing hook.** `MobileInputQueue`
is the real production class and `src/main/mobile-gateway/mobile-gateway-server.ts:255-261`
wires its `deliver` dependency straight to `dispatchSend()`. The specs drive the exact
behaviour this check describes — retry-then-park with `attempts: 3` and the error recorded,
then cancel-and-resume — through the class's real public API (`drain`, `cancel`, `toDto`),
mocking only the injected `deliver`, which is the network boundary and not the logic under
test. 30/30 reconfirmed passing 2026-09-06. The only surface left untested is winning a live
HTTP timing race to *reach* code that is already deterministically exercised once reached.
Adding a test-only delay hook to a shipped hot path to force a race that dependency injection
already covers is the worse trade.

**What remains of check 9 is on-device only:** the red row and the `Couldn't send: <reason>`
text rendering, which folds into the single iPhone session with checks 1–8 and 10.
**Blockers:**
- **[A]** the live-HTTP forcing question is a scope/acceptance decision, not a James-only
  blocker: either add a deliberate test hook to make the race deterministic and drive it live,
  or a human sign-off that 30/30 real-class execution plus two documented negative live results
  is sufficient to close this half.
- **[C]** independent of the above, the red-row styling and `Couldn't send: <reason>` text are
  on-device rendering, unverified without James's physical iPhone.

## 10. Attachments

Attach a photo while the session is busy and send.

Expect: the queued row shows the paperclip icon, and the photo arrives with the message
when it is delivered.

**Status:** Data-plumbing layer PASSED — see Closed checks. **Blocker: [C]** — the paperclip
icon rendering is unverified without James's physical iPhone.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1 — queue while busy (logic/API) | 2026-08-18 | Message B while A busy → `{"ok":true,"queued":true,"queueId":"..."}`, delivered only after A completed; `mobile-input-queue.ts:290` `Delivered queued mobile message` matched |
| 2 — queue ordering (logic/API) | 2026-08-18 | 3 messages queued while busy; `queuedMessages` preserved order; delivered timestamps strictly increasing in the same order |
| 3 — cancel a queued message (logic/API) | 2026-08-18 | `DELETE /api/instances/:id/queue/:id` → `{"ok":true,"message":"CANCEL-ME..."}`; text never appeared in the transcript |
| 4 — stop from composer (API) | 2026-08-24 (Batch G, fresh instance) | `POST /interrupt` on busy instance `xyrym3f5f` → `{"ok":true,"accepted":true}`; transcript `Interrupted — waiting for input`; instance settled `idle` |
| 5 — stop when nothing to stop (API + client mapping) | 2026-08-18 | `POST /interrupt` on idle instance → `{"ok":true,"accepted":false}`; `conversation.component.ts:415-421` maps this to the exact expected string |
| 6 — escalation confirmed (server) | 2026-08-24 (Batch G, fresh instance) | Two `POST /interrupt` ~20ms apart on a busy instance → both `accepted:true`, original input errored `Codex app-server runtime closed`, instance settled `cancelled`; transcript matches `Interrupt escalated: cancelled` |
| 7 — steer (logic/API) | 2026-08-18 | Queued `STEER-CORRECTION...` while busy, then `POST /interrupt` (`accepted:true`); queued correction delivered immediately after, instance went `busy` processing it |
| 8 — paused orchestrator (logic/API) | 2026-08-18 | `POST /api/pause {"paused":true}`; input to an idle instance → `{"ok":true,"queued":true}`; unpausing drained it automatically ~5s later |
| 10 — attachments (data plumbing) | 2026-08-18 | Queued message with `FileAttachment`-shaped payload while busy → `queuedMessages[0].hasAttachments === true`; delivered transcript message also carries `hasAttachments: true`; traced through `mobile-input-queue.ts:148-168,246-296` |

Note: this evidence, and the 2026-08-19 `dispatchSend()` symmetric fix for LT-181 (a real race
between a direct send and a queue delivery/another direct send for the same instance), is on
`src/main/mobile-gateway/mobile-gateway-server.ts` / `mobile-input-queue.ts` @ `3cfa2721`
(2026-08-19), re-confirmed with zero uncommitted diff as recently as 2026-08-25 (Batch H).
`apps/mobile/src/app/features/conversation/conversation.component.ts` is unchanged at
`3e1be956` (2026-07-25) over the same window. If either file changes, re-drive the affected
checks rather than trusting this table.

## Transferred residual

The real, non-substitutable on-device layer was consolidated into RES-013 on 2026-09-27. This
source document is retained as the detailed logic/API evidence record and is complete.
