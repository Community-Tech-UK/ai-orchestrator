# Plan Queue programme: 'Land anyway' when a person says so — implementation plan

**Status:** Implemented 5 November 2026 in the queue worktree and verified there (see As-built notes; round 3 fix of 8 November replaced Claude's order-based attribution with the CLI's message ids); waiting for the independent check. Real-provider, phone, voice and restart checks are deferred to [2026-11-04-pq-b1-land-anyway_plan_livetest.md](2026-11-04-pq-b1-land-anyway_plan_livetest.md). Written 4 November 2026 as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md).

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Decisions → Decision 6
- Evidence → Code facts (Unverified Land anyway; Harness does not record whether a person typed a message; Land anyway records James whoever asked)
- Phases → Phase 1 (step 1.7)
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

This changes who is allowed to land work without a passing check, so be exact and cautious. Read `plan-queue-control-authority.ts`, `plan-queue-item-landing.ts`, `instance-handlers.ts`, `mobile-gateway-instance-routes.ts`, `thin-client-instance-commands.ts`, the renderer messaging store and `conversation-message-source-query.ts` whole before editing. Every refusal case listed in the step must have a test, each guard mutation-checked. Adapters must report when a turn starts (Claude CLI background turns, Codex goal turns); a provider that cannot report is refused for this.

## Steps (copied verbatim from the programme plan)

- [x] 1.7 **"Land anyway" when a person says so (Decision 6).** After Phase 0, because it needs Phase C's item
  events. `land-anyway` without a PASS verdict is allowed:
  - from the Plan Queue page; or
  - from the run's parent session, when the call comes from the turn started by a message a person typed, in
    Harness or on the phone, after the item parked.

  Three things are checked:
  - **The latest input of any kind is that message.** Harness's own notices count as input here; they are stored
    as system messages (`instance-manager.ts:1718`). So a parent woken by a queue notice, an automation or another
    agent's message can't use an older message from James.
  - **No other turn has started since.** The Claude CLI can start a turn by itself after a background job ends,
    with no new input (`claude-cli-async-work.ts:195-201`); Codex can too, for goal turns
    (`codex-app-server-turn-adapter.ts:201`).
    - Each adapter reports when a turn starts, and Harness keeps a count per session. When the turn a person's
      message starts has begun, the count at that moment is saved with the message. The call is allowed only while
      the session's count still equals it.
    - A provider that can't report turn starts is refused for this.
    - The count isn't kept across a restart. After one, James sends a new message first.
  - **The message came after the item parked.** The park time comes from Phase C's item events, not the row's
    `updated_at`, which later saves change.

  Everything else is refused with a plain reason: queue workers and checkers, and the stranded-run rescuer
  (land-anyway isn't a rescue action, `plan-queue-control-authority.ts:28-32`). The conversation ledger already
  answers "latest user or Harness input" (`conversation-message-source-query.ts:52`, `getLatestInputSource` at
  `:77`). It is asynchronous, so the
  check runs before the synchronous authority check.
  - **It checks who spoke, not what they said.** An agent could still misread a person's message, so the note
    points to that message and James can see what the landing was based on.
  - **Recording who typed a message.** `sendInput` gains an origin, "person", kept separate from the existing
    `automatedInput` flag. It marks only words James typed or spoke himself. It is set:
    - by the renderer for text typed in the message box, and for voice;
    - on a message typed while the session was busy, carried on the queued entry, so it keeps the mark when it is
      sent later (today those go out as `automatedInput`, `instance-messaging.store.ts:710-716`);
    - by the phone's send route (`mobile-gateway-instance-routes.ts:388`).

    Messages built by the app that carry an agent's words don't get it, even when James clicks to send them: a
    review or diff packet (built from reviewer findings) and a question-card answer (which repeats the agent's
    question). The desktop send handler passes the origin on (`instance-handlers.ts:236-241`); the thin-client
    route (`thin-client-instance-commands.ts:61-70`) doesn't. It is stored on the user message so it survives a
    restart. Every other caller leaves it unset, and a message without it, including every older one, counts as
    not a person.
  - **Steering a running turn isn't marked in this version** (`instance-handlers.ts:258-260`,
    `mobile-gateway-instance-routes.ts:375`). An instruction sent that way doesn't count; James sends it as a
    normal message instead.
  - **The note names the real actor** instead of always "James" (`plan-queue-item-landing.ts:140-141`): "from the
    Plan Queue page", or "by the session that started the run, after James's message at 14:02". Neither the commit
    nor a Linear comment quotes the message itself; the queue's event record keeps a reference to it.
  - A PASS item parked `land-blocked` still goes through `retryLanding`, so its document is still closed.
  - Tests:
    - allowed: a typed message, a phone message, and a message typed while the session was busy and sent later;
    - refused: an automation prompt, another agent's message, a review packet or question-card answer, a steered
      message, a queue notice after James's message, a turn the Claude CLI or Codex started by itself after James's
      message, a message from before the park, a provider that can't report turn starts, a queue session, and the
      rescuer;
    - after a restart, the origin is still on the stored message, but the call is refused until James sends a new
      one; an older message without an origin is refused. S.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- Every 'allowed' and every 'refused' test case listed in the step exists and passes.
