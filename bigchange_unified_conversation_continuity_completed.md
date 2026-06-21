# bigchange: Unified Conversation Continuity

- **Date:** 2026-06-20
- **Status:** IMPLEMENTED & VERIFIED (2026-06-21). All phases landed; typecheck (electron + spec) + lint clean; 1426 tests green across chats/conversation-ledger/operator/orchestration.
- **Author:** Claude (with James)
- **Origin:** "The session has no context of the loop it just ran — the output is on screen, why not?" A loop's recap card renders, but the interactive model has zero memory of the loop's work.

---

## 0. Implementation status (2026-06-21)

All five phases are implemented and verified. Summary, with the two intentional deviations from the original design called out:

- **Phase 1 — close the loop write-gap: DONE.** Loop iterations append to the chat ledger as `assistant` turns via `appendLoopIterationTranscript` → `chatService.appendSystemEvent` (idempotent `loop-iter:<runId>:<seq>`). *Deviation:* the write goes through `appendSystemEvent` directly rather than synthesizing `provider:normalized-event` envelopes for `ChatTranscriptBridge` (§4.1). Same end state (iterations in the canonical thread, deduped), simpler path.
- **Phase 2 — persisted session binding + full lineage rules (§4.2, §5.1): DONE.** `ChatSessionBindingStore` now carries `provider`, `sessionId`, `lineageEpoch`, `needsRebuild`, `lastTurnNativeId`, `lastValidatedAt`. `evaluateLineage()` is a pure, unit-tested predicate enforcing all four §5.1 rules (provider match, session-replaced detection, epoch/loop-divergence, ledger-tail reconciliation). Conservative by default (unknown ⇒ rebuild). *Note:* rule 2's "session resolvable" probe uses the live instance's session id (an unknown/empty live id is treated as unconfirmed, not invalid) — the failed-resume-then-rebuild fallback (§10) is the floor.
- **Phase 3 — rebuild as the universal context path (§4.3): DONE.** `ChatService.prepareTurnContext()` gates native resume on `evaluateLineage`; on any invalid verdict it rebuilds from the ledger (`buildLedgerRebuildPreamble`) and queues a continuity preamble. `recordSessionBinding()` rebinds after every send so the next turn takes the fast path.
- **Phase 4 — durable compaction checkpoints (§4.4): DONE.** New `conversation_checkpoints` table (ledger schema migration v2) + full worker-boundary plumbing (store / port / worker-client / worker-main / service). `maybeProduceCheckpoint()` folds the older uncheckpointed tail into an LLM summary (incrementally, bounded prompt; skipped entirely when no real summarizer is available so a lossy truncation is never persisted). `buildLedgerRebuildPreamble()` walks `[checkpoint summary] + [verbatim after checkpoint]`. Verbatim is never deleted ⇒ checkpoints are always regenerable.
- **Phase 5 — collapse borrow/fresh + delete band-aids (§7): DONE.** `pendingLoopHandoffs` / `queueLoopHandoff` / `withLoopHandoffIfPending` are gone. Borrow-vs-fresh already resolves to "continue the bound (borrowed) session, else fork-and-write-to-ledger" — forked loop sessions need no seeding because continuity is via §4.1 writes + §4.3 rebuild. *Retained thin shim:* `buildLoopContextHandoff` + `queueContinuityPreamble` survive **only** for instance-bound loops (started from instance-detail), which have no canonical ledger thread — exactly the case §7 permits as a shim.
- **§8 prereq — loop-control off env: ALREADY SATISFIED.** Loop control is a file-based out-of-band channel (`.aio-loop-control/<runId>/control.json`); a borrowed/continued adapter with no loop-spawn env discovers the control file from cwd (`discoverControlFileFromCwd`). So continuing the bound session never forces a fresh process — no change required.

---

## 1. Problem statement

