# October Phase 5 parked follow-ups

On main: no.

**Status:** active, parked; not implemented. Created 12 October 2026.

Source: [Phase 5 plan](2026-10-10-oct-phase5-later_plan.md). The four sections below were moved unchanged from that plan. They are not completed requirements. Re-evaluate each trigger against current evidence before implementing.

## Read-only trigger evidence, 12 October 2026

1. Codex goal UI: all 2,829 Codex JSONL transcripts scanned; 184 contain last-30-day events. No structured create_goal, update_goal or get_goal calls. Two contain the word create_goal only. The five rotated app logs cover 9–12 October, not 30 days, and ROOT's compiled adapter lacks the newly added instrumentation. No claim of 30 days of instrumented absence is made.
2. Loop fresh-start seam: packaged read-only loop database has **7 runs in the last 30 days**, so the numerical usage threshold passes. A4's context-ceiling-policy module, settings, environment wiring and absolute occupancy ceiling are absent from ROOT and this worktree; the required conjunction fails. Do not report low loop usage as the reason this remains parked.
3. OpenCode wrap-up: zero OpenCode loops in the packaged database (ever and last 30 days). Two OpenCode plan-queue runs are separate. Installed app version is 2.0.18; no live custom-mode/permission probe was run.
4. OpenCode compaction: zero OpenCode loops; no marker reader in this checkout; installed binary lacks opencode/compaction and compaction_summary_chunk strings. A local upstream snapshot contains newer implementation, which does not prove installed support. Live same-thread compaction and permissions remain unverified.

The database was opened with SQLite mode=ro and PRAGMA query_only=ON at /Users/suas/Library/Application Support/harness/loop-mode/loop-mode.db. Cutoff: 2026-09-12 07:00:24 UTC (1789196424195 ms). Query: SELECT COUNT(*) FROM loop_runs WHERE started_at >= ?; grouped provider query uses json_extract(config_json, '$.provider'), COUNT(*), MAX(started_at). Total runs: 141; recent providers Claude 3, Codex 1, Cursor 2, Copilot 1. No provider was launched or external action taken for this audit.

## Step 18. B12: Show Codex's own goal on screen (PARKED; S-M for the row, S for the buttons)

**Before starting:** **parked. Do not build this until it is worth it.**
- **Worth building when:** Harness's log shows "Codex thread goal changed" at least once in the last 30 days (the line
  step 2 adds), or James asks for a "provider goal" mode (`/goal` handing the goal to Codex instead of starting a Harness
  loop; backlog T3-02(c), a separate decision).
- **Evidence today:** no `create_goal` tool call in the 204 Codex session logs on this Mac from the last 30 days
  (`~/.codex/sessions`, read-only search; three logs contain the word only inside command output, never as a call), and
  no "Paused the Codex thread goal" line in the last 3 days of Harness logs. An earlier check also saw one "Could not
  pause the Codex thread goal" warning (which means the goal could not be read, not that one existed); a later re-check
  of the current log files found none, probably because the log had rotated. Either way it does not change the parking
  decision.
- **The trigger is measured by step 2,** which adds the one log line now, so the evidence builds up while this step
  waits.
- No Phase 0 dependency. Shares `instance-communication.ts`, `instance-state.ts`, `instance.store.ts` and the composer
  area with Phase 3 screen work.

**For James:** if Codex sets itself a goal and keeps working on it between your messages, a one-line bar above the message
box says so: what the goal is, how much it has used, and buttons to pause, resume or clear it. Work never continues
silently.

**Verified (10 Oct):**
- **Harness tracks only the goal's status, not the goal (the backlog assumed more).** The Codex turn adapter keeps
  `{ threadId, status }` from `thread/goal/updated` and `thread/goal/cleared`
  (`src/main/cli/adapters/codex-app-server-turn-adapter.ts:68`, `trackThreadGoal` `:108-115`: `const status =
  (notification.params['goal'] as { status?: unknown } | undefined)?.status;`). The objective, tokens used, token budget
  and time used are dropped.
- Codex sends all of them: `ThreadGoalUpdatedNotification { thread_id, turn_id, goal: ThreadGoal }`, and `ThreadGoal`
  carries `objective`, `status`, `token_budget`, `tokens_used`, `time_used_seconds`, `created_at` and `updated_at`
  (Codex source in the reference clone: `codex-rs/app-server-protocol/src/protocol/v2/thread.rs:822-836`, `:2148-2152`).
  Harness's own type keeps only `threadId`, `objective` and `status`
  (`src/main/cli/adapters/codex/app-server-types.ts:303-307`).
- What Harness does with the status today:
  - on Stop, an active goal is paused with `thread/goal/set { status: 'paused' }` and the transcript gets "Paused the
    Codex goal so it does not restart the work by itself. Send a message to continue."
    (`codex-app-server-turn-adapter.ts:130-160`);
  - an active goal counts as Codex owning the next turn (`:162-175`; `src/main/cli/adapters/codex/native-continuation-ownership.ts:5-35`).
- Nothing reaches the screen: no renderer code reads a provider goal (a search of `src/renderer` for
  `providerGoal|goalStatus` finds none).
