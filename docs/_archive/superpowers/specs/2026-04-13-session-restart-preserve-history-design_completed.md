# Session Restart — Preserve History — Design Spec

> **Date:** 2026-04-13
> **Status:** Draft
> **Related specs:** `2026-03-14-session-recovery-features-design.md`, `2026-03-15-session-resume-improvements-design.md`, `2026-04-09-resilient-codex-resume-and-agent-observability-design.md`

---

## Problem Statement

When a user clicks **Restart** on a stuck session in the instance row, the current implementation (`src/main/instance/instance-lifecycle.ts:1732`) is a nuclear reset:

- New `sessionId` is generated.
- `outputBuffer` (the visible transcript) is cleared.
- `contextUsage`, `diffStats`, `totalTokensUsed`, `firstMessageTracking` are reset.
- A fresh CLI adapter is spawned with no connection to the prior conversation.

This discards the user's work. The app already owns the machinery to avoid this loss — `SessionRecoveryHandler` with `nativeResume` + `replayFallback` paths, `archiveInstance()` for history archival, `historyThreadId` as a continuity key, and `buildFallbackHistoryMessage` for context-budgeted replay — but the user-facing restart path bypasses all of it. Recovery is only wired into crash/app-restart paths today.

This spec wires the existing recovery infrastructure into the user-facing restart action and adds the minimum new scaffolding required to do it correctly.

---

## Goals

1. **Preserve conversation continuity** across a user-triggered restart, using `nativeResume` → `replayFallback` in order.
2. **Never silently lose transcript data.** If recovery fails, surface a loud error; require explicit user action to proceed to a fresh session.
3. **Make "fresh context" an explicit, visible action** — not the default, not a silent fallback — with the prior transcript preserved visually and in the archive.
4. **Split identity cleanly** so that session/thread continuity survives recovery without corrupting provider-backend session references.
5. **Preserve correctness under race conditions** — no ghost events from killed adapters; no inherited pending tool-call state on the new adapter.

## Non-Goals

- Redesigning `SessionRecoveryHandler` internals or the `buildFallbackHistoryMessage` algorithm.
- Changing existing crash-recovery behavior on app startup.
- Cross-process coordination (single-user desktop app).
- Adding a new provider-level resume protocol beyond what each CLI already supports.

---

## Current Behavior (reference)

**`restartInstance`** at `src/main/instance/instance-lifecycle.ts:1732`:

```
terminate adapter → new sessionId → clear outputBuffer/contextUsage/diffStats/totalTokensUsed
  → clear firstMessageTracking → spawn fresh adapter → restartCount++
```

No call to `archiveInstance`. No reference to `historyThreadId`. No invocation of `SessionRecoveryHandler`.

---

## Design

### 1. Two explicit restart actions

The single **Restart** button becomes a split button. Primary action reflects user intent for "my session is borked but I don't want to lose context." Secondary action is the explicit escape hatch.

| Action | Purpose | Default? |
|---|---|---|
| **Restart (resume context)** | Keep the conversation; replace the process. | Yes — primary click. |
| **Restart (fresh context)** | Archive this conversation; start clean; keep the old transcript visible but excluded from context. | Secondary — chevron. |

Never silently fall through from "resume" to "fresh." If both recovery strategies fail, the instance enters an `error` state with a banner that CTAs explicitly to **Restart (fresh context)**.

### 2. Identity model (critical)

Today `instance.sessionId` does double duty as both continuity key and provider-backend session handle. This conflation is the root cause of subtle future-resume breakage if we just "keep the session ID across restart" — on `replayFallback`, the backend session is brand new, so keeping the same ID silently lies about what is resumable.

Introduce a clear split on `Instance`:

| Field | Lifecycle | Used for |
|---|---|---|
| `historyThreadId` | Stable across resumes and replay-fallback. New only on **Restart (fresh context)**. | Archive key; UI thread identity; analytics. |
| `providerSessionId` | Equals the current CLI process's backend session handle. New on replay-fallback and fresh restart. Preserved on native resume. | `--resume <id>` and equivalent provider resume flags. |
| `sessionId` (legacy) | Deprecated alias; derived from `providerSessionId` during migration. | Reads only; removed in a follow-up once call sites are migrated. |

`historyThreadId`'s fallback priority chain (per `history-manager.ts:613-628`) stays as-is: explicit > sessionId-derived > `originalInstanceId`. The migration simply makes `historyThreadId` always present and explicit.

### 3. Restart (resume context) — flow

1. **Guard:** acquire session mutex (see `src/main/session/session-mutex.ts`). Reject if a restart is already in flight for this instance.
2. **Pre-restart state snapshot:**
   - Bump `instance.restartEpoch` (new field; monotonic counter, see §5).
   - Clear pending interactive state: pending tool-call approvals, pending `fill-form`/prompt-response state, any in-flight IPC awaits. Reject outstanding promises with a `RestartCancelled` error.