### 1.1 Symptom
After a Loop Mode run completes, the loop's output is visible in the chat (the terminal recap card), but when the user sends a follow-up the model behaves as if the loop never happened. "Were those issues resolved?" has no antecedent.

### 1.2 Root disease — two desynced sources of truth
There are **two independent stores of "what was said," and a loop forces them apart:**

1. **The provider CLI session transcript** — Claude/Codex own this; `--resume <sessionId>` restores from *their* files. It is opaque to us and is what the model actually receives as context.
2. **Our conversation ledger** — durable sqlite, one thread per chat (`ledgerThreadId`). It is what the **user sees** and what we control.

For ordinary interactive turns these stay loosely in sync. A loop breaks the invariant **two ways at once**:

- **(a) It forks a second provider session.** The loop runs in its own CLI session `S_L`, separate from the chat's interactive session `S_A` (`default-invokers.ts` — `canBorrowParentLoopAdapter` only borrows `S_A` for Claude‑on‑Claude with a live adapter and no loop‑control env; otherwise it spins a fresh `createPersistentLoopAdapter` session).
- **(b) It never writes its turns back into the canonical ledger.** Loop iterations persist to the `LoopStore` and emit UI events; they do **not** append to the chat's `ledgerThreadId` (verified: interactive turns append at `chat-service.ts:398,432` and via `ChatTranscriptBridge`; loop iterations do not).

The current mitigation — the **context handoff** (`buildLoopContextHandoff` → `queueLoopHandoff` / `queueContinuityPreamble`, consumed on next turn) — is a band-aid that stuffs a lossy summary into the next user message. It is:

- **In-memory** (`chat-service.ts:85-94` says so explicitly: *"In-memory by design… a restart loses only the silent priming, not the user-facing summary"*) → dies on restart (the exact "new session" failure).
- **One-shot** → consumed by any intervening turn (title-gen, auto-continuation).
- **Single-branch** → queued to *either* the chat queue *or* the instance queue; if the user's next turn routes through the other send path, it's stranded.
- **Lossy** → a summary, not the actual turns.

Every observed failure mode is downstream of one missing invariant.

---

## 2. The invariant we want

> **The app's conversation ledger is the single source of truth for conversation state. Every provider CLI session — interactive or loop — is a derived, disposable cache that is always reconcilable from the ledger. Nothing the model must remember lives *only* inside an opaque provider session.**

Corollary: native `--resume` is an **optimization**, never the source of truth. The current bug is precisely that inversion (resume *is* the memory, and the loop forks it).

When this invariant holds, the handoff queues, the borrow-vs-fresh branching, and the restart fragility become unnecessary — they are workarounds for the missing invariant.

---

## 3. Current architecture (grounded)

| Concern | Where | Notes |
|---|---|---|
| Canonical ledger | `src/main/conversation-ledger/conversation-ledger-service.ts` | `appendMessagesWithThreadTouch`, `getRecentConversation`, `getFullConversation`, `getConversationPageBefore`, `getMessages`, `hasMessageWithNativeId`, `upsertThread`. Runs in a worker (`conversation-ledger-worker-client.ts`). |
| Interactive turn → ledger | `chat-service.ts:398,432` (user/assistant), `chat-transcript-bridge.ts:88,279` | Bridge subscribes to `instanceManager.on('provider:normalized-event')`, coalesces, flushes batches transactionally, re-queues on failure. |
| Interactive send (chat path) | `chat-service.ts:386 sendMessage` | Consumes `pendingLoopHandoffs` via `withLoopHandoffIfPending` (`:409`) then calls `instanceManager.sendInput`. |
| Interactive send (instance path) | `instance-manager.ts:~1440 handleInput` → `instance-communication.ts:565 sendInput` | Consumes `pendingContinuityPreambles` (`:624`). Builds `contextBlock` preface. |
| Rebuild-from-history (already exists!) | `history-restore-coordinator.ts:262,416-420` | `buildReplayContinuityMessage(restoreTranscriptMessages…)` → `queueContinuityPreamble`. Used on crash/respawn. **This is the seed of the north star.** |
| Loop iteration execution | `default-invokers.ts:1228 loop:invoke-iteration` | Borrow `S_A` (`:1366-1374`) or fresh `createPersistentLoopAdapter` (`:1409`). Only borrowed path's stream reaches the instance outputBuffer "as a normal turn would" (`:1437-1442`). |
| Loop terminal → handoff | `loop-handlers.ts:92,633 appendLoopTerminalSummary` | `buildLoopContextHandoff` → chat queue OR instance queue (`:652,659`). |
| Session id / resume | `claude-cli-adapter.ts` (`sessionId`, `shouldUseNativeResume`, `--resume`) | Per-adapter session; resume only when lineage intact. |
| Session continuity / checkpoints | `src/main/session/checkpoint-manager.ts`, `session-continuity-manager` | Keyed by `sessionId`. |

