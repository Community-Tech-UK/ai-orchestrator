# Session-linked sidechats implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. Use independent agents only for genuinely independent work, and a fresh task-completion-gate verifier for final completion. Read the spec and this plan together.

**Status:** Completed 2026-10-06. Built by the Plan Queue, passed its independent verifier in round 2, and landed on `main` as `1b06fffee`. James confirmed product decisions 1–3 on 2026-10-02: several sidechats per session, context refreshed on each question, and the parent's edit permissions. Checks that need real provider turns or the `windows-pc` worker are deferred to [2026-10-02-session-sidechats_livetest.md](2026-10-02-session-sidechats_livetest.md).
**Goal:** Let James ask any available provider about a linked session, retain that relationship across lifecycle changes, and discover sidechat activity and unread answers while the panel is closed.
**Architecture:** Retain ChatService, ledger and provider runtime infrastructure. Add durable sidechat relationships and read state, a parent resolver/context builder, and session-scoped UI state above the panel lifetime. Keep parent and sidechat execution separate.
**Tech stack:** Electron 40, Angular 22 signals and OnPush, TypeScript, better-sqlite3, Zod 4, Vitest.
**Spec:** [Session-linked sidechats design](2026-10-02-session-sidechats_spec_completed.md)

## Global constraints

- Planning only in the current checkout. No branch, worktree, commit, push, deployment or worker restart. (Planning-phase constraint; implementation ran in the Plan Queue worktree, with commits left to the coordinator.)
- Preserve all unrelated dirty-tree work, particularly the active provider-hardening implementation.
- Read whole implementation files, callers, types and adjacent tests before changing them. The file map below is a planning map, not proof all execution paths have been investigated.
- Existing chats and transcripts survive migration. Legacy sidechats are not assigned to guessed parents.
- Available provider means end-to-end runtime support, not merely picker visibility or TypeScript membership.
- Honour parent workspace/node identity; never interpret a worker path as a local path.
- Inherit the parent's effective edit permissions through runtime/tool enforcement, including approval posture and workspace/sandbox scope. Do not rely on prompt text, `yoloMode` alone, or silently upgrade authority on provider changes.
- Markdown is canonical. Keep active docs untracked and HTML under ignored `.aio-review/`.
- Keep each new TypeScript unit focused; do not extend the already large chat service with an entire subsystem.

## Review focus

1. Session A and B share a directory: a late context/detail request must never land in the wrong panel. Pin in tasks 2 and 5.
2. Parent resumes into a new runtime, switches provider, or rewinds: ownership stays stable and context invalidation handles reused sequences. Pin in tasks 1 and 2.
3. An answer arrives during read acknowledgement or while scrolled up: unseen content remains unread, including after restart. Pin in tasks 4 and 5.
4. A provider is accepted by the picker but rejected or erased on persisted reload; local target/node metadata is lost. Pin in task 3.
5. A sidechat broadens a restricted parent's write/shell/MCP permissions, misses a parent policy change, or a provider switch stops an active answer unexpectedly. Pin in task 3.

## Proposed interfaces

These are new interfaces to implement, not claims about existing exported APIs. The authority field records a policy to resolve from the parent, rather than an independent edit/read-only switch.

```ts
export type SideChatParentRef =
  | { kind: 'chat'; chatId: string }
  | { kind: 'session'; historyThreadId: string; originNodeId: string | null };

export type SideChatAuthority = 'inherit-parent';

export interface SideChatLink {
  chatId: string;
  parent: SideChatParentRef;
  authority: SideChatAuthority;
  lastReadAssistantSequence: number;
}

export interface ParentContextSnapshot {
  parent: SideChatParentRef;
  revision: string;
  capturedAt: number;
  title: string;
  estimatedTokens: number;
  omissions: string[];
  quotedContext: string;
}

export interface SideChatAttention {
  parent: SideChatParentRef;
  total: number;
  running: number;
  unread: number;
  needsAttention: number;
}
```

The concrete provider selection DTO must carry the unified picker's model, reasoning and local runtime target when applicable. Define it against the existing session runtime types during task 3; do not narrow it to the current five-name chat schema.

## Task 1: Durable parent ownership and migration