- The landing note names the real actor ('from the Plan Queue page' or 'by the session that started the run, after James's message at HH:MM'), not always 'James'.
- The 'person' origin is stored on user messages typed in Harness, spoken, sent from the phone, or typed while busy, and on no other path.
- No existing behaviour of the Plan Queue page's Land anyway button changes.
- Every bullet of the step text above is met, or this plan's as-built notes say plainly, with the reason, which part was not and what remains.

## Verification

Run the targeted tests for what you changed, then:

- `npx tsc --noEmit`
- `npm run typecheck:spec`
- `npm run lint`
- `npm run check:ts-max-loc`
- `npm run check:ui-hints`
- `npm run build:main`
- `npm run build:renderer`
- `npm run test:quiet`

(Known: three `scripts/__tests__` tests fail on this machine because the installed Vite is older than `package.json` asks for; that is an environment fault, not yours. Say so rather than hide it.)

## Checklist

- [x] Step 1.7 implemented, wired, tested and verified (live checks deferred to the livetest document)
- [x] As-built notes written below

## As-built notes

Built 5 November 2026 in the queue worktree. The verification results are at the end.

### What was built

- **A person's message is marked.** `sendInput` takes `origin: { kind: 'person', typedAt }` (`PersonInputOrigin`, `src/shared/types/input-provenance.types.ts`), separate from `automatedInput`. `InstanceManager.sendInput` stores it on the user message as `metadata.inputOrigin`, so it survives a restart (`instance-manager.ts`). It is ignored when the text is Harness-written (`internalSource`), cross-session or an auto-continuation. A time in the future is cut back to now. The origin is set only by:
  - the message box and voice (the composer's `sendMessage` event is bound to `InstanceDetailComponent.onComposerSend` → `InstanceStore.sendInput(..., { typedByPerson: true })`; voice sends through the same event) and by the history-preview composer, which is also the message box;
  - a typed message that waited because the session was busy, hibernated or terminated: the mark is on the queue entry (`QueuedMessage.origin`) and rides through drains, retries and Pause re-queues (`instance-messaging-queue-utils.ts`), so it goes out as `automatedInput` (as before) plus the mark;
  - the phone's send route (`MobileGatewayInstanceRoutes.dispatchSend`), including phone messages that waited in the phone's own queue.
  Nothing else sets it. A queued entry promoted to a steer loses the mark (`toSteerEntry`). Steering from the desktop and the phone, the cross-model review feedback (`instance-detail.component.ts`, now `sendFromApp`), review and diff packets, and question-card answers send no origin; their specs assert that.
- **The typed time travels with the mark** (`typedAt`, not in the plan's text). A message typed while the session was busy but sent after the item parked would otherwise count as "after the park" although James wrote it before seeing the parked item. The park check compares the typed time. The phone's queue hands its `enqueuedAt` through for the same reason.
- **The desktop IPC route passes the origin on; the thin-client route does not** (`INSTANCE_SEND_INPUT` schema in `packages/contracts/src/schemas/instance.schemas.ts` is strict and shared by both; `instance-handlers.ts`, preload type and renderer IPC service pass it. `thin-client-instance-commands.ts` accepts the field but drops it, as the step requires, so a thin-client caller cannot mark text as typed by a person; round 4 fix below).
- **Turn starts are reported by the adapters, and counted per session.** New adapter event `turn_started`, and `AdapterCapabilities.reportsTurnStarts`:
  - Claude CLI: emitted on every `system` `init` message (a turn Harness sends and one the CLI starts itself after background work ends); capability always true. `ClaudeTurnStartTracker` ties an `init` to Harness's message by the uuid in the CLI's `command_lifecycle` lines (deviation 6).
> Earlier journal sections moved to `2026-11-04-pq-b1-land-anyway_plan_history_7c2b8b65a518d3417ebeb4043e43e717426d775274e866955e7e4b8c24cd1e06_completed.md`.