**Observation:** the ledger is authoritative *for interactive turns already*. Loops are the outlier on both axes (forked session + no ledger write). The rebuild mechanism already exists but is scoped to crash recovery. The north star is mostly **generalization + closing the loop write-gap**, not green-field.

---

## 4. Target architecture

Four components. Three already exist in some form (reuse/reshape); the binding is the main new piece.

### 4.1 One canonical thread per chat (reshape: close the loop write-gap)
Every turn from every actor — interactive user/assistant, **each loop iteration**, tool calls, system events — appends as typed events to the chat's single `ledgerThreadId`.

- **Mechanism:** make the loop a first-class producer of `provider:normalized-event` envelopes **bound to the chat's instance/thread**, so `ChatTranscriptBridge` ingests loop turns through the *exact same path* as interactive turns. No new write path; we feed the existing one.
- **Result:** the visible recap card and the model's context become the *same data by construction*. The "displayed ≠ remembered" split is structurally impossible for loop turns.
- New ledger message kinds (metadata, not new tables): `loop_iteration` (assistant turn produced by an iteration), keep existing `loop-start` / `loop-summary` system events. Mark loop turns so the renderer can group/badge them and so compaction can treat them specially.

### 4.2 Session = cache bound to the thread (new: explicit binding)
Maintain an explicit, persisted binding **`{chatId → activeProviderSession}`**: `{ provider, sessionId, lineageEpoch, lastValidatedAt }`.

- Loop iterations **resume the bound session** instead of forking, for providers where that is safe (Claude). The borrow-vs-fresh logic in `default-invokers.ts` collapses to "continue the bound session."
- For providers whose sessions can't be safely borrowed (Codex/Gemini external rollout ids — see `canBorrowParentLoopAdapter` rationale and the `gemini-cli`/`codex-mcp` memory notes), the loop may run its own provider session **but still writes every turn into the canonical thread** (§4.1) — so continuity is preserved via rebuild (§4.3), not via session sharing.

### 4.3 Deterministic rebuild as the universal context path (reshape: promote crash-only → always-on)
On every new turn, context handed to the model is constructed from the **ledger**, with native resume as a *guarded fast path*:

```
buildTurnContext(chatId):
  binding = sessionBinding(chatId)
  if binding && lineageValid(binding):        # fast path
      return { resume: binding.sessionId }     # native --resume, prompt-cache intact
  else:                                        # universal fallback (self-healing)
      history = ledger.getRecentConversation(threadId, budget)   # + durable compaction checkpoint
      preamble = buildReplayContinuityMessage(history)            # reuse existing builder
      seed a FRESH session from `preamble`; rebind; bump lineageEpoch
      return { freshSessionSeededWith: preamble }
```

This generalizes `history-restore-coordinator`'s existing `buildReplayContinuityMessage` from a crash handler into the standard context constructor. Because the ledger is durable, the next turn is **always** correct regardless of what happened to the session (restart, eviction, recycle, cross-provider).

