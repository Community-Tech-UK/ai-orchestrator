# Session-linked sidechats rebuild

**Status:** Completed 2026-10-06. Implemented and independently verified (Plan Queue verifier PASS, round 2); landed on `main` as `1b06fffee`. Product decisions 1–3 confirmed by James on 2026-10-02. Live checks needing real provider turns are in [2026-10-02-session-sidechats_livetest.md](2026-10-02-session-sidechats_livetest.md).
**Date:** 2026-10-02
**Implementation plan:** [Implementation plan](2026-10-02-session-sidechats_plan_completed.md).

## 1. Intent and success

James wants to ask a question about the session currently in view using any available provider, without interrupting that session. The sidechat must know which work the question refers to. Closing its panel must leave a visible way to discover running work, unread answers, or requests needing attention.

The motivating example is a running Codex provider-hardening session. A Claude sidechat should understand “How far through this are you? What's left to do?” from the session's actual instructions and progress, rather than infer the task from repository changes.

## 2. Source-backed current state

- `src/renderer/app/features/dashboard/dashboard.component.html:165` passes only `workingDirectory` to the sidechat panel.
- `src/renderer/app/features/side-chat/side-chat-panel.component.ts:235` lazily creates a detached Claude chat without a parent reference or transcript. Its single `side-chat-state` storage key is not scoped by parent session.
- `src/main/chats/chat-service.ts:420` reconstructs context from the receiving chat's ledger; `ensureRuntime` creates a separate runtime. This is useful infrastructure to retain.
- `src/main/chats/chat-store.ts` and `src/main/operator/operator-schema.ts` persist chats but not a sidechat-to-parent relation or read position.
- `packages/contracts/src/schemas/chat.schemas.ts` and `chat-store.ts` accept/read five provider names, while `src/renderer/app/features/models/provider-menu.constants.ts` lists additional session providers. Type-level provider membership alone does not prove runtime support.
- `src/shared/types/instance.types.ts:408` defines `historyThreadId`; its creation config describes it as stable across restore/fallback. Recovery selection uses logical identity ahead of runtime instance identity. The implementation must trace all restart/provider-switch paths before relying on this identity.
- The workspace rail already has an unread badge pattern for automations. Its sidechat button currently represents panel visibility only.

## 3. Confirmed product decisions

James confirmed these choices on 2026-10-02. They supersede the earlier draft recommendations.

1. **Multiplicity:** Several sidechats per session, allowing independent questions to different providers.
2. **Context refresh:** Capture the parent's latest context for each user question. Do not stream automatic questions or refresh turns into a provider while it is answering.
3. **Authority:** Sidechats have the same edit permissions as their parent session. Inherit the parent's effective tool restrictions, approval posture and sandbox/workspace scope through runtime configuration. A prompt instruction or copying `yoloMode` alone is insufficient. There is no separate read-only default or enable-editing step.

Resolve the effective parent permissions before creation and each subsequent dispatch, including after runtime replacement or permission changes. Translate the same policy to the selected provider without broadening authority. If equivalent enforcement is unavailable, show a concrete capability failure rather than silently relaxing restrictions. Preserve provider-specific mandatory restrictions and existing approvals; inherit policy, not completed approval grants, credentials or execution tokens. If the parent is unavailable, stale transcript context alone does not authorise editing; require a verified persisted permission policy or return an explicit unavailable-permissions state.

## 4. Approach and alternatives

**Recommended:** Reuse durable chat records, conversation ledger, runtime creation, provider selection, and transcript events. Add a distinct sidechat relationship, parent context assembly, persistent attention/read state, and a session-scoped renderer store. Keep sidechat runtime lifecycle independent of the parent.

**Alternative A:** Use provider-native forks. This can give strong continuity within one provider but does not cover cross-provider questions, uniform refresh, or a reliable app-level relationship.

**Alternative B:** Send questions through the main session. This gives direct context but interrupts or queues behind the main agent, defeating the intended separate conversation.

## 5. Session identity and lifecycle