3. **Terminate old adapter** via `adapter.terminate(true)` with a configurable timeout (default 5s). On timeout, force-kill.
4. **Preserve identity and transcript:** keep `historyThreadId`, `providerSessionId`, `outputBuffer`, `contextUsage`, `diffStats`, `totalTokensUsed`. In V2 the transcript is read from the active `TranscriptSegment` (§6); in MVP it remains the current `outputBuffer`.
5. **Recovery cascade** (each step has its own timeout; expiry counts as failure):
   - **`nativeResume`** — spawn new adapter with the existing `providerSessionId`. Provider-specific: Claude `--resume <id>`, Codex session restore, etc. On success, `recoveryMethod = 'native'`. All counters remain as-is (same backend session).
   - **`replayFallback`** — spawn fresh adapter, mint new `providerSessionId`, call `buildFallbackHistoryMessage(outputBuffer, contextBudget)` (today's signature; V2 passes active `TranscriptSegment` instead) and send as the adapter's first user turn. On success, `recoveryMethod = 'replay'`. Reset `backendSession*` counters (see §8); preserve `threadLifetime*`.
   - **Both fail** — transition instance to `error` state. Surface a persistent banner in the instance row: *"Couldn't resume this session. Your transcript is preserved. Start a fresh session to continue."* with a button wired to **Restart (fresh context)**. Set `recoveryMethod = 'failed'`. Do not attempt further automatic recovery.
6. **Post-success:**
   - Transition to `idle`.
   - Emit a toast: "Resumed via native session" or "Resumed by replaying transcript (context may be summarized)."
   - Start stuck-tracking on the new adapter.
   - `instance.restartCount++`.

### 4. Restart (fresh context) — flow

1. Guard via session mutex.
2. Bump `restartEpoch`, clear pending interactive state (same as §3.2).
3. `adapter.terminate(true)` with timeout.
4. **`archiveInstance()`** — persist the current transcript to the gzip conversation-history archive. This uses the existing `historyThreadId` for the archive record's `historyThreadId` key.
5. **Close the active transcript.**
   - **V2:** flip the active `TranscriptSegment` to `archived`, open a new active segment (see §6).
   - **MVP:** append a sentinel `OutputMessage` (type `system`, metadata `{ kind: 'session-boundary', archived: true }`) to `outputBuffer` and set `instance.archivedUpToMessageId` to the last pre-sentinel message ID. The context-construction path reads only messages after that marker.
6. **Mint new identity:** new `historyThreadId`, new `providerSessionId`.
7. Reset `backendSession*` counters (see §4). Preserve `threadLifetime*` across the restart if desired — otherwise also reset (see MVP note in §10).
8. Reset `firstMessageTracking` (keeps existing first-message semantics valid).
9. Spawn fresh adapter. `recoveryMethod = 'fresh'`.
10. Toast: "Started a fresh session. Previous conversation is archived."
11. `instance.restartCount++`.

### 5. Race protection — restart epoch

Each `Instance` gets a `restartEpoch: number`, incremented on every restart (resume or fresh). Every adapter event (stdout, tool-call, state change) is tagged with the epoch that was current when its adapter was spawned.

The event dispatcher in `instance-lifecycle.ts` / event setup ignores any event whose epoch does not match `instance.restartEpoch`. This prevents slow-terminating processes from polluting the new session with ghost output.

Where this lives: adapter event setup (`setupAdapterEvents`) captures the epoch at the moment of subscription, closes over it, and drops mismatches.

### 6. Transcript segmentation (fresh mode)

In the Fresh flow, the old `outputBuffer` stays visible to the user but must be provably excluded from context-construction. CSS styling is not enough — the code path that builds CLI input must know which messages are "current."

Replace the flat `outputBuffer: OutputMessage[]` model with a segment-aware model:

```ts
interface TranscriptSegment {
  id: string;
  historyThreadId: string;
  providerSessionId: string;
  status: 'active' | 'archived';
  startedAt: number;
  endedAt?: number;
  messages: OutputMessage[];
}

interface Instance {
  // ...
  transcriptSegments: TranscriptSegment[];
  // convenience, computed: segment where status === 'active'
}
```

- Pre-migration: the current `outputBuffer` becomes a single `active` segment. No behavior change.
- **Restart (resume context):** leaves the active segment active (native resume) OR appends a boundary marker within the active segment and continues appending (replay fallback — same thread, context was replayed).
- **Restart (fresh context):** flips the active segment to `archived`, opens a new active segment.
- UI renders archived segments with a visible divider and muted styling: *"— Previous session (archived) —"*. Code that constructs CLI prompts reads only the active segment.

Legacy consumers of `outputBuffer` (renderer, tests) continue to work via a derived getter that flattens `transcriptSegments` into a single array — but the context-construction path uses the segmented API.

### 7. Replay source of truth

`buildFallbackHistoryMessage` today consumes `outputBuffer`. `OutputMessage` at `src/shared/types/instance.types.ts:138` is already a structured type (`type` discriminant, `content`, `metadata`, `thinking`) — not a raw rendered stream. So the existing source is reasonable.

**Requirement:** audit every write into `outputBuffer` in the adapters to confirm no renderer-side formatting (banners, status lines, partial-chunk placeholders) lands in `OutputMessage.content`. If any does, move it out (e.g., into a sibling `uiNotice` stream) and only push conversation turns to the segmented transcript.

This audit is part of the implementation plan, not a design change. If the audit finds pollution, the fix is per-adapter and isolated.

### 8. Counter accounting

| Counter | Scope | Native resume | Replay fallback | Fresh |
|---|---|---|---|---|
| `contextUsage` | Current backend session | Preserve | Reset | Reset |
| `diffStats` | Current backend session | Preserve | Reset | Reset |
| `totalTokensUsed` | **Thread lifetime** | Preserve | Preserve | Reset |
| `firstMessageTracking` | Active segment | Preserve | Preserve | Reset |
| `restartCount` | Instance lifetime | +1 | +1 | +1 |

Rename/introduce: `contextUsage` and `diffStats` stay named as-is (single-session scope) but are documented as per-backend-session. `totalTokensUsed` is treated as cumulative across resumes (a user-visible thread-lifetime number), and only resets on Fresh.

### 9. Provider support matrix

Known behaviors, based on adapters in `src/main/cli/adapters/`:

| Adapter | `nativeResume` | `replayFallback` | Notes |
|---|---|---|---|
| Claude | ✅ via `--resume <threadId>` | ✅ | Primary, well-tested path. |
| Codex | ✅ session restore | ✅ | See `2026-04-09-resilient-codex-resume-and-agent-observability-design.md`. |
| Gemini | ⚠️ unknown — verify | ⚠️ verify | Gemini CLI may not expose an equivalent resume flag. May be replay-only. |
| Copilot | ⚠️ unknown — verify | ⚠️ verify | Suspect: may not accept arbitrary synthetic first turn. |
| Remote | Delegates to the remote provider | Delegates | Same capabilities as whatever the remote node runs, gated by network reliability. |

**Implementation gate:** before enabling the resume-default behavior for an adapter, confirm both paths work in a test. Adapters with no viable resume path show a diminished Restart button (tooltip: *"This provider doesn't support resume — restart will start a fresh session."*) and skip straight to Fresh semantics.

### 10. MVP vs v2

**MVP (targetable in one week):**

- §1 split button (resume / fresh).
- §2 identity split (introduce `providerSessionId`, keep `sessionId` as a deprecated alias read-through).
- §3 resume-context flow using existing `SessionRecoveryHandler`.
- §4 fresh-context flow using existing `archiveInstance`.
- §5 restart epoch.
- §3.2 / §4.2 pending-state cleanup.
- Per-step recovery timeouts.
- §9 matrix verified for Claude and Codex; Gemini and Copilot get "fresh only" fallback if native/replay can't be confirmed.
- Coarse counter behavior: preserve-on-native, reset-on-replay-and-fresh (skip the `backendSession*`/`threadLifetime*` split for MVP; all current counters behave per §8 "replay fallback" column on replay, "fresh" column on fresh — with one exception: `totalTokensUsed` behaves as documented in §8 since it's already user-visible).

**V2 (follow-up):**

- §6 transcript segmentation as a full data-model change. MVP can ship with `outputBuffer` kept visible after Fresh via a single "archived boundary" sentinel `OutputMessage` and a flag in the Instance saying "above this message is archived." The proper `TranscriptSegment[]` migration is a follow-up.
- §7 replay-source audit may surface adapter-specific fixes.
- Fine-grained counter split (`backendSession*` / `threadLifetime*`).
- Confirmed resume support for Gemini and Copilot with dedicated tests.
- User-configurable timeouts.

---

## UI Details

**Split button** in `src/renderer/app/features/instance-row.component.ts` (current trigger is line 732). Primary button: restart icon + label "Restart". Adjacent chevron reveals menu:

- **Restart (resume context)** — "Keep conversation, replace CLI." (default; also triggered by clicking the primary button.)
- **Restart (fresh context)** — "Archive conversation, start clean."

If the active instance's provider lacks any resume capability, primary action degrades to Fresh and the menu collapses into a single "Restart (fresh only)" item with a tooltip explaining why.

**Error banner** when recovery fails: inline in the instance row, dismissable only by clicking the Fresh CTA or closing the instance.

**Toasts** surface `recoveryMethod` succinctly — one line, auto-dismiss.

---

## Data Model Changes

In `src/shared/types/instance.types.ts`:

```ts
export interface Instance {
  // existing fields...
  historyThreadId: string;          // already exists; now required and explicit
  providerSessionId: string;        // NEW — replaces sessionId semantic split
  sessionId: string;                // DEPRECATED — keep as read-through to providerSessionId during migration
  restartEpoch: number;             // NEW — race protection
  recoveryMethod?: 'native' | 'replay' | 'fresh' | 'failed';  // NEW
  archivedUpToMessageId?: string;   // MVP — sentinel boundary; context reads only messages after this ID
  transcriptSegments?: TranscriptSegment[];  // V2 — replaces archivedUpToMessageId
}
```

IPC schemas (`packages/contracts/src/schemas/instance.schemas.ts`):

- New channel: `instance:restart-fresh` (in addition to existing `instance:restart`).
- `instance:restart` payload: unchanged signature; behavior now routes through `SessionRecoveryHandler`.
- Both handlers validated via Zod 4 per project convention.

---

## Failure Modes & Edge Cases

| Scenario | Handling |
|---|---|
| User clicks Restart during an active tool call | Session mutex serializes; pending tool call is rejected with `RestartCancelled`; new session starts idle. |
| `adapter.terminate(true)` hangs | Timeout (5s default) → `SIGKILL`. Restart proceeds. |
| `nativeResume` hangs | Per-step timeout (default 15s) → treat as failure → fall through to replay. |
| `replayFallback` succeeds but injected context exceeds budget | Existing `buildFallbackHistoryMessage` compression applies; no change from today. |
| Both fail | `error` state + banner + CTA. No auto-nuclear. |
| Restart spammed rapidly | `restartCount` tracked; no hard cap enforced at this layer (any future cap is orthogonal). |
| Remote node disconnected during restart | `terminate` may fail; log and proceed (current behavior preserved at lines 1747-1753). Replay fallback path requires reconnection — if unavailable, fail through to error banner. |
| Late event from killed adapter | Dropped via restart epoch mismatch (§5). |

---

## Testing Approach

Follow the existing test patterns — vitest, singleton `_resetForTesting()`, zod-validated IPC fixtures.

**Unit tests** (`src/main/instance/__tests__/instance-lifecycle.spec.ts` additions):

- Restart (resume context): native resume success preserves identity and counters.
- Restart (resume context): replay fallback mints new `providerSessionId` and resets backend-session counters.
- Restart (resume context): both fail → `error` state, no adapter running.
- Restart (fresh context): archives old transcript, mints new identity, active segment boundary present.
- Restart epoch: stale events from prior adapter are dropped.
- Pending tool-call rejected with `RestartCancelled` on restart.

**Integration tests** (renderer + IPC):

- Split-button primary vs secondary dispatch lands on correct handler.
- Error banner appears on recovery failure and dismissing via Fresh CTA transitions to fresh flow.

**Manual verification (required — per CLAUDE.md "verify in the actual UI"):**

- Claude: borked session → resume → transcript visible, same thread.
- Claude: forced replay fallback (e.g., corrupted thread file) → transcript preserved, CLI has context.
- Claude: fresh restart → old messages visible-but-archived, new messages land in new segment.
- Codex: resume happy path.
- Gemini / Copilot: Fresh-only fallback UI appears correctly if native/replay unavailable.

---

## Migration Plan

1. Add `providerSessionId` and `restartEpoch` to `Instance`. On load, populate `providerSessionId = sessionId` and `restartEpoch = 0`.
2. Migrate `historyThreadId` usage to always-explicit (today it uses a fallback chain on read). Write through on instance creation.
3. Ship MVP behind no feature flag — it's strictly better than current nuclear restart, and the error banner makes silent regressions impossible.
4. Remove `sessionId` alias in a follow-up once all reads reference `providerSessionId`.

---

## Risks

- **Provider support gaps for Gemini and Copilot.** MVP mitigates by degrading to Fresh-only if native and replay both unconfirmed.
- **Transcript segmentation is a real data-model change.** Deferred to V2; MVP uses a sentinel-marker hack to keep shipping scope tight.
- **Counter accounting is coarse in MVP.** Users may see `totalTokensUsed` grow across resumes, which is arguably correct but worth calling out in release notes.
- **Audit of `outputBuffer` writes (§7) may find pollution.** If so, per-adapter fixes required before replay-fallback can be trusted.

---

## Out of Scope

- LLM-generated "continuation summaries" during recovery (covered by the 2026-03-15 spec's explicit non-goal).
- Auto-detection of when a session is "borked" and preemptive restart.
- Versioned transcripts / per-message editing (orthogonal features).
- Cross-instance thread linking after Fresh restart.