### 4.4 Durable compaction checkpoints in the ledger (reshape: generalize loop recap/OUTSTANDING snapshots)
Loops produce huge histories; rebuild must stay bounded. Store summarized checkpoints **in the ledger** so rebuild walks `[durable summary checkpoint] + [recent verbatim turns]`, never unbounded. You already persist loop recap cards + OUTSTANDING snapshots to durable state — generalize that into a first-class `conversation_checkpoint` concept the rebuild reads.

---

## 5. The one hard trade-off (even with unlimited resources)

**Native-resume efficiency vs. control.** Native `--resume` gives the provider's prompt-cache and incremental context for free, but the transcript is opaque and provider-owned — which is *why* the loop has to fork. Ledger-rebuild gives total control + provider-agnosticism but re-materializes context (tokens; we manage cache breakpoints).

**Resolution: don't pick one.** Ledger authoritative; native resume is a pure optimization valid **only while session lineage is provably intact.** The moment lineage is in doubt, fall back to rebuild. Fast path in the common case, correctness as the floor. The discipline: **never let the optimization become the source of truth.**

### 5.1 Session-lineage validity rules (`lineageValid`)
A bound session is a valid fast path **iff all** hold:
1. Same `provider` as the requested turn.
2. `sessionId` still resolvable by the provider CLI (not evicted) — provider-specific probe; treat unknown as invalid.
3. `lineageEpoch` matches — bumped on any event that could desync the provider transcript from the ledger: app restart with no proof the session survived, cwd switch, model switch that forks the session, an interrupt/respawn, or a loop that ran in a *non-bound* session (Codex/Gemini case).
4. Ledger tail and session tail agree on the last turn id (cheap reconciliation marker — store last-appended `nativeMessageId` alongside the binding).

If any fail → rebuild and rebind. Conservative by default: **unknown ⇒ invalid ⇒ rebuild.** Correctness over a cache hit.

---

## 6. Data model changes

1. **Ledger message metadata:** add `loop_iteration` turn kind + `loopRunId`, `iterationSeq`, `stage`. No schema break — rides existing `metadata` on `ConversationMessageRecord`. Idempotency via `nativeMessageId = loop-iter:<runId>:<seq>` (the ledger already dedupes on `hasMessageWithNativeId`).
2. **Session binding store:** `{ chatId, provider, sessionId, lineageEpoch, lastTurnNativeId, lastValidatedAt }`. Small table or column set on the chat record. Persisted (this is what survives restart and kills the in-memory-handoff failure).
3. **Conversation checkpoint:** durable summary rows keyed by `threadId` + `upToTurnId`, produced by compaction; read by rebuild.

---

## 7. What gets deleted at the end

Once §4 holds, remove (or reduce to thin shims):
- `pendingLoopHandoffs` + `queueLoopHandoff` + `withLoopHandoffIfPending` (`chat-service.ts`).
- `pendingContinuityPreambles` as the *loop* continuity mechanism (`instance-communication.ts`) — keep only if still needed for non-loop preambles, otherwise fold into rebuild.
- `buildLoopContextHandoff` (`loop-chat-summary.ts`) — subsumed; the model gets real turns, not a summary.
- The borrow-vs-fresh branching in `default-invokers.ts:1347-1428` collapses to "continue the bound session, else fresh+seed."
- `appendLoopTerminalSummary`'s silent-priming half (`loop-handlers.ts:642-659`) — keep only the **visible** recap card (`buildLoopTerminalChatSummary`), which is genuinely user-facing.

N special-case continuity bridges → **one invariant.**

---

## 8. Migration / compatibility