- A parent is either a durable top-level chat (`chatId`) or a logical session (`historyThreadId`). Retain origin worker identity where needed for workspace access. Never key ownership solely by runtime instance ID or working directory.
- Persist the parent reference when creating a sidechat. Resolve current runtime, provider, workspace and transcript through a main-process resolver. Renderer-provided text is not the source of parent context.
- Session A and B in the same repository have separate sidechat lists, drafts, last-selected sidechat, and unread state.
- Parent restart, compaction, hibernation, native-session replacement, and resume do not detach sidechats. A rewind changes context revision even if sequence numbers are reused.
- Sidechats remain discoverable with an archived parent. A missing/deleted parent produces an explicit unavailable-context state; never bind to whichever session is now selected. Integrate any existing parent-deletion confirmation so related sidechat consequences are visible.
- Closing the panel hides it. Stop interrupts only the chosen sidechat. Archive removes it from the active sidechat list while retaining history. App restart restores history and attention state but does not automatically submit or resume an unfinished turn.
- Existing unlinked sidechats remain ordinary chats. Offer an explicit “Attach to this session” action; never guess ownership from a directory or the previously selected session.

## 6. Provider and model selection

- Show provider/model/reasoning selection before the first message. Use the existing unified picker and capability catalogue; retain each sidechat's own selection.
- “Any provider” means every session provider with a working conversation runtime, including OpenCode, Grok, Cursor and local models where available. Check creation, persisted round-trip, switching, resume/rebuild, reasoning and local runtime target metadata end to end.
- Missing installation, unavailable account, offline execution node or insufficient context capability gives a concrete disabled reason. Do not quietly replace the selected provider with Claude.
- Offer the parent's provider/model as the initial selection when usable, otherwise the user's available default. This is a recommendation for the draft.
- Provider/model switches preserve sidechat history and parent ownership. Prevent a config switch from killing an in-flight answer without an explicit stop action.
- Switching providers preserves the parent's effective edit permissions; a provider change is not an authority escalation. Apply parent permission changes before the next sidechat dispatch and follow existing runtime permission-change behaviour for an in-flight turn.
- Run against the parent's actual workspace/execution node by default. A remote workspace path must never be treated as a coordinator-local path. An unavailable provider/node requires an explicit alternative rather than silent routing.

## 7. Parent context contract

Each question uses a snapshot of the linked parent, captured before dispatch:

- Identity, title, workspace, execution node, current status, task instructions, user decisions, active plan references, latest progress and remaining questions.
- Durable summary/checkpoint plus a bounded recent transcript tail. Merge runtime messages not yet persisted by message identity, so current progress can be included without duplicating content. Treat an in-progress assistant answer as provisional.
- Record source revision, capture time, included range, budget and omissions. Initial budget recommendation: at most 12,000 estimated tokens, further limited by the selected model's available input budget after sidechat history and expected answer reserve. Use existing token estimation infrastructure; preserve task/constraints before older completed detail.
- Delimit parent content as quoted data under the prompt house style. Parent instructions, tool results and transcripts cannot override the sidechat's own authority.
- Keep parent context separate from the sidechat's user-visible messages, but persist provenance and delivered content sufficiently for accurate rebuild after restart/provider switching. Do not repeatedly grow history with the entire parent transcript on every turn.
- Refresh context on every question. Unchanged context is not resent unnecessarily; changes carry a clear superseding revision. Replay reconstruction must use the latest effective parent snapshot with the sidechat's own conversation, not every historical snapshot.
- Missing context is an explicit error before a question is dispatched. Offer an explicit continuation using the last captured snapshot with a stale-context label. Never silently send a context-free status question.
- A newer parent snapshot does not steer the parent, submit messages to it, or cause automatic sidechat turns. A “Send to main” action, if included, requires explicit user invocation with visible text.

## 8. UX and notifications

The panel header names its parent: “Sidechats · Provider Hardening AI Orchestrator”. A session-local list or selector shows conversation title, provider, runtime state, and unread state. New sidechat is an explicit action; opening an empty panel alone spawns no runtime.

| State | Closed-panel/session-row treatment | Opening behaviour |
| --- | --- | --- |
| Existing, read, idle | Quiet sidechat count | Restore last selected conversation |
| Running | Activity indicator with accessible text | Open running conversation |
| Answer unread | Unread count/dot | Open unread conversation |
| Needs permission or failed | Attention marker, higher priority than running | Open the conversation needing action |
| Archived | Available in history, absent from active count | Reopen explicitly |