- Goal changes from Harness should say they came from James: `ThreadGoalSetParams` and `ThreadGoalClearParams` take
  `origin: 'user' | 'automatic'` ("Missing provenance does not supply user authorization", `thread.rs:858-914`), and a
  `user` origin records the change in the thread's history
  (reference clone: `codex-rs/app-server/src/request_processors/thread_goal_processor.rs:199-209`, `:303-306`). Harness's
  typed method map has `thread/goal/get` and `thread/goal/set` without `origin`, and no `thread/goal/clear`
  (`src/main/cli/adapters/codex/app-server-types.ts:504-505`), although the generated list includes `thread/goal/clear`
  (`src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts:20`).
- Codex goals are on by default (reference clone: `codex-rs/features/src/lib.rs:1873-1878`, `Feature::Goals`, `Stage::Stable`,
  `default_enabled: true`). Harness's `/goal` does not use them; it starts a Harness loop
  (`src/main/commands/goal-loop-command.ts`).
- Room: `codex-app-server-turn-adapter.ts` is 697 lines, not allowlisted, so 3 lines of room; `codex-app-server-adapter.ts`
  has none. A rare-fields bag already exists for exactly this kind of state: `extras?: { provider?, desiredRuntime?,
  backgroundWork? }` on `queueUpdate` (`src/main/instance/instance-state.ts:333-345`), carried to the renderer like
  `backgroundWork` (`packages/contracts/src/types/transport.types.ts:140`, `update-batcher.service.ts:65`, `:138`,
  `instance.store.ts:363-365`, `:482-484`).
- The bar's home today is `composer-banners.component.ts` (504 lines), which holds the session bars above the composer,
  such as the quota-park bar with Resume and Cancel (`:33-74`). Its existing buttons use `title=`; the new bar must use
  `appTooltip`. If Phase 3's status strip exists by then (step 16), the row is a chip there instead.

### 18a. The row (S-M)

**For James:** a one-line bar above the message box shows Codex's own goal, how much it has used, and its state.

**Change:**
1. **New `src/main/cli/adapters/codex/thread-goal-tracker.ts`.** Move `trackThreadGoal` and `knownGoalStatus` out of the
   turn adapter (`:108-121`) into a small class that keeps the full snapshot per thread and reports changes. This frees
   about 10 lines in the turn adapter. Parse defensively: an unknown status or missing numbers give `undefined`.
2. Extend Harness's `ThreadGoal` type (`app-server-types.ts:303-307`) with optional `tokenBudget`, `tokensUsed`,
   `timeUsedSeconds` and `updatedAt`.
3. Shared type `ProviderGoalSnapshot` in a **new** `src/shared/types/provider-goal.types.ts` (`src/shared/types/instance.types.ts`
   has only 14 lines of room): `{ provider: 'codex'; objective (clipped to 300 characters); status; tokensUsed?;
   tokenBudget?; timeUsedSeconds?; updatedAt }`. Add only an import and `providerGoal?: ProviderGoalSnapshot;` to
   `Instance` (about 3 lines).
4. The turn adapter emits `this.emit('provider-goal', snapshot | null)` when the tracked goal changes for the current
   thread, and `null` when the thread changes or the goal is cleared (about 2 lines). Adapter events are untyped strings
   (`adapter.on('cost', …)` and the others, `instance-communication.ts:1056-1888`), so this needs no event-map change.
5. **Carry `providerGoal` the same way as `backgroundWork`**:
   - main: `instance-communication.ts` (116 lines of room): `adapter.on('provider-goal', …)` with the existing
     stale-event guard, then `queueUpdate(…, { providerGoal })` through the extras bag; `instance-state.ts:344` (extras
     type), `:381-382` (apply to the live instance) and `:421-425` (merge into the broadcast summary; merge rule as
     `backgroundWork`: `null` clears, `undefined` keeps); **`instance-manager.ts:1359-1367`** (the `queueInstanceUpdate`
     wrapper's parameter type and its `{ backgroundWork: ... }` pass-through; room 11, and the file is dirty);
     `instance-lifecycle.types.ts:80` (the host interface); `instance-communication.types.ts` if it does not already pass
     `extras`;
   - contracts: `packages/contracts/src/types/transport.types.ts:140` (30 lines of room);
   - renderer: `instance.store.ts:363-365` and `:482-484` (43 lines of room), `update-batcher.service.ts:65` and `:138`,
     and the renderer's **own** `Instance` type, `src/renderer/app/core/state/instance/instance.types.ts:204` (a different
     file from `src/shared/types/instance.types.ts`);
   - **`instance-list.store.ts:777-778` maps `backgroundWork` when the list loads, and that file has 0 lines of room**
     (868 lines against ceiling 818 plus 50). Do not edit it. Effect: after a renderer reload the bar returns at Codex's
     next goal update instead of at once. Accept that (rare, and the bar is informational), or extract the
     optional-field mapping into a new file in the same change.
6. **The bar**, one row, only when `providerGoal` is set and not `complete`:
   - active: "Codex is working on its own goal · 12K of 50K tokens · 4 min" (the budget part only when a budget exists);
   - paused: "Codex goal paused"; blocked: "Codex goal blocked"; usage limited: "Codex goal stopped at a usage limit";
     budget limited: "Codex goal reached its token budget";
   - a second line: the objective, shown in the bar itself (a tooltip may not be the only place a state appears);
   - `role="status"`; numbers through the existing compact formatters.
7. The `logger.info('Codex thread goal changed', { status })` line that step 2 adds moves with `trackThreadGoal` into the
   tracker, so the logs keep showing how often goals occur.