- **Backward compat:** existing chats have no session binding. First turn after upgrade → `lineageValid` fails → rebuild from ledger (already works). Zero data migration required to be correct; bindings populate lazily.
- **Loop-control transport:** §4.2 requires loops to continue the bound session, but loop-control env can't be injected into a running adapter (`default-invokers.ts:1364-1366`). Pre-req: move loop-control off env to an out-of-band channel (file/socket/MCP) so continuation doesn't force a fresh process. (Cross-ref the loop-control transport memory note.)
- **Provider coverage:** ship Claude (borrow-safe) on the fast path first; Codex/Gemini ride §4.1 + rebuild from day one (no behavior regression vs today — they already fork).
- **Rollout flag:** gate the rebuild-always path behind a setting; default native-resume fast path on, rebuild fallback on. Lets us A/B token cost.

---

## 9. Phased delivery

1. **Close the loop write-gap.** Loop iterations emit chat-bound `provider:normalized-event`s → `ChatTranscriptBridge` ingests them. *Immediately* fixes the visible/context split at the source (loop turns are now in the thread). Low risk, high value. Ship alone.
2. **Persisted session binding + lineage rules** (§4.2, §5.1). Replaces the in-memory handoff's job durably.
3. **Promote rebuild to universal context path** (§4.3), native resume guarded by `lineageValid`. Reuse `buildReplayContinuityMessage`.
4. **Durable compaction checkpoints** (§4.4) so rebuild stays bounded under big loops.
5. **Delete the band-aids** (§7) once 1-4 are verified.

Each phase is independently shippable and leaves the system correct.

---

## 10. Risks & open questions

- **Token cost of rebuild** under huge loop histories — mitigated by §4.4; quantify before promoting rebuild to always-on. *Open: target context budget per turn?*
- **Provider session probe** for `lineageValid` rule 2 — is there a cheap "does session X exist" check per CLI, or do we infer from a failed `--resume`? *Verify per adapter.* Failed-resume-then-rebuild is an acceptable fallback but costs one round trip.
- **Tool-call fidelity:** interactive turns capture tool calls via normalized events; loop iterations currently capture limited signals (`outputExcerpt`, `verifyOutputExcerpt`). Phase 1 should decide how much per-iteration tool detail enters the ledger (full vs summarized) — affects rebuild richness and cost.
- **Renderer grouping:** loop turns now in the main thread must be visually grouped/collapsible so the chat isn't flooded (reuse `loop:<id>` `nativeTurnId` grouping already used by recap cards; cross-ref `renderer/.../loop-message-detection.ts`).
- **Multi-loop / concurrent loops on one chat:** binding is single-session; concurrent loops on the same chat need either serialization or per-loop sessions that all write the one thread (the §4.1 path handles writes; binding picks one fast-path session).
- **Compaction correctness:** a bad summary silently degrades all future turns. Checkpoints must be regenerable from verbatim tail; never discard verbatim until a checkpoint is verified.

---

## 11. Reuse vs reshape summary

| Existing piece | Fate |
|---|---|
| `ConversationLedgerService` | **Reuse** — already the durable thread store + rebuild primitives. |
| `ChatTranscriptBridge` | **Reuse** — feed loop turns through it (chat-bound normalized events). |
| `history-restore-coordinator` / `buildReplayContinuityMessage` | **Reshape** — promote crash-only rebuild to the universal context constructor. |
| `session-continuity-manager` / `checkpoint-manager` | **Reshape** — host the persisted `{chat→session}` binding + lineage epoch. |
| `default-invokers` borrow/fresh logic | **Reshape** — collapse to "continue bound session, else fresh+seed." |
| handoff queues (`pendingLoopHandoffs`, `queueContinuityPreamble` for loops, `buildLoopContextHandoff`) | **Delete** — subsumed by the invariant. |
| `buildLoopTerminalChatSummary` (visible recap card) | **Keep** — genuinely user-facing. |

---

*End of draft. Next step on approval: expand Phase 1 into a concrete task list (loop → normalized-event emission, idempotent `nativeMessageId`, renderer grouping) and write the first failing test: "a loop iteration's turn is present in the chat's canonical thread and survives a simulated restart."*