**Modify:** `src/shared/types/chat.types.ts`, `src/main/operator/operator-schema.ts`, `src/main/chats/chat-store.ts`, `src/main/chats/chat-store.spec.ts`.
**Create:** `src/shared/types/side-chat.types.ts`, `src/main/chats/side-chat-link-store.ts`, `src/main/chats/side-chat-link-store.spec.ts`.
**Consumes:** Existing chat identity and stable session history identity.
**Produces:** `SideChatLinkStore.get(chatId)`, `.listForParent(parent)`, `.insert(link)`, and `.markRead(chatId, throughSequence)`; persisted indexed ownership and monotonic read position.

- [x] Trace history identity across create, restart, fallback, resume and provider switch. Confirm how archived sessions resolve before committing to parent lookup keys. Use node identity as workspace provenance without making ownership depend on a changing node route.
- [x] Add migration tests for an old database containing ordinary chats and legacy sidechats. Run the migration twice and verify unchanged transcript IDs and no guessed relationships.
- [x] Add store tests for two parents in one directory, multiple child conversations, monotonic read positions, deleted child cleanup, and same parent with a replacement runtime.
- [x] Create a sidechat relation table keyed by `chat_id`, with a stable parent kind/key index, authority and read high-water mark. Keep runtime IDs out of the ownership key. Persist relation and backing chat creation atomically or roll back an incomplete creation.
- [x] Allow several conversations per parent, including concurrent creates with independent provider selections. Test each child retains its own history and relationship.
- [x] Run `rtk npm run test:quiet -- src/main/chats/side-chat-link-store.spec.ts src/main/chats/chat-store.spec.ts`.

## Task 2: Parent context resolution, delivery and rebuild

**Create:** `src/main/chats/side-chat-parent-resolver.ts`, `src/main/chats/side-chat-context.ts`, and adjacent `.spec.ts` files.
**Modify:** `src/main/chats/chat-service.ts`, `src/main/chats/chat-service.types.ts`, `src/main/chats/chat-continuity.ts`, `src/main/chats/chat-service.spec.ts`.
**Consumes:** `SideChatParentRef`, stored links, parent history/ledger and live runtime.
**Produces:** `resolveParentSnapshot(parent, tokenBudget): Promise<ParentContextSnapshot>` and a sidechat send coordinator that delivers parent context before the user's question, with replayable provenance.

- [x] Trace parent transcript sources, including non-chat instances, loops, compacted histories and remote instances. Do not assume `historyThreadId` is a ledger conversation ID. Resolve each source through its actual owner.
- [x] Test the screenshot scenario: parent task and latest implementation progress are delivered to a different provider, while parent send/interrupt APIs are never invoked.
- [x] Test long histories, missing summaries, runtime messages pending ledger flush, malicious closing delimiters, unavailable context, rewind, and a context fetch finishing after UI selection changes.
- [x] Build a consistent revisioned snapshot and preserve task, constraints and user decisions before older completed detail. Enforce the spec's initial 12,000-token ceiling and selected-model capacity/history/answer reserve.
- [x] Resolve refreshed parent context on each user question. A revision changes on rewind/content replacement, not just increasing sequence. Do not enqueue autonomous refresh turns. Test a follow-up sees parent progress created after the first question.
- [x] Add a durable latest-effective-context representation for rebuild. Do not inject every prior snapshot, duplicate the current question, or lose parent context when the sidechat switches provider/restarts.
- [x] Serialize sends per sidechat. Preserve retries without duplicate user turns; if snapshot acquisition fails, return an explicit error and offer explicit use of the last snapshot.
- [x] Run `rtk npm run test:quiet -- src/main/chats/side-chat-parent-resolver.spec.ts src/main/chats/side-chat-context.spec.ts src/main/chats/chat-service.spec.ts`.

## Task 3: Provider choice, authority and execution routing