**Tests:**
- New `src/main/cli/adapters/codex/thread-goal-tracker.spec.ts`: keeps the objective, tokens and time from `thread/goal/updated`; `cleared`
  gives `null`; a different thread's update is ignored; a malformed payload gives `undefined` fields, not a throw.
- The `codex-app-server-turn-adapter` spec: emits `provider-goal` on change and `null` on clear; the Stop-pause path
  still works (existing cases keep passing).
- `instance-state.spec.ts`: the `providerGoal` merge (`null` clears, `undefined` keeps).
- `composer-banners.component.spec.ts` (or the strip's spec): bar text per status; hidden for `complete` and when unset;
  the objective is shown in the bar; buttons have no `title` attribute.

**Risks:**
- Touches many small files for a feature with no measured use yet. That is why it is parked.
- Codex may change goal payloads; parsing is defensive and the bar hides on an unknown status.

**Done when:**
- A Codex session in which the model calls `create_goal` shows the bar with objective and usage within a second of
  Codex's update. Sessions without a goal show nothing new.

**Live checks:**
- Rebuilt app: in a Codex session, ask "set yourself a goal to … and keep going until it is done" and confirm the bar.

### 18b. Pause, Resume and Clear (S)

**For James:** the bar has Pause, Resume and Clear buttons. Each one tells Codex the change came from you.

**Change:**
1. **IPC** (the repo steps), following the last domain added in `preload.ts` (the permission registry) end to end:
   - channel `instance:provider-goal-action` in `packages/contracts/src/channels/instance.channels.ts` (79 lines), then
     `npm run generate:ipc`;
   - Zod payload `{ instanceId, action: 'pause' | 'resume' | 'clear' }` in a **new**
     `src/shared/validation/provider-goal-schemas.ts`, imported by the handler with a relative path (pattern:
     `src/main/ipc/handlers/permission-registry-handlers.ts:7`). This avoids
     `packages/contracts/src/schemas/instance.schemas.ts` (832 lines against ceiling 825, room 43) and any new alias;
   - handler: new `src/main/ipc/handlers/provider-goal-handlers.ts`, exported from `src/main/ipc/handlers/index.ts` (84
     lines; pattern `:19`). Do not add it to `instance-handlers.ts` (5 lines of room);
   - preload: new `src/preload/domains/provider-goal.preload.ts` plus an import and one
     `...createProviderGoalDomain(ipcRenderer, IPC_CHANNELS),` line in `src/preload/preload.ts` (135 lines; pattern `:54`
     and `:110`). `ElectronAPI` is `typeof electronAPI`, so there is no separate typing step. `instance.preload.ts` stays
     untouched (700 of 700);
   - the renderer facade: a new `provider-goal-ipc.service.ts` in `src/renderer/app/core/services/ipc/` (pattern:
     `permission-registry-ipc.service.ts`), injected into the bar's component;
   - then `npm run verify:ipc` and `npm run verify:ipc-usage`.
2. The handler gets the adapter with `instanceManager.getAdapter(id)` (`instance-manager.ts`, near `:2189` on 10 Oct; the file is dirty) and calls a duck-typed
   `setProviderGoal(action)` that the tracker module implements: `thread/goal/set { threadId, status: 'paused' | 'active',
   origin: 'user' }` or `thread/goal/clear { threadId, origin: 'user' }`. Add `origin` and `thread/goal/clear` to the typed
   method map (`app-server-types.ts:504-505`).
3. Buttons: Pause (when active), Resume (when paused), Clear (always). Tooltips via `appTooltip` and new `TOOLTIP_COPY`
   entries:
   - Resume: "Codex carries on with this goal by itself until it is done or paused."
   - Clear: "Removes Codex's goal. Your conversation stays as it is."
   - Pause: "Stops Codex starting new turns for this goal. Send a message or press Resume to continue."

   The bar text, not the tooltip, states the current status.
4. No setting. No database change.

**Tests:**
- A handler spec: sends `thread/goal/set` with `origin: 'user'`; the IPC verify scripts pass.

**Risks:**
- Resume starts paid work without a new message from James. The tooltip and the bar say so.

**Done when:**
- Pause, Resume and Clear change Codex's goal, confirmed by the next `thread/goal/updated`.

**Live checks:**
- Rebuilt app: in a Codex session with a goal, Pause (no new turns start), Resume (a continuation starts), Clear (the bar
  disappears).

## Step 19. B13: Let a loop ask for a fresh start at a natural seam (PARKED; S-M)

**Before starting:** **parked. Do not build this until it is worth it.**
- **Worth building when:** at least 5 loop runs were started in the last 30 days (`loop_runs.started_at` in the loop
  database, read-only) **and** Phase 1's A4 context ceiling exists. The hand-off is worth most when it lets the agent
  pick a clean point before the ceiling would recycle it mid-task.
- **Evidence today:** the last loop started on 23 Sep (`loop_runs.started_at` 2026-09-23T23:38Z, read-only); 141 runs in
  total (Claude 87, Codex 39, Cursor 14, Copilot 1, OpenCode 0); 16 terminal intents ever recorded (13 `complete`, 3
  `block`, no `fail`, no `wakeup`); 111 of 141 runs were same-session.
- **Order:** after Phase 0 steps 1 (end states) and 11 (anchor), and after Phase 2's B6 (so prompt bytes per round show the
  saving). The wording fix in change 8 below is already done, in step 2.