- Badges live on the owning session row and the panel toggle. The global rail can show aggregate attention with a small list naming the parent sessions, so answers remain discoverable after navigating away.
- Counts refer to conversations with unread answers, not streaming chunks. Reading a parent session does not mark its sidechats read.
- A persisted assistant-message high-water mark is advanced only when that sidechat is actually visible and the new answer is viewed. Mark through a specific message sequence, never “clear all”, so a concurrent arrival cannot be accidentally acknowledged.
- While a reader is scrolled up, new output shows a “New answer” affordance and stays unread until viewed. Visibility/focus handling must not clear hidden/offscreen replies.
- Default notifications are quiet in-app badges. Do not produce a toast for every token or force focus. Existing notification settings govern any optional completed-answer toast or OS notification.
- Switching main sessions shows the newly selected session's sidechats; running conversations for the previous session continue. Pending async loads cannot overwrite the new session's panel or draft.
- Show a compact “Permissions: same as parent” indication and expose inherited restrictions/approval posture on inspection. Sidechats can edit the same workspace while the parent is running; preserve existing workspace coordination and make each conversation's activity attributable. Context is captured at dispatch and is not a transaction over concurrent file edits.
- For narrow windows, preserve accessible selection and composer layout; use a stacked view rather than squeezing the main workspace beyond its usable width. Keyboard access and non-colour labels cover provider choice, sidechat selection and attention states.

## 9. Architecture responsibilities

- **Persistence:** sidechat relation/read state alongside existing chat storage. Use indexed lookup by stable parent. Migration is idempotent and preserves unrelated chats.
- **Parent resolver:** resolve logical parent identity, transcript source, current runtime and execution location. Bound reads and make source coverage explicit.
- **Context builder:** deterministic budget selection, revision handling, safe prompt framing and replay representation. It does not create runtimes or alter the parent.
- **Runtime integration:** receive a sidechat's own provider settings, effective authority and node target; serialize turns per sidechat and keep parent continuity independent.
- **Renderer store:** lifetime above the panel, session-keyed drafts/selection, incremental transcript/status aggregation and durable read acknowledgements.
- **Presentation:** panel, provider picker, parent-session badge, rail attention list, and history entrypoints.
- **IPC:** Zod-validated creation, listing by parent and read acknowledgement. Parent context is assembled in main, with typed metadata for the UI. Generate channel/preload assets through existing tooling.

## 10. Acceptance and verification

1. A Claude sidechat opened from the screenshot's Codex session can answer the task-status question using the supplied parent task and progress; tests assert delivered context, not a model's wording.
2. Each available provider has create/send/persist/reload/rebuild coverage. Unsupported capability is visible before submission. The existing main chat remains functional.
3. Two sessions in the same directory never share sidechat ownership, context, draft or unread acknowledgements.
4. Hide a running sidechat, navigate away, receive an answer, and reopen through its parent/rail badge: the exact conversation and answer are present.
5. Restart/restore the parent and the app: sidechat association and unread markers survive; stale running state is reconciled without automatically resending work.
6. Every question resolves fresh parent context. Rewinds, simultaneous parent progress, very long transcripts and context read failures have explicit tests.
7. Sidechat edits have the parent's effective permissions at tool/runtime boundaries. Test inherited allowed edits and denied writes/shell/MCP mutations, approval requirements, sandbox scope, provider changes, parent permission changes and unavailable-parent policy. A sidechat with a restricted parent stays restricted.
8. Remote-node routing, unavailable providers, rapidly switching sessions, simultaneous completions, stop-versus-close, and accessibility are exercised.
9. Run all project canonical gates after implementation and a genuinely fresh task-completion-gate review until it returns PASS with no actionable findings.

## 11. Scope and readiness

The rebuild covers desktop session-linked sidechats and their durable main-process/IPC infrastructure. Mobile UI is a separate follow-up; the shared contracts must remain compatible. Autonomous sidechat questions, automatic parent steering, and multi-provider consensus are outside this rebuild.

The three product choices in section 3 are confirmed. The draft recommendations were implemented as written, with these as-built refinements: providers that cannot enforce a parent's restrictions are hidden from the picker with a stated reason (Claude and tool-less local models can enforce any policy; Codex, Gemini, Antigravity, Cursor, Grok and OpenCode only parents with no blocked tool category; Copilot only fully permissive parents); permission prompts from a sidechat's own runtime are answered inside the panel; and chat records carry their sidechat ownership so existing sidechats are never offered for attachment. This document stays untracked until the queue coordinator closes it after verification.