**Modify:** `src/shared/types/chat.types.ts`, `packages/contracts/src/schemas/chat.schemas.ts`, `src/main/chats/chat-store.ts`, `src/main/chats/chat-service.ts`, `src/renderer/app/features/models/compact-model-picker.types.ts`, `src/renderer/app/features/models/provider-menu.constants.ts`, and the effective runtime/permission seams discovered during tracing.
**Tests:** `packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts`, `src/main/chats/chat-store.spec.ts`, `src/main/chats/chat-service.spec.ts`, plus a new `src/main/chats/side-chat-runtime.spec.ts` for capability/authority/routing contracts.
**Consumes:** Unified pending provider selection, parent execution location and its effective edit permissions.
**Produces:** Capability-validated sidechat creation, persisted provider/runtime selection, and enforceable authority.

- [x] Enumerate actual supported session runtime configurations, including Cursor, Grok, OpenCode and local models. Trace account routing, target metadata, node RPC, adapter capabilities and provider configuration changes.
- [x] Write a provider matrix test covering validation, persisted reload, runtime config, first send, provider switch and context rebuild. Verify local model target metadata survives every seam. Assert no selected provider silently becomes Claude or null.
- [x] Trace the parent's effective permission policy through agent/tool permissions, approval mode, sandbox scope, hardened/contained execution and provider-specific mandatory restrictions. Use `src/main/instance/lifecycle/tool-permission-config.ts` and `instance-create-builder.ts` as starting points; confirm executing adapter/MCP/node paths before choosing a translation seam. Existing parent inheritance of `yoloMode` and agent settings is not proof of full policy equivalence.
- [x] Resolve inherited policy before creation and each send. Persist enough policy provenance for runtime replacement; translate restrictions across providers without broadening scope. Never copy credentials, execution tokens or completed approval grants. If the parent is absent and no verified persisted policy exists, return unavailable-permissions before dispatch, even when a last context snapshot exists.
- [x] Test allowed edits from an editable parent and denied filesystem/shell/MCP mutations from a restricted parent, required approvals, sandbox scope, provider switches and parent permission changes between turns. Providers that cannot enforce the parent's policy expose a concrete unavailable capability. In-flight policy changes use existing runtime semantics.
- [x] Forward the parent's workspace node, with an explicit unavailable-node response. Test an identical-looking Windows/local path cannot route to the wrong machine.
- [x] Block explicit provider/model changes during a turn until stopped; changing one sidechat cannot stop its parent or sibling. Sidechat authority is inherited and has no independent enable-editing toggle.
- [x] Run provider matrix, contracts and focused chat tests; run `rtk npx tsc --noEmit`.

## Task 4: Validated IPC and persistent attention/read state

**Modify:** `packages/contracts/src/channels/chat.channels.ts`, `packages/contracts/src/schemas/chat.schemas.ts`, `src/main/ipc/handlers/chat-handlers.ts`, `src/preload/domains/chat.preload.ts`, `src/renderer/app/core/services/ipc/chat-ipc.service.ts`, `src/renderer/app/core/state/chat.store.ts`.
**Create:** `src/main/chats/side-chat-attention.ts` and adjacent tests.
**Tests:** Existing chat schema/channel/preload tests and `src/renderer/app/core/state/chat.store.spec.ts`.
**Consumes:** Stored links/read marks, incremental chat transcript/status events.
**Produces:** Parent-filtered listing, sidechat create/link, exact read acknowledgement and bounded attention deltas.

- [x] Define Zod payloads for parent references, creation selection, parent-scoped list and mark-read through a concrete sequence. Validate membership; reject a read sequence beyond the latest available assistant output.
- [x] Test duplicates/out-of-order events, simultaneous completion/read, permission-required/error states, archived chats, restart and parent deletion. Never count token chunks as separate unread conversations.
- [x] Assemble context in main rather than accepting renderer-authored parent history. Keep read acknowledgements monotonic and limited to the requested conversation.
- [x] Regenerate channel/preload assets using existing scripts. Verify handler registration, exports, aliases and renderer subscriptions through integration tests.
- [x] Reconcile interrupted runtime states on restart without automatically dispatching unfinished turns. Attention counts remain available without mounting the panel.
- [x] Run contracts/preload/attention/store focused tests and `rtk npm run typecheck:spec`.

## Task 5: Session-scoped panel and discoverable background work