- Shares `loop-coordinator.ts`, `loop-control.ts` and `default-invokers.ts` with Phase 0 and Phase 2 items.

**For James:** when a loop finishes a stage cleanly, the agent can say "start the next round fresh" and leave a short note
for its successor, instead of carrying a long, expensive conversation forward or being cut off mid-task by the automatic
size limit. You see it in the loop's activity as "Started this round with a clean context at the agent's request".

**Verified (10 Oct):**
- The agent can signal only four things: `export type LoopTerminalIntentKind = 'complete' | 'block' | 'fail' | 'wakeup';`
  (`src/shared/types/loop-state.types.ts:343`). The same list is enforced in the file parser (`loop-control.ts:504-506`),
  the CLI (`loop-control-cli.ts:47-48`) and the contract enum (`packages/contracts/src/schemas/loop.schemas.ts:479`). The
  backlog's line reference is correct.
- The intents table has no check on `kind` (`loop-schema.ts:84-98`, `kind TEXT NOT NULL`), so a new kind needs no
  migration.
- Non-terminal kinds already have a pattern: `block` and `wakeup` are allowed at any boundary (`loop-control.ts:550`), and
  `wakeup` is accepted straight away in the importer rather than parked as `terminalIntentPending`
  (`loop-terminal-intent-importer.ts:84-96`, `:135-138`).
- A one-shot fresh session already exists and is reused by several callers: `completionContext.requestContextReset`
  (`loop-completion-context-store.ts:34-36`) → consumed at the start of the next round (`loop-coordinator.ts:1999`) → the
  full bootstrap prompt is swapped in (`:2015-2027`) → a same-session loop recycles its own adapter
  (`default-invokers.ts:1316-1320`). PLAN→IMPLEMENT (`loop-coordinator.ts:1918-1921`), account and provider failover and
  degraded retries use it today.
- Intent history is already kept on the state (`state.terminalIntentHistory`, `loop-coordinator-state-helpers.ts:210-219`),
  and the last round's verify result is on `state.lastIteration?.verifyStatus` (`loop-state.types.ts:230`, `:450`). A rate
  limit and a "tests are not failing" guard need no new state.
- Pending inputs render as `N. [kind/source] message` under "Direction since last iteration (binding):"
  (`loop-stage-prompt-helpers.ts:17-20`; `loop-continuation-prompt.ts:79`), and the source list is a contract enum
  (`packages/contracts/src/schemas/loop-pending-input.schemas.ts:13-17`) **and** a TypeScript union
  (`src/shared/types/loop-state.types.ts:87-98`, last entry `| 'idle-nudge';`; 633 lines, 67 of room). Nothing else lists
  the sources.
- The existing recycle note is small: at most 1,200 characters injected and 2,800 bytes rehydrated
  (`loop-recycle-handoff.ts:19-23`). The Workboard titles each resolved intent kind
  (`src/main/workboard/operational-decision-projection.ts:77-95`).
- `scheduleWakeupIntent` and `pauseForBlockIntentAction` already live in `loop-terminal-intent-actions.ts` (180 lines)
  with the same parameter shape as the planned `applyLoopHandoffIntent`. That file is a natural alternative home; the new
  `loop-handoff-intent.ts` below keeps a self-contained diff and spec.

**Change:**
1. **Kind:** add `'handoff'` to `LoopTerminalIntentKind` (`loop-state.types.ts:343`), `LoopTerminalIntentKindSchema`
   (`loop.schemas.ts:479`), the parser check and its error text (`loop-control.ts:504-506`), and the non-terminal rule
   (`loop-control.ts:550`: `raw.kind !== 'block' && raw.kind !== 'wakeup' && raw.kind !== 'handoff'`). All are same-line
   edits.
2. **CLI:** `aio-loop-control handoff --summary "<what is done, what is next, what the next session must know>"` in
   `loop-control-cli.ts` (`:47-48` verb list, `:105` keeps `--resume-in` wakeup-only, usage text `:144-147`). The summary
   keeps the existing 4,096-character limit; the note passed on is clipped to 1,200 characters with
   `clipHandoffInjectNote` (`loop-recycle-handoff.ts:64-75`).
3. **New `src/main/orchestration/loop-handoff-intent.ts`** (about 90 lines), `applyLoopHandoffIntent({ state, intent,
   transitionTerminalIntent, requestContextReset, emit })`:
   - reject, with the reason recorded on the intent, when:
     - the last round's verify failed (`state.lastIteration?.verifyStatus === 'failed'`): "The checks failed this round.
       Fix them in this session, then hand off.";
     - an accepted hand-off exists within the previous two rounds (from `terminalIntentHistory`): "One hand-off per three
       rounds.";
     - ten hand-offs were already accepted in this run;
   - otherwise accept; for a same-session loop call `requestContextReset(state.id)`; for a fresh-child loop do not (every
     round already starts fresh);
   - push `createLoopPendingInput(note, { source: 'handoff' })`, where the note is "Your previous session chose to start
     fresh here and left this note: <clipped summary>";
   - emit `loop:activity` with the plain message "Started this round with a clean context at the agent's request: <first 160 characters of
     the note>" (or "Fresh-start request declined: <reason>").
