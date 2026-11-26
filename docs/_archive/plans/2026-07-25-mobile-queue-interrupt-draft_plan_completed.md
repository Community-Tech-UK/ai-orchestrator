# Mobile: queue-while-busy, reachable Stop, and the duplicated-draft bug

Status: COMPLETE — code, tests and gates done 2026-07-25. Behaviour on a real phone
against a rebuilt host is deferred to
[2026-07-25-mobile-queue-interrupt-draft_livetest.md](./2026-07-25-mobile-queue-interrupt-draft_livetest.md).
Owner: agent loop, 2026-07-25
Trigger: James — "the mobile app struggles to interrupt and doesn't queue messages… the text
for the message is sent and in the session chat but it's also in the chat entry field."

## 1. Evidence (verified, not inferred)

Screenshot timestamp 21:40 on 2026-07-24, session "Find Nearby Meetings" (codex, busy).

From `~/Library/Application Support/Harness/logs/app.log`:

```
1784925572860 InstanceCommunication "sendInput state check" {"instanceId":"xs1hvuo58","status":"busy"}
1784925572862 MobileGateway        "Request handler error"
                                   {"path":"/api/instances/xs1hvuo58/input",
                                    "error":"Codex app-server runtime already has an active turn"}
```

`1784925572862` = Fri Jul 24 2026 21:39:32 BST — the send in the screenshot. A second
identical failure exists at Thu Jul 23 17:05:51 (`xdrufoo90`).

## 2. Root causes

### A. No queue for mobile-originated sends
The desktop **renderer** owns all queue-while-busy logic
(`src/renderer/app/core/state/instance/instance-messaging.store.ts:249` — `isTransientQueueStatus`
→ `enqueueMessage`). The mobile gateway is a main-process peer of the renderer: it calls
`instanceManager.sendInput()` directly (`mobile-gateway-server.ts:1176`) with no readiness
check, so a send during an active turn goes straight at the provider adapter. Codex rejects it
(`codex/app-server-thread-runtime.ts:202`), the gateway returns HTTP 500
(`mobile-gateway-server.ts:1058`), and the message is simply lost.

### B. Interrupt is hard to reach and silent
`Stop (interrupt)` only exists inside the `⋯` popover (`conversation.component.ts:85`). The
composer has no stop control while the agent works. `GatewayClient.interrupt()` discards the
`accepted` flag the gateway returns (`mobile-gateway-server.ts:1309`) and
`ConversationComponent.interrupt()` swallows every error, so a rejected interrupt looks
identical to a successful one.

### C. Text stays in the composer after a "sent" message
`GatewayClient.sendInput()` appends an optimistic user bubble *before* the POST
(`gateway-client.service.ts:337`) and never removes it when the POST rejects.
`ConversationComponent.send()` restores the draft on failure (`conversation.component.ts:571`).
Combined: the bubble stays in the transcript **and** the text comes back in the input field —
exactly what the screenshot shows. It is a failed send that looks like a duplicated draft.

## 3. Changes

### Main process

1. `src/shared/types/mobile-gateway.types.ts`
   - `MobileQueuedMessageDto { id, message, hasAttachments, enqueuedAt, attempts, error? }`
   - `MobileInstanceDto.queuedMessages?: MobileQueuedMessageDto[]` (present only when non-empty)
   - Document the `POST /input` `{ ok, queued?, queueId? }` response.

2. NEW `src/main/mobile-gateway/mobile-input-queue.ts`
   - In-memory FIFO per instance (cap 20). Queue only for statuses we know are mid-turn or
     transitioning, when the orchestrator is paused, or when the instance is quota-parked;
     every other status keeps today's send-now behaviour (no regression for hibernated etc.).
   - `drain()` runs one instance at a time behind an in-flight guard, stops the moment the
     instance stops being ready, retries a failed head up to 3 times across ready edges, then
     parks it as `error` (visible to the phone, cancellable) rather than silently dropping it.
   - Owns the `DELETE /api/instances/:id/queue/:queueId` route handler so the server file
     stays near its LOC ceiling.