**Create:** `src/renderer/app/core/state/side-chat.store.ts`, adjacent tests, and `src/renderer/app/features/side-chat/side-chat-panel.component.spec.ts`.
**Modify:** Existing sidechat `.ts/.html/.scss`, dashboard `.ts/.html`, `workspace-rail.component.ts/.scss`, and `instance-list/instance-row.component.ts/.html/.scss` plus their focused tests. Include archived-parent/history surfaces where the session mapping requires them.
**Consumes:** Typed parent identity, provider capabilities, sidechat list and attention deltas.
**Produces:** Linked-parent header, pre-send provider choice, conversation selector, per-session badge and global attention entrypoint.

- [x] Add component/store tests for first-open without runtime creation, pre-send provider selection, panel hide while running, exact reopen, sibling switch and main-session switch.
- [x] Move drafts/selection into session-scoped store state so panel destruction cannot lose or cross-wire them. Invalidate late loads with request generation/parent identity checks.
- [x] Implement count/activity/unread/attention indicators from the spec, with accessible text and keyboard navigation. Mark a specific assistant sequence read only after visible viewing; test hidden panel, background app and scrolled-up reader separately.
- [x] Keep Close, Stop and Archive distinct. A global attention list names parent sessions and opens their exact sidechat without losing the current session's draft.
- [x] Show inherited permission posture with inspectable restrictions. Verify the UI has no separate read-only default or enable-editing gate. Keep edits attributable to each conversation and preserve existing workspace coordination when parent and siblings edit concurrently.
- [x] Preserve existing unlinked chats; offer explicit attachment to a parent. Do not retain the old global localStorage key as implicit ownership.
- [x] Verify narrow-window layout, focus restore, busy provider switching, multiple unread conversations and archived-parent discovery in the real dev UI. Narrow layout, focus restore, selection/draft restore, session switching, provider switch, archive and attach were verified in the dev app; states that need a real answer (unread, running, busy switch, permission prompts) moved to [the livetest doc](2026-10-02-session-sidechats_livetest.md) (LT-SC-2…LT-SC-6).
- [x] Start browser verification with an explicit `windows-pc` Browser Gateway health/channel preflight. (Not applicable in-loop: the panel is Electron UI, not a web page, so it was driven over the dev app's debugging port. The worker routing check that does need `windows-pc` is LT-SC-7 in the livetest doc.) Use the local UI only under the routing exceptions in AGENTS.md; never use denied Harness Computer Use targets.
- [x] Run focused renderer tests and `rtk npm run build:renderer`.

## Task 6: Integration, full verification and independent review

- [x] Run an integration scenario mirroring the attached screenshots with seeded distinct parent/child runtimes and inspect the actual delivered request. No external paid model is needed to prove context delivery.
- [x] Exercise same-directory session isolation, hide/complete/reopen, provider round-trips, parent resume/rewind, app restart/read persistence, and remote workspace routing.
- [x] Run all canonical gates with retained logs and actual exit statuses (worker ran every gate except the full `test:quiet` suite; the queue verifier ran all seven, each exit 0, on 2026-10-06):

```bash
rtk npx tsc --noEmit
rtk npm run typecheck:spec
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run build:main
rtk npm run build:renderer
rtk npm run test:quiet
```

- [x] Start a genuinely fresh agent using `task-completion-gate`. (Done by the Plan Queue's independent verifier on a different provider.) Supply acceptance criteria, baseline and complete task diff, including uncommitted/untracked implementation files because this task forbids unsolicited commits. Require review of architecture, tests, security/authority, async state, performance, UI/a11y, migrations and node routing.
- [x] Fix every actionable finding, rerun affected verification and obtain a new fresh PASS. (Round 1 found two; both fixed; round 2 PASS.) Do not close documentation on an implementer's own review.
- [x] Record only genuinely external/rebuilt-app checks in a separate `_livetest.md` if needed. All in-loop tests and dev UI checks must pass first.
- [x] Update as-built notes, point the spec at the completed plan filename, rename spec to `_spec_completed.md`, and rename the plan `_plan_completed.md` last. Keep all files uncommitted unless James explicitly requests a commit.

## Draft readiness checklist

- [x] Current implementation and relevant UI/IPC/persistence paths inspected for planning.
- [x] UX states, ownership boundaries, provider gaps, failure modes and acceptance criteria recorded.
- [x] James's answers to multiplicity, context refresh and authority recorded in both documents on 2026-10-02.
- [x] Implementation and worker-side verification (see as-built notes). Independent verification and document renames are the queue coordinator's job.


## As-built notes (2026-10-06, Plan Queue worker)

Starting point: an earlier pass (committed in the "provider hardening" commits `f1c4ad82d`, `a09b090e8`) had added stores, a resolver, a context builder and a first panel, but no plan item was checked. Auditing it against this plan found real gaps, all fixed here:

- **Authority could widen.** The parent policy came from `getAgentById`, which falls back to the permissive `build` agent for custom agents; the parent's own tool override was ignored; browser and Computer Use modes were not inherited; a parent permission change was "applied" by mutating a live instance, which cannot change spawn-time CLI flags; and the provider rule rejected tool-less local models while accepting Copilot (always `--allow-all-tools`) for restricted parents. Now `side-chat-authority.ts` resolves through `AgentRegistry.resolveAgent`, honours `toolPermissionsOverride`, inherits `browserToolsMode`/`computerUseMode`/hardened/contained/node, verifies persisted policies field by field, and `providerCanEnforcePolicy` follows the adapters: Claude and local models enforce anything; Codex/Gemini/Antigravity/Cursor/Grok/OpenCode only parents with no denied category; Copilot only fully permissive parents. A changed policy fingerprint replaces an idle sidechat runtime before the next question; a busy one returns `busy`.
- **Unread state was lost on restart** (in-memory cache). Now `side_chat_links.latest_assistant_sequence` is persisted (column added idempotently to databases that already have the table; NULL = unobserved, backfilled from the ledger).
- **Context delivery** only queued a preamble on an existing runtime. Delivery is now tracked per runtime instance (`SideChatSendCoordinator.contextForTurn`), so new runtimes (first send, provider switch, policy change, restart) always get the latest snapshot once, unchanged context is not resent, and a rebuild includes it exactly once. Sends typed into the main chat view for a sidechat now go through the same coordinator.
- **Provider switching** after the first message was blocked by the ordinary-chat rule; sidechats may now switch (`side-chat:set-selection`) and rebuild history on the new runtime.
- **Missing pieces added:** global attention list (`side-chat:attention-all`) and coalesced `side-chat-attention` chat events, parent titles and target conversation in attention, archived-parent lookup through history, retained prompts for trimmed long sessions, explicit attach (`side-chat:attach`), permission inspector (`side-chat:permissions`), session-row badge, rail list that opens the exact conversation, pre-send provider picker limited to enforceable providers, stale-context retry, in-panel permission prompts, read marks only when visibly at the bottom with a "New answer" affordance, narrow-window overlay, focus return, and a deletion-confirmation note.
- **Structure:** the sidechat subsystem moved out of `chat-service.ts` (which was at its size ceiling) into `src/main/chats/side-chat-service.ts`, reached through `ChatService.sideChats` and a small port. Chat records now carry `sideChatParentKey` (LEFT JOIN) so the attach list can exclude chats that already belong to a session.

Decisions taken autonomously (evidence in code comments): local models count as able to enforce any policy because interactive local-model runtimes have no tool execution (`ollama-cli-adapter.ts`/`openai-compatible-chat-adapter.ts` only use tools for local review); a local-model target must run on the parent's machine; the parent's own provider is the default when it can enforce the policy, else the first usable one; the main process uses the parent's workspace path over the renderer's directory.

Verification run by the worker (2026-10-06):

- Targeted tests: `src/main/chats/` (16 files, 215 tests), sidechat IPC handler spec, contract schema/channel specs, preload, and renderer side-chat, state, dashboard, instance-list, history, models and chats specs — 1,134 tests; the last combined run had one failure (a test that assumed two same-millisecond creations come back in creation order), fixed to be order-independent and then passing on three consecutive runs. Deliberate breakages of the permission wiring, context delivery and read-visibility logic were each caught by the new tests.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` (dashboard 758 lines, within its +50 tolerance), `npm run build:main`, `npm run build:renderer`: all exit 0. `npm run generate:ipc` regenerated `src/preload/generated/channels.ts`.
- Full `npm run test:quiet` deliberately not run by the worker (queue instruction: the verifier runs it).
- Real dev app (Electron, throwaway profile `/tmp/aio-sidechat-lt`, renderer served from a development build, no model calls): created parents and sidechats through the real IPC; confirmed per-parent lists, parent workspace override, permission inspector and Copilot exclusion for an "asks first" parent, out-of-range read rejection, close/reopen restoring the exact conversation and draft, session switching without mixing lists or drafts, arrow-key selector navigation, narrow-window overlay (760 px), provider switch on an idle sidechat, archive moving it to "Archived (1)", explicit attach, sidechat links surviving an app restart, focus returning to the rail button, and the attach list excluding existing sidechats.
- A read-only reviewer subagent found no actionable issues. The independent task-completion-gate review remains the queue verifier's step.

Deferred to [2026-10-02-session-sidechats_livetest.md](2026-10-02-session-sidechats_livetest.md) (need real provider turns or the worker): LT-SC-1 real screenshot answer, LT-SC-2 hidden answer and badge reopen, LT-SC-3 unread after restart, LT-SC-4 permission prompt in the panel, LT-SC-5 restricted parent refusal by a real model, LT-SC-6 busy switch, LT-SC-7 `windows-pc` routing, LT-SC-8 permission change between real turns.

### Verification round 1 fixes (2026-10-06, Plan Queue worker)

The independent verifier failed round 1 on two findings; both are fixed.

1. **A retried question after a dispatch failure was saved twice.** `ChatService.dispatchMessage` writes the user turn to the ledger before spawning the runtime and sending input, so a spawn or input failure left the question in the ledger and a retry appended a second copy (shown twice in the transcript and replayed twice on the next rebuild). The ledger already updates a message in place when its native id repeats (`upsertMessage` in `conversation-ledger-store.ts`), so the fix gives each question a turn id chosen by `SideChatSendCoordinator`: after a failed dispatch it remembers that turn id with a digest of the question's text and attachments, and a retry of the same question reuses it, updating the earlier turn instead of adding one. A different question gets a new turn; success clears the memory. The id reaches the ledger through `dispatchMessage(input, { userTurnId })` and a new optional `turnId` on `createUserLedgerMessage`; ordinary chats are unchanged. Tests: two coordinator cases (identical retry, including whitespace and a stale-context retry, reuses the turn; a different question does not) and a service case against the real ledger (input delivery fails once, the retry succeeds, the sidechat holds one user turn, and a later provider-switch rebuild replays it once). Both new tests fail with the reuse removed and pass with it.
2. **`side-chat-service.ts` was 714 lines, over the 700-line gate.** The error class, the busy-status set and the provider-selection checks (pure functions, no service state) moved to a new `src/main/chats/side-chat-selection.ts`; `SideChatError` is re-exported from the service so existing imports are unchanged. The service is now 667 lines.

Checks after the fixes: `src/main/chats/` plus the sidechat IPC handler spec (16 files, 218 tests) pass; `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` and `npm run build:main` all exit 0. The full `test:quiet` suite is left to the verifier.

Known limit of fix 1: the failed-turn memory lives in the main process, so a retry made after an app restart appends a new turn (the failed one stays in the transcript as sent).

Known limits: sidechats also appear in the ordinary chat list (as before this work); a sidechat of an archived chat parent is reachable from the chat list and its own badge rather than from the parent row.

## Closure — 2026-10-06

- Independent Plan Queue verifier (different provider): PASS after round 2, no findings. Gates run in the item worktree, each exit 0: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`.
- Landed on `main` as `1b06fffee` (one local squash commit made with the repository hooks; not pushed).
- After all five Plan Queue items landed, the same seven gates were rerun on the combined `main` (`1b06fffee`): every one exited 0; the quiet suite ran 2,370 files / 29,885 tests.
- Round 1 findings and fixes: (1) a sidechat retry after a failed dispatch appended the user's question to the ledger twice — fixed by reusing the failed turn's id for an identical retry (`side-chat-send-coordinator.ts`, ledger upsert by message id), covered end to end in `side-chat-service.spec.ts`; (2) `side-chat-service.ts` exceeded the 700-line limit — split into `side-chat-selection.ts`.
- Known limitation: the failed-turn id is held in memory, so a retry made after a Harness restart can still record the question twice.