4. **Importer:** in `loop-terminal-intent-importer.ts`, treat `handoff` like `wakeup`: accepted immediately, never
   `terminalIntentPending`; call `applyLoopHandoffIntent` after the archive step (the `:135-138` pattern). Add one option,
   `requestContextReset?: (loopRunId: string) => void`.
5. **Coordinator:** one line in `importTerminalIntentsForBoundary` (`loop-coordinator.ts:3752-3765`):
   `requestContextReset: (loopRunId) => this.completionContext.requestContextReset(loopRunId),`.
6. **Contract:** add `'handoff'` to `LoopPendingInputSourceSchema` (`loop-pending-input.schemas.ts:13-17`) **and** to the
   `LoopPendingInputSource` union (`loop-state.types.ts:87-98`), or `createLoopPendingInput(note, { source: 'handoff' })`
   will not typecheck.
7. **Prompt:** extend the verbs line in `summarizeLoopControlPrompt` (`loop-control.ts:466`) only: "- Verbs: complete,
   block, wakeup, fail, handoff. Each needs --summary; wakeup also --resume-in "<seconds>"; handoff starts the next round
   with a clean context and your summary as its note, so use it when a stage is finished and its checks pass." That line
   grows from 98 to 244 characters, so every round's prompt carries about 145 more characters (measured 10 Oct; an
   earlier draft said about 70). The full rule (one per three rounds, not after a failed check) lives in the CLI usage
   text and in the rejection reasons, which the agent sees when it matters.
8. **Wording fix:** done in step 2.
9. **Workboard:** in `operational-decision-projection.ts:79-93` add `case 'handoff': return { title: accepted ? 'Started
   this round with a clean context at the agent's request' : 'Fresh-start request declined' };`.

**Tests:**
- `loop-control.spec.ts`: a CLI-written `handoff` intent imports at a non-terminal boundary (fails today: "Intent kind
  must be complete, block, fail, or wakeup"); `--resume-in` on handoff is refused.
- `loop-control-cli.spec.ts`: `handoff --summary` writes kind `handoff`.
- New `loop-handoff-intent.spec.ts`: accepted in a same-session loop calls `requestContextReset`; a fresh-child loop does
  not; the note is clipped to 1,200 characters and queued with source `handoff`; rejected after a failed verify, within
  two rounds of the last accepted hand-off, and after ten; each rejection carries its reason.
- `loop-terminal-intent-importer.spec.ts`: a hand-off is accepted at once and never becomes `terminalIntentPending`.
- A focused `loop-coordinator` spec: a hand-off recorded in round 3 makes round 4 call `invokeChild` with
  `forceContextReset === true` and the full bootstrap prompt.
- `operational-decision-projection.spec.ts`: both titles.

**Risks:**
- An agent could hand off too often, paying a fresh start-up each time. The three-round spacing, the run cap of ten and
  the failed-check guard bound it.
- A loop that borrows the chat's own session cannot recycle it (`default-invokers.ts:1316` needs
  `persistentLoopAdapters.has(...)`). The hand-off then only re-sends the full bootstrap into the chat, as PLAN→IMPLEMENT
  already does there. Acceptable while loops are idle.
- A pending reset lives in memory (`loop-completion-context-store.ts:7`). The three `buildLoopCheckpoint` call sites
  (`loop-handlers.ts:82`, `:102`, `:163`) never pass `pendingContextReset`, so it is stored as `false` (`loop-checkpoint.ts:37`)
  although `loop-coordinator.ts:1328` would restore it (Phase 0, "Found on the way" 7). A restart between the hand-off and
  the next round loses the reset, and the round continues in the old session. Harmless.
- The agent's claim "tests are green" cannot be checked; the guard uses the last recorded verify result.
- Space: `loop-coordinator.ts` has 12 lines of room shared with Phase 0 steps 1, 2 and 11; this step needs 1.
  `loop-control.ts` is at 686 of 700; this step needs about 3. `default-invokers.ts` needs 0 (step 2 did the text edit).

**Done when:**
- In a same-session test loop, an agent that runs `aio-loop-control handoff --summary "…"` in round N starts round N+1
  with a clean context whose prompt carries the full goal and its note, and the activity feed says so in plain words.
- A second hand-off in round N+1 or N+2 is declined with its reason; a hand-off after a failed check is declined.
- No migration; all listed specs pass; `npm run check:ts-max-loc` passes.

**Live checks:**
- Rebuilt app, one short same-session Claude loop on a toy plan with two stages. Ask in the goal for a hand-off after
  stage 1. Confirm round N+1's first prompt and the Workboard entry.

## Step 20. B11a: OpenCode's locked wrap-up round (PARKED; XS probe, then S-M)

**Before starting:** **parked. Do not build this until it is worth it.**
- **Worth building when:** at least 1 OpenCode loop run was started in the last 30 days (`loop_runs` in the loop
  database: `started_at`, with the provider inside `config_json`), or James says he is about to start some. Evidence
  today: 0 OpenCode loop runs of 141, and 2 OpenCode plan-queue runs of 58.
- The probe (20a) can run earlier for a few cents if James wants the answer sooner. It needs OpenCode 2.0.18 and a cheap
  model, and no Harness rebuild.
