# Discord bot: echo-back fix + mobile-parity improvements

Status: **CODE COMPLETE.** §1 echo-back, §2 safe-cwd, and the full mobile-parity backlog (#1 approval/question prompts, #2 reply-complete signal, #3 file/image relay, #4 opt-in heartbeat, #5 DM completion ping) plus the first-turn-race residual are implemented and unit-verified. All agent-runnable gates pass. Only live Discord validation (rebuilt app + real bot) remains — deferred to `2026-07-23-discord-bot-parity_livetest.md`.

## 1. The reported bug — reply never echoed back (FIXED)

### What happened (from the live logs, instance `ixi49auh6`, 2026-07-22 22:47)
- Discord message `hi` arrived; router created a new instance with `workingDirectory: "/"`.
- Provider event timeline for the instance:
  - `461270` — output `user` (the prompt echo)
  - `467045` — output `assistant` **"Hi James! 👋 What can I help you with today?"** ← the reply
  - `467388` — final `status`
- The reply reached the AIO renderer and mobile (they use a **persistent** `provider:normalized-event` listener attached at startup).
- The Discord channel got the 👀 and ✅ reactions but **no text reply**, and there was **no send error** in the logs.
- `channel_messages` for that chat has exactly one row — the inbound `hi`. No outbound row was ever written.

### Root cause
`ChannelMessageRouter.streamResults()` attached its `provider:normalized-event` listener **after** `createInstance()` resolved. For a freshly-created instance, `createInstance()` resolves only after the first turn has already settled — so the assistant reply (`467045`) had already been emitted before the listener attached. The persistent renderer/mobile listeners caught it; the per-message Discord listener attached too late, its buffer was empty at flush, so nothing was sent (and nothing errored).

This is the structural difference from the mobile gateway, which attaches **one persistent listener at startup** (`mobile-gateway-server.ts:565`) and therefore never races instance creation.

### Fix (implemented)
`src/main/channels/channel-message-router.ts`:
- **Replay-on-attach (new-instance paths):** when `streamResults` attaches for a newly-created instance, it drains any `assistant` output already sitting in the instance's `outputBuffer` and relays it, recording the message ids so the live handler de-dupes. A fresh instance's buffer contains only this turn, so there's nothing stale to re-post. Enabled on `routeDefault` and `handleRunOnCommand`.
- **Attach-before-send (existing-instance paths):** `routeToInstance` and `routeBroadcast` now attach the listener **before** `sendInput`, closing the smaller race for already-running instances (no replay — they must not re-post prior history).
- Live handler skips assistant messages whose id was already replayed.

The buffer is the correct source: the very fact that the live-attach missed the event proves `createInstance` resolves after the turn settles, so the reply is guaranteed to be in the buffer at attach time.

### Verification
- `src/main/channels/__tests__/channel-message-router.spec.ts` — 3 new regression tests (buffered first-turn relays; same-id live event doesn't double-post; existing-instance path doesn't replay history). 52/52 in that file, 159/159 across `src/main/channels`.
- `tsc`, `tsc -p tsconfig.spec.json`, `ng lint`, `check:ts-max-loc` all pass.

## 2. Related defect — safe default working directory (IMPLEMENTED)

**New Discord instances ran with `workingDirectory: "/"`.** `routeDefault` defaulted to `process.cwd()`, which is `/` for the packaged app. In the incident this triggered "Failed to inject repo map: Maximum call stack size exceeded" (scanning the whole filesystem) and a ~36s spawn — and it meant a **yolo-mode agent rooted at the filesystem root**.

### Fix (implemented)
`src/main/channels/channel-message-router.ts`:
- New `resolveDefaultWorkingDirectory()` picks the most-recent **existing, non-root** recent-project directory the user has actually worked in, and falls back to `os.homedir()`. It never returns the filesystem root or an empty path (`isSafeWorkingDirectory` + `directoryExists` guards).
- Replaced every context-less `process.cwd()` default: the default-route case, the `/new` fallback, the `/run-on` fallback, and `routeDefault`'s own parameter default (now resolves lazily when the caller passes nothing).

**Decision (autonomy):** the plan flagged "where should a context-less DM run?" as a product choice. Chosen: prefer the last-used project, else home — this both kills the `/`-root catastrophe and lands the agent where the user was last working. Home is the safe floor.

### Verification
- 2 new regression tests in `channel-message-router.spec.ts` ("never spawns at the filesystem root", "prefers the most-recent existing project directory").

## 3. Mobile-parity improvement backlog (grounded in `mobile-gateway-server.ts`)

The mobile gateway is the mature sibling; these are capabilities it has that the Discord bot lacks.

1. **Surface approval / question prompts. (IMPLEMENTED)** New `src/main/channels/channel-prompt-bridge.ts` (`ChannelPromptBridge`) listens to `instance:input-required` and orchestration `user-action-request` (the same seams the mobile gateway uses). When an agent hits a permission gate or asks a question:
   - It posts the prompt to every channel chat **currently streaming that instance's output** (`ChannelMessageRouter.getWatchingChatsForInstance`, backed by the live output trackers), with Approve/Deny buttons (permission / confirm / switch_mode), one button per option (select_option, ≤4), or the question text (ask_questions).
   - The answer routes back through the button commands `/approve`, `/reject`, `/answer` (adapter `buttonToContent` maps `orch:approve|reject|answer:*` custom_ids), or a plain **yes/no/option/free-text reply** in the same chat (`tryResolveTextReply`, checked before the message is treated as a new turn).
   - Decisions forward to `resumeAfterDeferredPermission` (+ `clearPendingInputRequiredPermission`) for permission gates and `orchestration.respondToUserAction` for user-action requests.
   - When the instance leaves a waiting status (answered on mobile/renderer, or the turn moved on) the pending Discord prompt is dropped so a later message isn't misread as an answer.

   **Verification:** 7 new tests in `channel-message-router.spec.ts` (post to watcher, no-watcher no-op, approve via button, deny via "no", select_option via `/answer`, ask_questions free-text, clear-on-state-change) + 1 in `discord-adapter.spec.ts` (button→command mapping). tsc, spec tsc, ng lint, check:ts-max-loc all pass; `src/main/channels` 169/169.

   **First-turn race (CLOSED, residual):** on a brand-new instance, `createInstance` resolves only after the first turn settles, so the output tracker (and the "who is watching" lookup) doesn't exist when a first-turn prompt fires. The bridge now **buffers** a prompt that arrives with no watcher (`deliverOrBuffer`) and flushes it when a chat starts watching the instance — `streamResults` calls `promptBridge.onInstanceWatched(instanceId)` right after attaching. `clearForInstance` evicts the buffer if the instance stops waiting first; a `MAX_BUFFERED_INSTANCES` cap bounds it. Verified by a regression test (buffer-then-flush-on-attach).

   **Live validation deferred:** exercising the real Discord bot (buttons render, click resumes a real agent) needs a rebuilt app + live bot and is not runnable in-loop → `2026-07-23-discord-bot-parity_livetest.md`.
2. **Reply-complete signal. (IMPLEMENTED)** The premature ✅ at prompt-delivery is removed; the output stream now applies the completion reaction in `finalizeTurn` (inside `streamResults`) when the instance finishes the turn: **✅** on success (`idle`/`waiting_for_input`), **⚠️** on `error`/`failed`. Fires once per turn (`reactedForMessageId` guard) and, for a freshly-created instance already idle at attach, immediately (the replay path detects the settled status). Tests: failure→⚠️, already-idle→✅, and the receipt/completion split.
3. **Agent-produced files/images back to Discord. (IMPLEMENTED)** Assistant output carries attachments as data URLs; `streamResults` accumulates them (`pendingAttachments`) from live events and the first-turn replay, and `src/main/channels/channel-attachment-relay.ts` decodes each to a bounded temp file, sends it via `adapter.sendFile`, dedupes across flushes (`sentAttachmentKeys`), and cleans up. 6 unit tests for the relay + 2 integration tests (relay once, no double-relay).
4. **Tool-activity heartbeat (opt-in). (IMPLEMENTED)** New `channelToolHeartbeat` setting (default **false**). When on, `maybeSendToolHeartbeat` posts one throttled "🛠️ still working… (running X)" line per `TOOL_HEARTBEAT_INTERVAL_MS` (30s) on `tool_use` activity, never once the turn is finalizing. Tests: throttle boundary + off-by-default.
5. **Push-style ping on completion for DMs. (IMPLEMENTED)** `finalizeTurn` sends a concise `✅ Finished (Nm Ns).` message to a DM when a **long** (≥ `DM_COMPLETION_PING_MIN_MS`, 20s) turn completes **silently** (no relayed text — the text reply is itself the notification otherwise), gated by the existing `notifyOnAgentCompletion` preference. Tests: long-silent pings, text-produced doesn't, short doesn't.

Recommendation (original): do #1 and the cwd fix (§2) first. **All backlog items (#1–#5), §2, and the first-turn residual are now implemented and unit-verified.**

## 4. Verification (as-built)

- New/changed: `channel-message-router.ts`, `channel-prompt-bridge.ts` (new), `channel-attachment-relay.ts` (new), `adapters/discord-adapter.ts`, settings key across `settings.types.ts` / `settings-defaults.ts` / `settings-control-policy.ts` / `settings-metadata-integrations.ts`.
- Tests: `channel-message-router.spec.ts` 71/71, `channel-attachment-relay.spec.ts` 6/6, `discord-adapter.spec.ts` 33/33; `src/main/channels` + touched settings specs 209/209.
- Gates: `tsc --noEmit`, `tsc -p tsconfig.spec.json`, `ng lint`, `check:ts-max-loc` all pass (router/discord-adapter ceilings bumped with comments).
- Deferred: live Discord bot validation — recorded in `2026-07-23-discord-bot-parity_livetest.md`.