3. `src/main/mobile-gateway/mobile-gateway-server.ts`
   - `handleInput` → readiness gate → enqueue (`200 {ok, queued:true, queueId}`) or send now.
   - Drain on `instance:state-update`, `instance:batch-update`, and pause `change`.
   - Clear the queue on `instance:removed` and on `stop()`.
   - Surface `queuedMessages` in the snapshot DTO augmentation.
   - Route the new DELETE.

### Mobile app

4. `apps/mobile/src/app/core/models.ts` — mirror the two DTO changes.
5. `apps/mobile/src/app/core/gateway-client.service.ts`
   - `sendInput` returns `{ queued }`; removes its optimistic echo when the POST **fails**
     (fixes C) and when the message was **queued** (the queue strip owns it instead).
   - `interrupt()` returns `{ accepted }`.
   - `cancelQueued(instanceId, queueId)`. (A `queuedFor()` accessor was planned and
     dropped in review: the component reads `instance()?.queuedMessages` from the
     snapshot directly, so the accessor was dead code.)
6. NEW `apps/mobile/src/app/features/conversation/composer-queue.component.ts` — the queued
   strip above the composer (mirrors the desktop `composer-queue.component`), cancel restores
   the text to the input.
7. `conversation.component.ts` / `.scss`
   - Stop button in the composer toolbar while the agent is working.
   - One `notice` line above the composer for queued / stop / failure feedback.
   - Render the queue strip.

### Tests

- `mobile-input-queue.spec.ts`: queue-vs-send decision per status, FIFO drain, in-flight guard,
  retry then park-as-error, cancel, cap, clear-on-remove.
- `mobile-gateway-server.spec.ts`: POST /input while busy → queued + snapshot exposure + drain
  on the idle edge; DELETE cancels.
- `apps/mobile` specs: echo removed on failure and on queue; interrupt result surfaced.

## 3b. As built — deviations worth knowing

- **One message per ready edge.** The first cut drained the whole queue in a loop; that
  races the status flip to `busy` and burns a retry on the exact rejection the queue
  exists to prevent. It now delivers one per edge like `processMessageQueue` in the
  renderer, with a 2s follow-up drain (`FOLLOW_UP_DRAIN_MS`) as the desktop-watchdog
  equivalent for the case where a delivery produces no status edge.
- **Escalation guard (not in the original plan).** Making Stop prominent introduced a new
  hazard: on the host, a second interrupt during `respawning`/`interrupting` escalates and
  *cancels the session*. The composer Stop is therefore disabled while the session is
  settling, and the `⋯` item becomes "Force-cancel (stop again)" behind a confirm.
  New helper `isInterruptRecovery()` in `apps/mobile/src/app/core/status.ts`.
- **Template extracted.** `conversation.component.ts` crossed the 700-line gate, so its
  template moved to `conversation.component.html` (the pattern the desktop input panel
  already uses). `structural-icon-audit.spec.ts` now follows a component's template into
  its sibling `.html` so the guard still covers it.
- **Mobile TestBed setup added.** `apps/mobile/src/test-setup.ts` (+ `vitest.config.ts`
  `setupFiles`) boots Angular's TestBed so `GatewayClient` can be tested under DI. That is
  what made the duplicated-draft regression test possible.
- **LOC ceiling raised** for `mobile-gateway-server.ts` (1528 → 1585) with a comment; the
  queue logic itself lives in the new `mobile-input-queue.ts` (~330 lines).

## 4. Verification

`npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run test:quiet`, plus `npx vitest run` and
`npm run typecheck` inside `apps/mobile`.

Anything needing a rebuilt Harness + a rebuilt/redeployed iOS app goes into
`2026-07-25-mobile-queue-interrupt-draft_livetest.md`.