- The build (20b) also waits for: the other session's ACP/MiMo work in `acp-cli-adapter.ts`, `acp-session-config-options.ts`
  and `opencode-adapter-factory.ts` to be committed; Phase 1's A6.3 (turn cap becomes `steps`, "the other half of
  parity") and A6.4; and Phase 2's `/goal` providers item (backlog B11.0, which lets `/goal` start from OpenCode and Grok
  sessions; **not repeated here**).
- **Live steering (B11b) is not planned** (choice 1). See "Not in this plan".

**For James:** OpenCode has never run one of your loops. If you start using it for loops, its last round before a limit
would be locked to "write your hand-off notes" the way Claude's is. Typing a correction into a running loop would still
reach it at the next round, not mid-round.

**Verified (10 Oct):**
- **Harness runs OpenCode 2.0.18 on this Mac, not 1.x.** Harness logs say `OpenCode CLI could not read its database; using
  another install` with `"major":2`, 12 times between 7 and 10 Oct; the 1.18.35 CLI on PATH is skipped and
  `/Applications/OpenCode.app/Contents/Resources/opencode-cli` (2.0.18) is used. For a 2.x launch Harness starts **no
  local HTTP server** (`opencode-adapter-factory.ts` `prepareSpawn`: `serveHttp: launch.major < 2`;
  `opencode-child-progress-source.ts:319-323`). The reference clone is 1.18.35, so anything about 2.x is read from the
  installed binary's strings or from OpenCode's `origin/v2` source, and is marked inferred.
- **The wrap-up round is enforced only for Claude:** `const WRAP_UP_TOOLS_DISABLE_PROVIDERS ... = new Set(['claude']);`
  (`src/main/orchestration/loop-tools-disable.ts:109`). Other providers skip the wrap-up round entirely
  (`loop-pre-iteration-guard.ts:84-87`, `&& providerEnforcesWrapUpToolsDisable(state.config.provider)`). The invoker
  applies the lock duck-typed through `setDisallowedToolsOverride` (`default-invokers.ts:323`;
  `loop-tools-disable.ts:77-92`).
- Harness writes only two ACP session settings, `'model' | 'effort'` (`acp-session-config-options.ts:27`,
  `AcpSessionConfigKey`); OpenCode 1.18 also offers a `mode` setting (comment at `:13`).
- **The installed 2.0.18 advertises a session-mode option over ACP:** a string search of the binary finds
  `{id:"mode",name:"Session Mode",category:"mode",type:"select",currentValue:e.currentModeId,options:e.modes.` and
  `session/set_config_option` (`grep -a`, not a run). In OpenCode's v2 source the mode list is every agent that is neither
  a subagent nor hidden (`packages/cli/src/acp/catalog.ts:155`, `agent.mode !== "subagent" && !agent.hidden`), and a mode
  change is accepted by agent id (`config-option.ts`, `case "mode"`; the ACP port landed 2026-07-21, commit
  `cf651bc41b`), so a config-defined `mode: "primary"` agent called `aio-wrapup` should be selectable. **Still unproven
  (inferred, not run):** (1) that 2.0.18 accepts the 1.x-style `agent` block in `OPENCODE_CONFIG_CONTENT` (Phase 1's
  reports say 2.x migrates 1.x `agent.<id>` keys) and lists it in `session/new`, and (2) that the agent's `permission`
  rules are enforced after the switch.
- OpenCode 1.x can express the restricted agent: agent config has `mode: 'subagent' | 'primary' | 'all'`, `steps` and
  `permission` (`opencode/packages/core/src/v1/config/agent.ts:24-38`), and permissions take per-path rules
  (`opencode/packages/opencode/src/permission/index.ts:186-197`). A primary agent cannot be hidden from OpenCode's own mode
  list (`hidden` applies to subagents only, `agent.ts:27-28`).
- **Live steering has no working path for any loop provider:**
  - the loop's switch is a single coordinator-wide flag, always false, and even when true `intervene('steer')` only queues
    for the next round (`loop-coordinator.ts:1445-1478`, `:1489-1495`); nothing delivers a steer mid-round;
  - the ACP adapter refuses a second message during a turn ("Cannot send message: the previous turn is still running.")
    and declares `liveSteer: false` (`getAdapterCapabilities`);
  - OpenCode's `prompt_async` is a 1.x HTTP route, and Harness starts no HTTP server for 2.x; on 1.x the server exists but
    Harness only reads it during sub-agent tasks;
  - Codex has `turn/steer`, but Harness uses it only for turns Codex started itself
    (`src/main/cli/adapters/codex/app-server-thread-runtime.ts:237-250`, `active.origin !== 'provider'` returns "not delivered").
- **Numbers and anchors move.** `acp-cli-adapter.ts` is now 2,566 lines (2,522 earlier on 10 Oct). With the other session's
  uncommitted ceiling raise (2,530 plus 50 = 2,580) room is 14; against the committed ceiling (2,437 plus 50 = 2,487) it
  is 79 over. Cite function names, not lines.

### 20a. The probe (XS)

**For James:** a quick test, run by hand on a scratch folder, that shows whether OpenCode can really be locked to "notes
only" for its last round.

**Change:**
1. In a scratch folder, drive `/Applications/OpenCode.app/Contents/Resources/opencode-cli acp` with JSON-RPC lines and an
   `OPENCODE_CONFIG_CONTENT` that defines the agent in 20b. **Pass** if:
   - `session/new` lists a `mode` option that includes `aio-wrapup`;
   - `session/set_config_option` switches to it;
   - a shell command is refused;
   - an edit to `NOTES.md` is allowed;
   - an edit to any other file is refused.
2. Record the raw lines in the as-built notes. If 2.x has no mode option or ignores the agent block, stop here: OpenCode
   stays prompt-only for the wrap-up, and 20b is dropped.

**Tests:** none (a manual probe).

**Risks:** none for the app; it touches only a scratch folder and a cheap model.

**Done when:** the pass or fail result and the raw lines are recorded.

**Live checks:** this is the live check. It needs OpenCode 2.0.18 and a cheap model; no Harness rebuild.

### 20b. The build (S-M; only if the probe passes)

**For James:** an OpenCode loop at its round cap gets one wrap-up round that can only update the loop notes, and the next
session is back in the normal mode.

**Change:**
1. **New `src/main/cli/adapters/opencode-wrapup-agent.ts`** (about 60 lines): for loop spawns only (add an explicit spawn
   option such as `loopWrapUpAgent: true`, set in `createPersistentLoopAdapter`, `default-loop-invoker-helpers.ts:49-62`),
   add this to the config overlay: `agent['aio-wrapup'] = { mode: 'primary', description: 'Harness loop wrap-up: update
   the loop notes only', permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: {
   '*': 'deny', '**/LOOP_TASKS.md': 'allow', '**/NOTES.md': 'allow' } } }`. Call it in `prepareSpawn` before the
   permission assert, and let `assertOpenCodePermissionPolicy` accept exactly this block.
2. **New `src/main/cli/adapters/acp-mode-override.ts`** (about 50 lines): `setDisallowedToolsOverride(tools | null)` on the
   ACP adapter records "use `aio-wrapup` on the next prompt" or "go back to the previous mode". Send the switch through the
   existing writer, `applyAcpSessionConfig` (`acp-session-config-options.ts`), adding `mode` to `AcpSessionConfigKey`,
   `AcpSessionConfigRequest` and `CONFIG_KEY_CATEGORIES` (`mode: 'mode'`), just before `session/prompt` (3-5 lines in the
   adapter). If the agent offers no mode option or rejects the switch, the send fails with "Wrap-up mode unavailable", so
   the loop ends on its cap without an unlocked wrap-up round.
   - The other session's uncommitted change to `applyAcpSessionConfig` (an optional `getCurrentOptions` argument, and a
     warning "the agent did not confirm the selected value") is exactly the failure this must turn into "Wrap-up mode
     unavailable". Wait for it to land instead of writing a second path inside `acp-cli-adapter.ts`.
3. Add `'opencode'` to `WRAP_UP_TOOLS_DISABLE_PROVIDERS` and its comment (`loop-tools-disable.ts:1-29`, `:109`).

**Tests:**
- `opencode-wrapup-agent.spec.ts`: the block is added only for loop spawns; the exact rules; the permission assert accepts
  it.
- `acp-mode-override.spec.ts`: switch before the next prompt; restore on `null`; no mode option fails the send.
- `loop-tools-disable.spec.ts`: the pairing includes `opencode`.
- `loop-pre-iteration-guard.spec.ts`: an OpenCode loop at its iteration cap gets the wrap-up round.

**Risks:**
- `aio-wrapup` shows in OpenCode's own mode list for loop sessions.
- The mode switch happens only on the wrap-up send. If that turn fails, the session stays in `aio-wrapup` until the next
  send restores it, which for a wrap-up is normally never.
- 2.x may not accept the 1.x agent shape; the probe decides.
- `acp-cli-adapter.ts` and `opencode-adapter-factory.ts` carry another session's uncommitted MiMo work.

**Done when:**
- An OpenCode loop at its round cap runs one wrap-up round in `aio-wrapup`; a shell command there is refused by OpenCode;
  `NOTES.md` and `LOOP_TASKS.md` are updated; the next session (if any) is back in the default mode.

**Live checks:**
- Rebuilt app: an OpenCode loop with a two-round cap on a toy plan. Confirm the wrap-up round and the refused shell
  command in the transcript.

## Step 21. A3.OC: OpenCode compaction as a loop re-anchor signal (PARKED; S, plus S-M for the part that saves money)

**Before starting:** **parked and blocked. Do not build this until it is worth it.**
- **Worth building when all three are true:** (a) Phase 1's A6.5 (the OpenCode marker reader, `opencode-acp-markers.ts`)
  has landed; (b) the installed OpenCode is 2.0.2x or later; (c) at least 1 OpenCode loop run was started in the last 30
  days.
- After Phase 0 step 11 and Phase 1's A6.4 and A6.5. It also needs the same-thread proof below (S-M) to save anything.
- The other session's ACP/MiMo work in `acp-cli-adapter.ts` (about +90 lines), `acp-session-config-options.ts`,
  `opencode-adapter-factory.ts` and `opencode-generation-budget.ts` is still uncommitted; this step edits the first of
  those, so wait.

**For James:** nothing to notice today. OpenCode loop rounds already resend the full loop instructions every round, so
there is nothing for an OpenCode "I summarised my history" signal to correct. It matters only once OpenCode loops are made
cheaper the way Phase 0 makes Claude's.

**Verified (10 Oct):**
- **OpenCode rounds always get the full re-anchor.** Non-Copilot ACP sessions report the conservative capabilities
  (`acp-cli-adapter.ts` `getContextCapabilities` → `base-cli-adapter.ts:498-499` → `CONSERVATIVE_PROVIDER_CONTEXT_CAPABILITIES
  ... sameThreadContinuation: false`, `packages/contracts/src/types/context-evidence.types.ts:121-130`), so
  `shouldReanchorLoopGoal` returns true every round (`loop-goal-reanchor.ts:28`). Phase 0 step 11 leaves ACP unchanged
  ("Gemini, ACP and Codex exec are unchanged"). A compaction signal would have no short card to cancel.
- **The installed OpenCode 2.0.18 does not send a compaction marker.** The marker is new: `packages/cli/src/acp/compaction.ts`
  on OpenCode's `origin/v2`, first commit `ebad4bc84c` "feat(acp): report compaction with standard session updates",
  dated 2026-10-02. The app was built 26 Sep (`stat` of `/Applications/OpenCode.app/Contents/Resources/opencode-cli`). A
  `grep -a -c` over that binary gives 0 lines for `opencode/compaction` and 0 for `compaction_summary_chunk`, against 2
  for `opencode/retry` and 6 for `session.compaction.started`. So Phase 1's retry notices work on this Mac today, but a
  compaction marker needs a newer OpenCode app (2.0.2x or later).
- **The frame Harness will receive.** Harness declares **empty** client capabilities for every ACP agent
  (`acp-cli-adapter.ts`, `DEFAULT_CLIENT_CAPABILITIES: AcpClientCapabilities = {}`, sent in `initialize`), and OpenCode
  uses the standard `compaction_update` frames only when the client declares `session.compaction`
  (`packages/cli/src/acp/capabilities.ts:9-13`). Without it, OpenCode sends `{ sessionUpdate: "session_info_update", _meta:
  { "opencode/compaction": { status, messageId, reason } } }`. Keep the capabilities empty so the marker form is the only
  one Phase 1's A6.5 must read. Today that frame is dropped: the `case 'session_info_update':` branch of the ACP
  adapter only calls `logger.debug('ACP session metadata update', ...)`.
- **The marker path is ready.** Any adapter output message with `metadata.threadCompacted === true` becomes a compaction
  marker, an observed compaction and a boundary, with no edit to `instance-event-forwarding.ts` (0 lines of room):
  `:62-64`, `:215-244`. Codex already does this (`src/main/cli/adapters/codex/compaction-presentation.ts:23-31`;
  `codex-app-server-adapter.ts:341-356`).
- **CORRECTION for Phase 1's A6.5 and for any plan that copies it:** "off the SSE stream AIO already opens" is wrong twice
  over. That stream is open only during sub-agent tasks on 1.x (`acp-delegated-task-liveness.ts:46`, `:60-65`), and it is
  not started at all for 2.x (`opencode-adapter-factory.ts` `prepareSpawn`, `serveHttp: launch.major < 2`).
- Phase 1's A6.4 plans an `opencode-acp` context profile in `getContextCapabilities()`; the same-thread proof below
  should extend that profile, not add a second one.

**Change (when wanted; not now):**
1. **The same-thread proof (S-M; the part that saves money).** The ACP adapter (OpenCode profile only) reports
   `sameThreadContinuation: true` only when this round's prompt went to the same ACP session id the previous round used,
   mirroring Phase 0 step 11's "confirmed native resume" rule for Claude. Without it, OpenCode same-session loops keep
   resending about 8.7 KB of re-anchor per round.
2. **The signal (S).** Count a completed compaction per turn in the OpenCode ACP profile and expose `getTurnCompaction()`
   the way Phase 0 step 11 does for Claude and Codex (the `claude-compaction-observer.ts` pattern). Put the counter inside
   Phase 1's `opencode-acp-markers.ts`, or in a 30-line `opencode-compaction-observer.ts`, with at most 3 lines added to
   `acp-cli-adapter.ts`. Phase 1's marker reader already emits the `threadCompacted` system message this relies on; no
   second event reader is needed.
3. `loop-goal-reanchor.ts` needs no change: Phase 0's `providerCompacted` already drops the stored caps.
4. **Dropped:** the always-on event-stream reader for OpenCode 1.x (Harness skips the 1.x CLI on this Mac; only a worker PC
   with a 1.x install would use it) and the inferred "used tokens fell by half" signal for 2.0.18 (it can misfire, and
   OpenCode rounds re-anchor in full anyway). If a worker PC runs 1.x loops, accept the full re-anchor.

**Tests:**
- The OpenCode-profile `acp-cli-adapter` spec: the same session id across two rounds reports
  `sameThreadContinuation: true`; a new session id does not.
- A spec for the counter: a completed compaction marker in a turn is counted once, and the counter resets each turn.
- `loop-goal-reanchor.spec.ts`: an OpenCode round after a compaction gets the full re-anchor.

**Risks:**
- A wrong same-thread proof would drop the goal from a round that did not really continue. Keep Phase 0 step 11's
  fail-closed rules and its 10-round backstop.
- `acp-cli-adapter.ts` has 14 lines of room only if the other session's ceiling raise lands.

**Done when:**
- An OpenCode same-session loop sends the short card plus anchor on ordinary rounds and the full re-anchor on the round
  after OpenCode compacts.

**Live checks:**
- A real OpenCode 2.0.2x (or later) session pushed past its compaction point (a low `limit.context` in the overlay), to
  see what the app sends over ACP.

---

