# Harness Interrupt, Resume & Recovery — Master Hardening Plan

**Status:** ✅ IMPLEMENTED & VERIFIED (2026-06-20) — see "Implementation status" below.
**Date:** 2026-06-19 (plan) · 2026-06-20 (implementation complete)
**Owner:** TBD
**Scope:** Make AI Orchestrator ("Harness") reliable at interrupting running turns, resuming
sessions, and recovering from broken/stuck states — and stop surfacing long silent waits to the user.

---

## Implementation status (2026-06-20)

All implementable scope is **built and verified** (4 gates green — `tsc`, `tsc -p tsconfig.spec.json`,
`npm run lint`, `npm run check:ts-max-loc` — plus 191 targeted vitest tests across 10 specs). The bulk
of Phases 0–4 was completed in prior sessions; the final pass (2026-06-20) closed every remaining
implementable item. Ledger:

**Done & verified**
- Phase 1 P0: force-abort net, interrupt-completion deadline (`runtime/operation-deadline.ts`),
  generation fence in `sendInput`, A7 idle-recovery routing, awaited continuity writes, central
  `resume-error-classifier.ts`, provider-concurrency + session-mutex acquisition timeouts, interrupt ladder.
- Phase 2: `getResumeAttemptResult()` for all six adapters, `writeThroughIdentity()`, id-match resume
  health (B1), config fingerprint (§6.2), Claude transcript-verify + cwd-pin (B7), remote resume-proof proxy.
- Phase 3: `SessionTurnSupervisor` (interruptSeq fence), Codex `pendingAbort`/stale-interrupt guard.
- Phase 4: stdin-drain + post-spawn watchdogs, staged ACP watchdog, stuck-detector evidence-hash fence,
  bounded `initAsync`, respawn circuit breaker, `last-stop-snapshot.ts` (wired into init + escalation).
- Phase 5 (coordinator/adapter side): `RemoteCliAdapter` activity tracking (`getMillisSinceLastActivity`),
  `interrupt()` returns ack + bounded completion (15s → `unknown`), idle-monitor remote heartbeat-stale →
  `remote-heartbeat` wait (120s, informational). Fed by the worker's existing 5s activity watchdog.
- Phase 6 / UX: `InstanceWaitReason` model with producers for provider-slot, interrupt-ack, respawning,
  backoff, quota-park, **terminating**, **mutex**, **resume-proof**, **remote-heartbeat**; renderer
  activity line; loop interrupt awareness (D6); typed invalid-session notice (§3.2); C6 termination gate
  (`builtin-termination-gates.ts`, registered at boot); scripted-cli-adapter fault modes (Phase 0).
- C5: verified covered by existing pre-respawn continuity snapshots (visible via `getCheckpoints`),
  last-stop snapshot on escalation, and conversation archival on terminate — no redundant double-snapshot added.

**Deferred (explicitly out of scope for this cycle; not blocking)**
- Phase 5 worker-side protocol migration (quick-ack + `remoteTurnId` instead of one blocking RPC): not
  done — the worker can't be built/verified in this environment (node-pty). What shipped works against the
  current worker without it (interrupt completion keys off relayed `complete`/`exit`; staleness off the 5s
  watchdog). The `sendInput` RPC remains deliberately unbounded for legitimately long turns.
- Renderer **banner** styling for invalid-session / wait reasons: they already surface as a system message
  and the activity line; dedicated banner styling in the display pipeline is polish, left for later.
- Decoupled-run milestone (§5 Phase 6 longer-term) and the §10 open questions remain as future direction.

> **This is the single consolidated master.** It folds together four earlier drafts —
> the original P0/P1/P2 plan, the reference-project follow-on (Tracks A–G), the
> `SessionTurnSupervisor` model, and the definitive line-verified ledger — into one
> roadmap. Every load-bearing claim was re-checked against the live tree on 2026-06-19.
> Line numbers are signposts; re-diff before implementing (large adapter files marked "≈").

---

## 0. TL;DR

We do **not** have a feature gap. Harness already contains a large amount of session/recovery
machinery (`src/main/session/`, `src/main/instance/lifecycle/`, recovery recipes, snapshots,
mutexes, stuck-process detection). The problem is an **integration and invariant** gap:

1. **Fragmented per-provider and per-subsystem** — each CLI adapter handles interrupt,
   session-ID capture, and resume-failure differently; there is **no single turn/session owner**.
2. **Poll-driven, not event-driven** — failure recovery only fires on a 60s idle poll, so a
   crashed/stuck turn can sit dead for up to a minute before anything reacts.
3. **Unbounded by design** — remote `sendInput`, mutex acquisition, provider slot, stdin drain,
   first-token-after-spawn, and interrupt completion have no timeout, so a wedge becomes an
   indefinite spinner.
4. **Resume "success" is mostly inferred** ("first output within 5s" / "context usage > 0"),
   not proven against the resumed id.
5. **Critical identity state is eventually-durable** (60s autosave), so a crash replays a dead
   session ID → "invalid session id" → retry loop.
6. **The user sees a bare spinner** — there is no `waitReason`/`deadline`/`ETA`/`resumeAt` field
   anywhere in instance state.

The single most important realization from reading the upstream sources: **the providers already
solved most of this, and we are only half using it.** Codex is protocol-first (we degrade silently
to exec+SIGINT); Claude Code ships an in-band `control_request` interrupt (we use SIGINT only);
opencode demonstrates the structural invariants we lack (terminal-state finalizer, structural
cancellation, materialized restore, single-writer-per-session).

The plan groups work into a **verified ledger (§1)**, **symptom root-causing (§2)**, **mined
mechanisms from sibling projects (§3)**, a **reconciled target architecture (§4)**, a **consolidated
phased rollout (§5)**, **newly-named bug classes (§6)**, a **test strategy (§7)**, a
**provider-semantics reference (§8)**, a **file index (§9)**, and **open questions (§10)**.

---

## 1. Verified current-state ledger (ground truth, 2026-06-19)

Findings here were verified by direct reads/greps of the live code, not inferred from docs:
`base-cli-adapter.ts`, `claude-cli-adapter.ts`, `codex-cli-adapter.ts`, `codex/session-scanner.ts`,
`acp-cli-adapter.ts`, `interrupt-respawn-handler.ts`, `session-recovery.ts`, `runtime-readiness.ts`,
`input-formatter.ts`, `idle-monitor.ts`, `session-mutex.ts`, `provider-concurrency-limiter.ts`,
`worker-node-connection.ts`, `instance-communication.ts`, and the rest listed in §9.

Legend: **OPEN** = unimplemented, confirmed; **PARTIAL** = partially mitigated, real gap remains;
**DONE** = already implemented (don't re-do).

### 1.1 Interrupt / respawn / communication

| # | Claim | File:line (verified) | Status | Notes |
|---|---|---|---|---|
| A1 | Escalated (2nd) interrupt fires `adapter.terminate(true).catch()` **without awaiting**, no SIGKILL fallback, nulls `processId` before kill confirmed | `instance/lifecycle/interrupt-respawn-handler.ts:269` | **OPEN** | Process can survive; `processId` lost so cleanup can't find it. (`terminate()` itself escalates SIGTERM→SIGKILL after 5s at `base-cli-adapter.ts:309-321`, but we never await it.) |
| A2 | Accepted-interrupt-**without**-completion leaves `respawnPromise` dangling (most adapters return `{status:'accepted'}` w/o completion) | `interrupt-respawn-handler.ts:357`; base `interrupt()` `base-cli-adapter.ts:336-357` | **OPEN** | Claude SIGINT pauses rather than exits, so neither respawn nor completion fires; next `sendInput` waits the full 30s then errors. |
| A3 | `handleInterruptCompletion()` awaits completion **with no deadline** | `interrupt-respawn-handler.ts:391` | **OPEN** | Wedged Codex/ACP RPC blocks recovery indefinitely. |
| A4 | On respawn spawn-failure the adapter is **not deleted** (unlike unexpected-exit path); a `cleanupAbortedRespawnAdapter()` exists but isn't used on the escalation path | `interrupt-respawn-handler.ts:171` | **PARTIAL** | Escalation path still doesn't delete/fence the stale adapter. |
| A5 | `sendInput()` captures `adapter` *before* the respawn wait, then proceeds | `instance-communication.ts:516` (capture), `:553` (30s `Promise.race` respawn wait) | **PARTIAL** | See A6. |
| A6 | Adapter **is** re-fetched after the wait — but only inside `if (this.deps.refreshAdapterRuntimeConfig)` and **without any adapter-generation/restart-epoch check**; if that dep is undefined the stale line-516 adapter is used | `instance-communication.ts:578-590` | **PARTIAL** | Real gap: no generation fence. The re-fetch is incidental to a config refresh. |
| A7 | Idle-recovery dispatch can call `adapter.interrupt()` → sleep 500ms → `adapter.sendInput(nudge)` directly, bypassing the interrupt state machine, respawn promise, and generation check | `instance/instance-lifecycle.ts` `dispatchRecoveryActions` | **OPEN** | Nudge races user-interrupt/exit/respawn. |
| A8 | Adapter event filtering by generation exists (good) and drops stale events | `instance-communication.ts:912-953` (filter ≈943-950) | **DONE** | Keep; extend to record-as-diagnostic instead of silent drop. |

### 1.2 Resume / restore / session identity

| # | Claim | File:line (verified) | Status | Notes |
|---|---|---|---|---|
| B1 | Resume "health" effectively = "emitted some output within ~5s" for adapters lacking proof; resolves `true` on **any** output event, never compares resumed id to requested id | `instance/lifecycle/runtime-readiness.ts:102` (first-output success), `:216` (narrow classifier) | **OPEN** | Claude echoes the authoritative id in init (`instance-communication.ts:998-1001`) but we never match it. |
| B2 | Only **codex** and **acp** implement `getResumeAttemptResult()`; claude/copilot/cursor/gemini do **not** | codex `codex-cli-adapter.ts:≈3210`; acp `acp-cli-adapter.ts:≈349` | **OPEN** | So `prove()` in `session-recovery.ts:167-192` has no real proof for 4 providers. |
| B3 | No unified resume-failure pipeline; ≥6 duplicated classifier regexes; 4 different behaviors across adapters (Claude propagates, Cursor retries once, Codex-exec clears+retries fresh, ACP throws) | `claude-cli-adapter.ts:≈544`, `cursor-cli-adapter.ts:55`, `history/history-restore-helpers.ts:4`, `history/history-manager.ts:47`, `instance/.../instance-communication-adapter-helpers.ts:52,82`, `runtime-readiness.ts:216` | **OPEN** | Claude has a matcher but no fresh+replay fallback wired; copilot/gemini have none. |
| B4 | Stale resume cursor survives a crash: cursor/sessionId captured in memory, persisted only at autosave | `codex-cli-adapter.ts` capture `:≈793,892` / clear `:≈2436` / getter `:≈3207` | **OPEN** | `planSessionRecovery` guards with `providerSessionPersisted !== false` but not the post-failure window. |
| B5 | History restore uses a **separate, weaker** proof path: polls `status` + `contextUsage.used > 0`, **not** `waitForResumeHealth()`/`getResumeAttemptResult()`; 5s local / 15s remote | `history/history-restore-coordinator.ts:194` (timeout), `:276-315` (`confirmed = contextUsage.used>0`) | **OPEN** | |
| B6 | `SessionRecoveryPlan` correctly avoids native resume when `providerSessionPersisted===false` / blacklisted | `instance/lifecycle/session-recovery.ts:117` | **DONE** | Good base to build on. |
| B7 | cwd-sensitivity (Claude) and id-type confusion (Codex `thread_id` vs `session_id`) not validated before spawning a resume | claude resume is cwd-scoped; codex ids distinct | **OPEN** | Claude `--resume` scans current cwd's lossy-encoded project dir → "No conversation found" from a different cwd. |

### 1.3 Continuity / persistence / locks

| # | Claim | File:line (verified) | Status | Notes |
|---|---|---|---|---|
| C1 | `SessionContinuity.updateState()` marks dirty, does **not** save immediately; no write-through identity API | `session/session-continuity.ts` updateState | **OPEN** | |
| C2 | `instance-event-forwarding.ts` calls async continuity methods **without `await`** inside the bounded queue processor; `BoundedAsyncQueue` only awaits the returned promise, so child promises run untracked | `app/instance-event-forwarding.ts:90` (`updateState` un-awaited), `:92` (`addConversationEntry` un-awaited) | **OPEN** | Queue can't serialize or surface persistence failures. |
| C3 | `session-mutex` has owner metadata + `forceRelease()` (used by termination) but **only a warning timer**, no hard acquisition timeout / poisoned-lock handling | `session/session-mutex.ts:5` (`LONG_HOLD_WARNING_MS`), `:51` (warn-only timer), `:85` (`forceRelease`) | **PARTIAL** | A holder that hangs without being terminated wedges resume/save forever. |
| C4 | Autosave is 60s interval (+ jitter) | `session/autosave-coordinator.ts` | **DONE/by-design** | Keep; add write-through for identity edges only. |
| C5 | `checkpoint-manager` is constructed and invoked, but operationally dormant — `createCheckpoint()` only fires from `RecoveryRecipeEngine` (which only fires from the 60s idle poll); no auto-checkpoint before respawn/terminate | constructed `instance/instance-lifecycle.ts:≈174`; called `recovery-recipe-engine.ts:≈109` | **OPEN** | Wire to respawn/terminate edges. |
| C6 | `TerminationGateManager` framework exists and runs before `stopTracking`, but **zero gates registered** (`registerTerminationGate` has no production callers → always fail-open) | `session/termination-gate-manager.ts` | **PARTIAL** | Register a parallel-tool-result validation gate. |
| C7 | `replay-continuity.ts` preamble builder ready for a fresh+replay pipeline | `session/replay-continuity.ts` | **DONE** | Consume from the new shared pipeline. |

### 1.4 Remote / worker / loop / stuck-detector

| # | Claim | File:line (verified) | Status | Notes |
|---|---|---|---|---|
| D1 | Remote work RPCs disable timeout (`timeoutDisabled = timeout <= 0`); `INSTANCE_SEND_INPUT` passes `0` → unbounded | `remote-node/worker-node-connection.ts:27` (`RPC_TIMEOUT_MS=30_000`), `:270-277` (disable), `:38-48` (`WORK_DISPATCH_METHODS`) | **OPEN** | Disconnect rejects pending fast (`:331-347`); a *connected-but-wedged* worker hangs. |
| D2 | Worker `sendInput` blocks for the **whole turn**; dispatcher returns only `{ok:true}` at end, no immediate turn/control id | `worker-agent/local-instance-manager.ts:408-412`; `worker-agent/worker-rpc-dispatcher.ts:127-137` | **OPEN** | No turn-in-progress channel. |
| D3 | Health: 10s check / 60s degraded / 90s disconnect; failover grace 30s | `remote-node/worker-node-health.ts:8-24`; `remote-node/node-failover.ts:18` | **DONE/by-design** | But none surfaced as ETA to UI. |
| D4 | Idle monitor is poll-only at 60s, handles only `agent_stuck_blocked` + `process_exited_unexpected`, **skips remote** | `instance/lifecycle/idle-monitor.ts:34` (interval), `:179,192` (remote skip) | **OPEN** | Recovery latency up to 60s; remote never auto-recovered locally. |
| D5 | Stuck detector: `tool_executing` soft 600s / hard 1200s, up to 3 alive-deferrals (>1h effective) | `instance/stuck-process-detector.ts:22-23` (timeouts), `:38` (`MAX_ALIVE_DEFERRALS=3`) | **OPEN** | Soft warning only at 10 min; effectively silent. |
| D6 | Loop has good cancellation (flag + pause-gate resolve + late-callback drop) but **does not learn its instance was interrupted** | `orchestration/loop-coordinator.ts:187-188`, `:974-1005` (cancel), `:1435` (late drop) | **OPEN** | No interrupt subscription. |
| D7 | Parked quota loop emits `loop:provider-limit` with `resumeAt` but renderer gets **no countdown/ETA** | `orchestration/loop-provider-limit-handler.ts:88-142` (park/emit), `:148-196` (schedule, `unref`) | **OPEN** | |
| D8 | Provider concurrency limiter only times out if caller passes `timeoutMs`; no default; Cursor/ACP path doesn't pass one | `cli/provider-concurrency-limiter.ts:≈157` | **OPEN** | All-slots-full → unbounded spawn hang. |
| D9 | `safeStdinWrite()` awaits `drain` with **no timeout**; EPIPE swallowed (debug log, not re-emitted) | `cli/adapters/base-cli-adapter.ts:≈679-688` (drain), `:≈559-582` (EPIPE swallow) | **OPEN** | |
| D10 | No first-byte/post-spawn watchdog; only during-stream idle (`DEFAULT_STREAM_IDLE_TIMEOUT_MS=90_000`) | `base-cli-adapter.ts:89` | **OPEN** | Spawn-then-hang waits for the stuck-detector (2-4 min+). |
| D11 | ACP stall warning is one-shot at 3 min, hard at 10 min | `acp-cli-adapter.ts:119` (`DEFAULT_PROMPT_TIMEOUT_MS`), `:131` (`DEFAULT_STALL_WARNING_MS`), one-shot flag `:≈308` | **OPEN** | |
| D12 | Codex restore scans the filesystem (depth-5 walk of `~/.codex/sessions`, stream-parses rollouts) when persisted-cursor resume misses; continuity `initAsync` unbounded | `cli/adapters/codex/session-scanner.ts`; `session/session-continuity.ts` init | **OPEN** | No paging, no index. |

### 1.5 Renderer / UX

| # | Claim | File:line (verified) | Status | Notes |
|---|---|---|---|---|
| E1 | 20 instance statuses exist (incl. `interrupting`, `cancelling`, `interrupt-escalating`, `respawning`, `degraded`) but **no `waitReason`/`deadline`/`resumeAt` field** | `shared/types/instance.types.ts:86-107` | **OPEN** | Status alone is the only signal. |
| E2 | Queued-message UI shows count + text but **no hold-reason** | `renderer/.../instance-detail/input-panel.component.ts:127-133,202-211` | **OPEN** | User can't tell why a message is held. |
| E3 | Harness already has an `isInstanceSettled` predicate + universal target states — reusable infra | `instance/instance-state-machine.ts:33` (universal targets), `:91-116` (`isInstanceSettled`) | **DONE** | Reuse for supervisor wait-gates and "is it safe to send" checks. |

**Bottom line:** of the ~33 verified items, **~26 are OPEN, 5 PARTIAL, the rest DONE/by-design.**
None of the high-severity hang fixes have shipped.

---

## 2. The three reported symptoms → root causes (with severity)

### Symptom A: "Broken/stuck sessions" (interrupt leaves things wedged)

| Root cause | Ledger ref | Severity |
|---|---|---|
| Escalated interrupt fire-and-forget terminate, no SIGKILL fallback, nulls `processId` early | A1 | **HIGH** |
| `respawnPromise` dangles when `interrupt()` returns no completion | A2 | **HIGH** |
| `handleInterruptCompletion()` has no timeout | A3 | **HIGH** |
| Adapter not deleted on respawn spawn-failure (escalation path) | A4 | MED |
| `session-mutex` warn-only, no stale-lock timeout | C3 | **HIGH** |
| Loop coordinator doesn't learn its instance was interrupted | D6 | MED |
| Partial turn output discarded on SIGINT (Claude/Gemini stream) | §8 | MED |

### Symptom B: "Invalid session IDs" (resume fails)

| Root cause | Ledger ref | Severity |
|---|---|---|
| No unified resume-failure handling; same failure → 4 behaviors | B3 | **HIGH** |
| Stale cursor survives a crash | B4 | **HIGH** |
| Resume health = "first output within 5s", no id match | B1 | **HIGH** |
| Only codex/acp implement `getResumeAttemptResult()` | B2 | **HIGH** |
| `resumeCursor` not cleared on fresh-spawn fallback | B4 / instance-lifecycle fallback | MED |
| Fork semantics: Codex app-server reuses same threadId across forks → cross-contamination | §10 Q4 | MED |
| cwd-sensitivity / id-type confusion not validated | B7 | LOW |

### Symptom C: "Long waits" (silent spinners — the cross-cutting one)

| Root cause | Ledger ref | Severity |
|---|---|---|
| Recovery poll-only at 60s, skips remote, two categories | D4 | **HIGH** |
| Remote work RPCs timeout disabled | D1 | **HIGH** |
| Provider concurrency limiter no default timeout | D8 | **HIGH** |
| No first-token timeout after spawn | D10 | MED |
| Session continuity init unbounded | D12 | MED |
| Stuck-detector tool_executing window huge & silent | D5 | MED |
| Parked quota loops show no ETA | D7 | MED |
| Stall warnings one-shot | D11 | LOW |
| Worker-zombie suspension keeps WS open (see MEMORY.md) | D1/D3 | MED |

Every item above presents to the user as a bare spinner (E1/E2) — no countdown for parked quota
loops, no "resuming", no "waiting for a provider slot", no "remote worker unreachable, failing over."
This compounds the perception of all three failure modes.

### Verified failure chains (the concrete sequences behind the symptoms)

- **Stale send after respawn** (P0): `sendInput()` captures the adapter (A5), waits on
  `respawnPromise` while the instance is interrupting/respawning, respawn swaps in a replacement, and
  the continuation can write to the pre-respawn adapter (A6, no generation fence).
- **Accepted interrupt with no terminal signal** (P0): base/remote `interrupt()` return `accepted`
  with no completion (A2); no completion handler runs; future sends wait the full 30s.
- **Invalid session id retries from stale disk identity** (P1/P2): adapter discovers a corrected
  id, marks continuity dirty, autosave lags ~60s; a crash in that window leaves the old id on disk →
  next restore retries a doomed native resume (B4), worsened by the narrow classifier (B3).
- **Remote turn alive at WS layer but dead at turn layer** (P3/P5): remote `sendInput` disables the
  RPC timeout (D1), worker returns only at turn end (D2), idle monitor skips remote (D4) → a long
  generic wait with no "remote heartbeat stale" reason.
- **Recovery nudge races interrupt ownership** (P1): `dispatchRecoveryActions()` calls
  `adapter.interrupt()` → sleep → `adapter.sendInput()` directly (A7), bypassing the state machine,
  respawn promise, generation check, and future supervisor ownership.

### Root-cause model — four architectural gaps

1. **No single turn/session owner.** Adapter ownership, queued input, interrupt, respawn, restore,
   and continuity writes are split across modules, each making locally-correct decisions on stale
   global state.
2. **Resume proof is optional and not universal.** Codex/ACP have proof; Claude/remote don't;
   history restore uses a separate heuristic.
3. **Critical identity state is eventually-durable.** Provider IDs and cursors can be correct in
   memory but stale on disk after a crash or force-quit.
4. **Several waits are intentionally long or unbounded.** Long model turns are valid, but every long
   wait needs a separate liveness channel, owner metadata, and a user-visible reason.

---

## 3. What the reference / sibling projects actually do (mechanisms to steal)

### 3.1 Upstream CLIs we already drive

**Claude Code** (`../claude-code`, plus live transcripts + CHANGELOG)
- **Session id:** UUID; caller can set `--session-id` (2.0.73+); CLI echoes the authoritative id
  in the `system`/`init` event and final `result`. Resume reuses it; only `--fork-session` mints
  new. **The init id is the single source of truth.**
- **Transcript:** `~/.claude/projects/<encoded-cwd>/<id>.jsonl`; encoding is lossy & cwd-sensitive
  (`--resume` scans current cwd's project dir → fails from a different cwd). Resume anchors on
  `leafUuid` walking `parentUuid`; a torn last line is skipped not fatal (2.1.144+).
- **Interrupt:** SIGINT (droppable at the very start of a turn per changelog) **and** an in-band
  `control_request`/`control_response` channel on the stream-json transport the Agent SDK uses for
  a real `interrupt` + `can_use_tool` callbacks. Closing stdin without clean EOF can hang.
- **Adopt:** treat init `session_id` as truth, persist instantly; pin+store cwd with the id; verify
  transcript exists before `--resume`; use in-band interrupt before SIGINT.

**Codex** (`../codex/codex-rs`, Rust)
- **Protocol-first:** even `codex exec` embeds app-server and talks JSON-RPC; stdout scraping is
  not the supported path.
- **Identity:** `thread_id` (UUIDv7, per-conversation — the key we want) vs broader `session_id`.
  `thread/start`/`thread/resume` return `thread.id`; route notifications by it.
- **Resume:** `thread/resume { thread_id }` with `exclude_turns`/`initial_turns_page` to **page**
  history; rollout files are append-only valid prefixes; listing is FS-first + SQLite index.
  Resume precedence `history > path > thread_id` (`ThreadResumeParams.ts:16-24`); running threads
  rejoin + check path consistency (reject resuming a running thread → fork hazard).
- **Interrupt:** `turn/interrupt { thread_id, turn_id }`; cancels at await points, 100ms grace,
  then force-aborts. A mismatched `turn_id` is **rejected** and the turn keeps running. Background
  subprocesses left alive by design. SIGINT to app-server = shutdown, not turn-interrupt.
- **`TurnStatus`** enum (`completed|interrupted|failed|inProgress`,
  `app-server-protocol/schema/typescript/v2/TurnStatus.ts`) is first-class ground truth — stop
  inferring turn state from stdout.
- **Adopt:** key on `thread_id`; track `turn_id` from each `turn/started`; interrupt via RPC; page
  resume; prefer `thread/list` over scanning `~/.codex/sessions`; persist `TurnStatus`.

**opencode** (`../opencode`, the architecture reference)
- **Decoupled run:** long-lived HTTP server owns the loop; prompt handler forks into a server scope
  (`Effect.forkIn`) and returns immediately — the loop keeps running if the client disconnects.
- **Gap-free reconnect:** SSE + per-aggregate `seq` cursor; on reconnect ask for `seq > cursor`,
  replay then merge live, 10s heartbeat. A reload is a non-event.
- **Structural cancellation:** one `Fiber.interrupt` cancels the whole turn tree; an
  `AbortController` bound as a scoped finalizer aborts the in-flight model HTTP request and
  fetch-based tools; children get SIGTERM→SIGKILL after 5s.
- **Terminal-state finalizer:** on **every** exit path a `cleanup()` flushes open text, waits
  briefly for in-flight tools, marks unfinished tool parts `status:"error",interrupted:true`, and
  stamps the assistant message complete. A session **cannot get stuck "busy."**
- **Restore is a read, not a replay:** events projected into materialized SQLite rows via
  idempotent upserts; interactive restore is a cursor-paginated indexed query with lazy hydration.
- **Single writer per session:** `Runner` map keyed by session id + per-key read-modify-write lock;
  concurrent callers coalesce onto the running turn.
- **`SessionRunCoordinator`** (`packages/core/src/session/run-coordinator.ts:8-50`): one drain per
  key, `run` dominates `wake`, `interruptSeq` suppresses pre-interrupt wakes, interrupt does not
  auto-drain pending follow-ups. → backbone of the §4.A supervisor.

### 3.2 CodePilot — the closest analogue (Electron, multi-model, multi-runtime). Highest value.

| Pattern | File:line | Mechanism | Harness adaptation |
|---|---|---|---|
| **Force-abort safety-net (schedule FIRST, unconditional)** | `src/lib/stream-session-manager.ts` `stopStreamWith()` (≈934-975); test `stop-stream-force-abort.test.ts` | Schedule the force-abort timer **before** and **independent of** the graceful interrupt; never gate it behind the interrupt's `.finally()`. Bounded interrupt fetch via `AbortSignal.timeout(STREAM_FORCE_ABORT_MS≈2s)`. (Regression #578: hung interrupt endpoint locked the composer forever.) | **Directly fixes A1/A2/A3.** Arm the SIGKILL/force-cleanup timer immediately on first interrupt, then attempt graceful. Respawn promise resolves from whichever path wins. |
| **Active-turn registry + abort-before-turnId race** | `src/lib/codex/runtime.ts` `activeCodexTurns` + `issueCodexTurnInterrupt()` (≈220-252); test `codex-interrupt-contract.test.ts` | `Map<sessionId,{threadId,turnId}>`. Interrupt returns false if no turn recorded yet; on `turn/start`, if abort requested before turnId existed, re-interrupt instantly (`pendingAbort`). Delete on `run_completed`/`run_failed`. | **New bug class §6.1.** Add registry + abort-race re-interrupt in `codex-cli-adapter`. |
| **Provider + MCP-config fingerprint on the session ref** | `src/types/index.ts:42` (`codex_thread_provider_id`), `:49` (`codex_thread_mcp_fingerprint`); `src/lib/runtime/session-store.ts` | Persist provider id + fingerprint of MCP/model/auth config with the session id; on resume, if provider changed or fingerprint differs → start fresh. | **New bug class §6.2.** Store `{providerId, configFingerprint}` with the cursor; invalidate in `planSessionRecovery()`. |
| **Runtime-agnostic interrupt fan-out** | `src/app/api/chat/interrupt/route.ts`; test `interrupt-route-runtime-fanout.test.ts` | Try-catch each runtime's interrupt independently; one failure must not block others. | Multi-adapter interrupt / "interrupt all" / loop cancel should fan out per-provider with isolated try/catch. |
| **Invalid-session typed signal** | `stream-session-manager.ts` (≈462-490) `chat-invalid-session-provider` event; `provider-resolver.ts` `invalidReason` | Detect deleted/invalid session at send-time, emit a typed event → UI banner; don't stuff the error into the message body. | Maps onto E1/E2 + wait-reason: a definitive invalid-session → typed `waitReason`/notice. |
| **Session-lock settler (idempotent one-shot)** | `src/lib/session-lock-settle.ts`; test `session-lock-settle.test.ts` | First caller wins; always clears renewal interval even if it lost ownership; only writes final status if it still owns the lock (lockId-scoped). | Apply to respawn/interrupt completion so graceful-complete, watchdog-abort, and timeout paths can all "settle" but only the first writes terminal state — prevents status clobber. |
| **Idle/stale stream timeout + GC + clear session on idle** | `stream-session-manager.ts` (≈385-392) `STREAM_IDLE_TIMEOUT_MS=330_000` | Poll every 10s; no event for 330s → abort, report "stream idle timeout", clear the (possibly bad) session ref so next send is fresh; GC completed streams after 5 min. | Complements D9/D10: per-turn idle ceiling that also clears the bad session ref on fire. |

### 3.3 nanoclaw — crash-loop circuit breaker

| Pattern | File:line | Mechanism | Harness adaptation |
|---|---|---|---|
| **Startup/respawn circuit breaker (exponential backoff, 1h reset)** | `src/circuit-breaker.ts:8` (`RESET_WINDOW_MS=1h`), `:11` (`BACKOFF_SCHEDULE_S=[0,0,10,30,120,300,900]`), `:35-36`, `:46` | Persist `{attempt,timestamp}`; within 1h each crash applies the next backoff; after 1h stable, reset. | **Fixes the respawn thrash** (cf. binsout 7h loop memory). Gate respawn/recovery through a per-instance breaker; surface "backing off, retry in Ns" as a `waitReason`. |
| **Series-id batch cancel** | `src/modules/scheduling/db.ts` `cancelTask/pauseTask/resumeTask` (match `id OR series_id`) | Cancel/pause/resume a whole family by `series_id`. | For loop campaigns / fan-out groups, cancel the whole family atomically. |

### 3.4 oh-my-opencode-slim — abort → verify → escalate ladder

| Pattern | File:line | Mechanism | Harness adaptation |
|---|---|---|---|
| **Abort + verify-loop + escalate-to-delete** | `src/tools/cancel-task.ts` (≈206-330 verify, ≈332-412 escalate) | `abort()`, poll status until stable-stopped for ≈3s or timeout (≈8s, 150ms poll); if it bounces back to busy, retry abort; if still not stopped, escalate to `delete()` + re-verify. Every wait bounded. | The canonical interrupt ladder Harness lacks: **never trust a single SIGINT.** interrupt → poll `isInstanceSettled` → escalate `terminate(true)` → SIGKILL, ownership-checked. |

### 3.5 Actual Claude — generation guard & remote reconnect

| Pattern | File | Mechanism | Harness adaptation |
|---|---|---|---|
| WS states distinguish reconnecting vs permanently closed; session-not-found close code gets a limited retry budget (can be transient); unsupported control requests return an error so callers don't hang; `QueryGuard` generation counter so stale `finally` doesn't clear newer state | `remote/SessionsWebSocket.ts`, `remote/RemoteSessionManager.ts`, `utils/QueryGuard.ts`, `utils/combinedAbortSignal.ts`, `hooks/useRemoteSession.ts` | Generation tokens on turn ownership + UI actions; limited retry for ambiguous "session not found" during compaction/reconnect but immediate blacklist for definitive invalid IDs | Remote/worker control calls always return ack/error, never silent accepted-with-no-completion. |

### 3.6 agent-orchestrator — bounded locks, evidence-hash, atomic last-stop

| Pattern | File:line | Mechanism | Harness adaptation |
|---|---|---|---|
| **O_EXCL advisory lock w/ owner metadata + stale-owner cleanup + jittered backoff + timeout** | `packages/cli/src/lib/running-state.ts:88` (`O_EXCL`), `:49,130` (`isProcessAlive`) | Atomic lock create; embed `{pid,acquiredAt}`; on contention if owner pid dead → unlink + retry; jittered backoff; hard timeout. | Concrete blueprint for C3's missing **mutex acquisition timeout + poisoned-lock recovery**. |
| **Atomic `last-stop.json` crash snapshot (temp+rename)** | `running-state.ts:29` (`LAST_STOP_FILE`), `:179` (`atomicWriteFileSync`) | On stop/crash atomically write the recoverable sessions; prompt restore on next launch. | Harness "last active recoverable sessions" snapshot written before shutdown and before destructive interrupt escalation (pairs with C5). |
| **Evidence-hash fence for the detecting/stuck loop** | `packages/core/src/lifecycle-status-decisions.ts:48-147` | Hash normalized evidence (excluding timestamps); unchanged → keep `detectingStartedAt`, increment attempts; changed → reset; escalate after 3 attempts OR 5 min. | Bound D5 deterministically — stop deferring forever on "still alive". |
| Canonical lifecycle states incl. `detecting`/`stuck`; probe failures preserved as evidence; Ctrl+C and stop = same graceful shutdown | `CLAUDE.md`, `running-state.ts`, `lifecycle-manager.ts`, `session-manager.ts` | — | Preserve probe evidence in instance state + UI. |

### 3.7 codex-plugin-cc — durable jobs + out-of-band interrupt broker

| Pattern | File | Mechanism | Harness adaptation |
|---|---|---|---|
| Jobs synchronously written `queued/running/completed/failed/cancelled`; progress persists `threadId`+`turnId`; cancel = `turn/interrupt` → terminate process tree → mark cancelled; session end cleans up jobs; broker lets `turn/interrupt` through even while a streaming turn owns the broker | `plugins/codex/scripts/lib/tracked-jobs.mjs`, `job-control.mjs`, `process.mjs`, `session-lifecycle-hook.mjs:81-125`, `app-server-broker.mjs` | Make turn state durable like job state; interrupt is an out-of-band control op with priority over normal send/stream ownership; session end/termination cleans up active turn records + adapter ownership | → §4.C turn journal + termination cascade. |

### 3.8 openclaw — abortable wrappers & generation fences

| Pattern | File | Mechanism | Harness adaptation |
|---|---|---|---|
| `abortable(signal,promise)` rejects on abort even if the provider promise never settles; session-file ownership waits have timeout+abort; writes use fingerprints+generations; `/stop` clears queued followups, aborts active run, persists abort target, stops subagents; best-effort 5s interrupt timeout then **retire (delete) the wedged client** rather than reuse | `src/agents/embedded-agent-runner/run/abortable.ts`, `attempt.session-lock.ts`, `auto-reply/reply/commands-session-abort.ts`, `reply-run-registry.ts`, `extensions/codex/src/app-server/attempt-client-cleanup.ts:12-14,≈109-160` | Wrap provider waits + interrupt completion with abort/deadline; generation/fingerprint fences on continuity writes; stop/interrupt clears/reassigns queued sends by interrupt sequence; retire-don't-reuse timed-out adapters (closes A4) | Pairs with the force-abort net + abort-verify-escalate ladder. |

### 3.9 copilot-sdk — capability negotiation & stateful resume

| Pattern | File:line | Mechanism | Harness adaptation |
|---|---|---|---|
| Capabilities reported on create **and** resume; workspace-path resume for stateful providers | `nodejs/src/session.ts:182-184` (`SessionCapabilities`), `:174-176` (`workspacePath`) | Host advertises capabilities symmetrically; resume not assumed weaker than create; stateful providers resume by restoring a workspace dir | Query provider capabilities once; gate interrupt/resume/partial-output per provider; treat on-disk session/workspace as a resume source (matches codex `path` precedence). |

### 3.10 Capability matrix (where Harness stands)

| Capability | claude-code ideal | codex ideal | opencode ideal | Harness today | Gap |
|---|---|---|---|---|---|
| Interrupt channel | in-band `control_request` | `turn/interrupt` RPC | structural abort tree | Codex RPC in app-server mode; Claude/Gemini/Copilot/Cursor SIGINT only; Codex exec → SIGINT | Claude no in-band interrupt; Codex degrades silently |
| Session id source of truth | init `session_id` | `thread/start` response | typed prefixed id | capture Claude init id + Codex thread id, but resume health never matches | No identity confirmation on resume |
| Resume failure handling | n/a | RPC error | typed NotFound | 4 behaviors across adapters; only codex+acp `getResumeAttemptResult` | No unified pipeline |
| Stuck-busy prevention | n/a | n/a | terminal finalizer on every exit | `respawnPromise` dangles; escalation nulls `processId` early | No always-settle finalizer |
| Recovery latency | event | event | event/in-process | 60s poll only, skips remote | Not event-driven |
| Restore speed | leaf-anchored | paged `thread/resume` | indexed read | Codex full-tree JSONL scan; unbounded init | No paging, no index |
| Bounded awaits | n/a | n/a | scoped timeouts | mutex warn-only; limiter unbounded; remote RPC disabled | Several unbounded wedge points |
| Run decoupled from UI | yes (SDK) | yes (server) | yes (server) | loop tied to Electron main + instance lifecycle | Reload/crash can orphan a run |

---

## 4. Target architecture (reconciled supervisor design + mined mechanisms)

Design north-star — five invariants every fix moves toward:
1. **No unbounded await** on a process, RPC, mutex, or disk op — each gets a timeout + defined fallback.
2. **Every resume failure degrades gracefully to fresh+replay**, identically across all providers, via one shared code path.
3. **Recovery is event-driven first, polled second.**
4. **A held lock or in-flight interrupt always resolves** — by completing, timing out into a deterministic state, or force-killing + cleaning up.
5. **The user always sees the wait** — any wait > ~5-8s gets a status, a reason, and (where known) a countdown/ETA.

### A. `SessionTurnSupervisor` (per instance, single owner)

The only object allowed to: admit user input; start/interrupt/cancel/recover a turn; respawn the
adapter; decide whether queued input survives an interrupt; mark resume proven/blacklisted;
complete/fail/abandon a turn.

```ts
interface SessionTurnSupervisor {
  admitInput(input: UserInputEnvelope): Promise<AdmittedInput>;
  startTurn(admitted: AdmittedInput): Promise<TurnHandle>;
  interruptTurn(reason: InterruptReason): Promise<InterruptOutcome>;
  cancelTurn(reason: CancelReason): Promise<CancelOutcome>;
  recoverTurn(reason: RecoveryReason): Promise<RecoveryOutcome>;
  awaitIdle(options: AwaitIdleOptions): Promise<AwaitIdleResult>;
  markProviderIdentity(identity: ProviderIdentityUpdate): Promise<void>;
  markResumeProof(proof: ResumeProof): Promise<void>;
}
```

State it owns: `instanceId`, `turnGeneration`, `adapterGeneration`, `restartEpoch`, `activeTurnId`,
`providerTurnId`, `providerSessionId`, `resumeCursor`, `interruptSeq`, `activeOperation`,
`pendingInputs`, `lastResumeProof`, `durableStateRevision`.

Built from: opencode run-coordinator semantics (`interruptSeq`, run>wake), Harness's existing
`isInstanceSettled` (E3) as the wait-gate, and the CodePilot force-abort net (§3.2) as the backstop.

Invariants: a send always targets the current adapter generation (closes A6); a stale adapter may
emit events but cannot mutate ownership (extend A8 to record-as-diagnostic); **every accepted
interrupt reaches a terminal outcome in bounded time** (force-abort net guarantees this); every
recovery-affecting identity update is durably written before "recovery complete" is reported;
recovery recipes can request actions but cannot directly write to adapters.

### B. `ResumeProofService` (central proof + classification)

- One `resume-error-classifier.ts` (union of all B3 regexes + structured codes) consumed by
  adapters, runtime-readiness, history-restore, event handling.
- Calls adapter `getResumeAttemptResult()` where available; requires proof before accepting user
  input after native resume, else marks `resume-unconfirmed` + prepares replay.
- Encodes codex resume precedence `history > path > thread_id` and the **provider/MCP fingerprint
  check** (§3.2) — fingerprint mismatch ⇒ skip native resume.
- Implements `getResumeAttemptResult()` for claude/copilot/cursor/gemini (B2): Claude confirms
  against the `session_id` echoed in init + absence of a session-not-found error.

```ts
interface ResumeProofProvider {
  getResumeAttemptResult(): ResumeAttemptResult | null;        // { method, confirmed, sessionId }
  getCurrentProviderIdentity(): ProviderIdentity | null;
  classifyResumeError(error: unknown): ResumeErrorClassification;
}
```

Provider work: Codex/ACP already close (add turn/thread status + cursor write-through + visible slot
timeout); Claude add explicit proof; Remote proxy worker proof to main; legacy adapters either
implement proof or mark native resume unsupported.

### C. Durable turn journal + write-through identity

- Journal edges on the existing continuity event log + persistence queue:
  `admitted / started / provider-identity-updated / interrupt-requested / interrupt-acked /
  interrupted / cancel-requested / cancelled / resume-attempted / resume-proven / resume-failed /
  fallback-replay-started / completed / failed`.
- `SessionContinuity.writeThroughIdentity()` (C1): enqueue + **await** a save for `providerSessionId`,
  thread/turn ids, `resumeCursor`, resume proof, blacklist/`nativeResumeFailedAt`. Called when
  adapters confirm ids, on resume success/fail, and before respawn-complete resolves (closes B4).
- Fix C2: `await` continuity calls in `instance-event-forwarding.ts:90,92` (or explicit `void` +
  error log for hot-path-only updates).
- Persist Codex `TurnStatus` (§3.1) as the turn's normalized status; synthesize for non-native
  providers. **Acceptance rule:** if an event controls future recovery, it must be persisted before
  UI/main state reports the operation complete.

### D. Bounded-operations utility

```ts
withOperationDeadline<T>({ name, owner, deadlineMs, signal, onTimeout, operation }): Promise<T>
```

Applied to: interrupt completion (A3), terminate/force-cleanup (A1), **mutex acquisition** (C3,
using the agent-orchestrator O_EXCL blueprint), provider-concurrency acquisition (D8), stdin drain
(D9), spawn first-byte/readiness (D10), remote turn heartbeat (D1/D2), history-restore proof (B5),
permission-request cancellation. Every timeout emits a structured event with owner+phase+recovery
action (not a silent failure).

### E. Remote turn control plane

Change remote long sends from "one RPC blocks the whole turn" to a control plane: worker returns a
`remoteTurnId` quickly → streams progress/heartbeat tagged with it → main can interrupt/cancel by
id → worker emits a terminal event → if heartbeat is stale, main marks the remote turn stuck even
while the WS is connected (D1/D2/D4). Introduce first as a wrapper around the current long RPC
(heartbeat + deadline), then migrate to quick-ack.

### F. Interrupt ladder + crash-loop breaker (cross-cutting)

- **Interrupt ladder** (§3.4): `interrupt → arm force-abort net → poll isInstanceSettled to
  stable-stopped → escalate terminate(true) → SIGKILL`, each step bounded, ladder owned by the
  supervisor.
- **Circuit breaker** (§3.3): per-instance respawn/recovery backoff `[0,0,10,30,120,300,900]s`,
  1h reset, surfaced as `waitReason: backoff`.
- **Retire-don't-reuse** (openclaw): a timed-out adapter/client is retired and deleted, never reused
  (closes A4 on the escalation path).

### G. UI wait-reason model

```ts
type InstanceWaitReason =
  | { kind: "provider-slot"; provider: string; startedAt: string; deadlineAt: string }
  | { kind: "interrupt-ack"; startedAt: string; deadlineAt: string; attempt: number }
  | { kind: "terminating"; force: boolean; startedAt: string; deadlineAt: string }
  | { kind: "respawning"; strategy: "native-resume" | "fresh-replay"; startedAt: string }
  | { kind: "resume-proof"; provider: string; sessionId?: string; deadlineAt: string }
  | { kind: "remote-heartbeat"; nodeId: string; remoteTurnId?: string; staleForMs: number }
  | { kind: "mutex"; operation: string; owner?: string; waitedMs: number }
  | { kind: "quota-park"; provider: string; resumeAt: string }
  | { kind: "backoff"; attempt: number; retryAt: string };
```

Renderer: concise activity line + diagnostics drawer (provider session id, adapter generation,
turn id, latest proof, evidence hash); parked-quota countdown to `resumeAt` (D7); queued messages
carry a hold-reason (E2); typed invalid-session banner (§3.2). Keep primary actions honest:
`Interrupt`, `Cancel`, `Force restart`, `Replay from history`.

---

## 5. Consolidated phased rollout

Each item lists the §1 ledger ids it closes and the §3 mechanism it borrows. Verify after every
phase: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, targeted vitest.

> **Execution contract for agentic workers:** use `superpowers:subagent-driven-development` for any
> multi-file slice, then `superpowers:verification-before-completion` before claiming a slice done.
> Principle: make recovery state **owned, bounded, durable, and explainable.** Do not add another
> renderer-only watchdog as the main fix — renderer status reflects backend ownership; backend
> ownership must not depend on the renderer staying open. Do not commit unless James asks; keep this
> file untracked until built + verified + renamed `_completed`; no secrets in logs/tests/fixtures;
> preserve unrelated dirty work.

### Phase 0 — Observability & fault injection (do first; prove fixes)
- Structured lifecycle logging for interrupt/respawn/resume-proof/identity-update/
  stale-event-ignored/mutex-wait/remote-heartbeat (telemetry foundation for §G).
- Extend `cli/adapters/scripted-cli-adapter.ts` with: ignores SIGTERM; accepted-no-completion;
  completion-never-settles; resume-not-found; exits-after-interrupt; never-exits-after-interrupt;
  stale-adapter-send-after-respawn (incl. `refreshAdapterRuntimeConfig===undefined`); stdin-drain-
  never-fires; spawn-never-emits; never-releases-mutex; wrong-`turn_id` interrupt; app-server-init-
  timeout (forces Codex exec degradation).
- Fake remote worker: open-WS-no-completion; heartbeat-stops-mid-RPC; interrupt-ack-no-completion;
  disconnect/reconnect-during-interrupt.
- Continuity persistence tests: slow save + failure ordering (reproduces C2).

### Phase 1 — P0 correctness (small, high-leverage; ship as one PR series)
1. **Force-abort net on interrupt** (§3.2) + **SIGKILL fallback w/ pre-captured pid**, awaited
   bounded terminate before clearing ownership → closes **A1, A2, A4 (escalation)**.
2. **Deadline around `handleInterruptCompletion()`** → **A3**; timeout ⇒ `interrupt-timeout` +
   escalate ladder. (Add a small `runtime/operation-deadline.ts`.)
3. **Generation fence after respawn wait in `sendInput()`** (re-fetch + verify
   `adapterGeneration`/`restartEpoch`; also handle `refreshAdapterRuntimeConfig===undefined`) →
   closes the real part of **A5/A6**.
4. **Route idle-recovery nudge through a lifecycle recovery API**, not direct adapter calls → **A7**.
5. **`await` continuity calls in `instance-event-forwarding.ts:90,92`** → **C2**.
6. **Central `resume-error-classifier.ts`**, consumed everywhere; persist blacklist immediately on
   a definitive hit → **B3** (foundation). Cover: `no conversation found`, `session not found`,
   `thread not found`, `conversation not found`, `invalid session`, `invalid thread`,
   `unknown session`, `unknown thread`, `expired session`, `no such thread`, `does not exist`,
   `missing rollout`, Codex `no rollout found`, Cursor `session expired`.
7. **Default provider-concurrency acquire timeout** (60-120s) + surfaced "waiting for provider
   slot" → **D8**.
8. **Mutex acquisition timeout + poisoned-lock recovery** (agent-orchestrator O_EXCL blueprint;
   `forceRelease` already exists) → **C3**.
9. **Interrupt ladder skeleton** (abort → verify-settled → escalate) using `isInstanceSettled` →
   seeds **F**, closes the single-SIGINT-trust gap.

### Phase 2 — Resume proof + identity write-through
- `ResumeProofService` + `getResumeAttemptResult()` for claude/copilot/cursor/gemini → **B1, B2**.
- `writeThroughIdentity()` in continuity; persist sessionId/cursor/proof/blacklist immediately →
  **B4, C1**. On fresh-spawn fallback, clear the cursor.
- History restore uses the proof service, not context-usage polling → **B5**.
- **Provider/MCP fingerprint** stored with cursor; mismatch ⇒ skip native resume (§3.2, §6.2).
- Verify-transcript-before-`--resume` + pin cwd with id (Claude, B7).
- Proxy remote worker resume proof to main.

### Phase 3 — `SessionTurnSupervisor`
- Introduce supervisor (§4.A); move sendInput admission + interrupt/cancel/respawn decisions behind
  it; `interruptSeq` wake-suppression (opencode); durable turn journal (§4.C); reconcile renderer
  queue with admitted input; reuse loop-mode cleanup dedupe for chat adapters.
- **Active-turn registry + abort-before-turnId race** for Codex app-server (§3.2, §6.1).
- Track Codex `turn_id` per `turn/started`; reject our own stale interrupts cleanly.

### Phase 4 — Bound every long wait
- stdin drain timeout (D9); spawn first-byte watchdog (D10); EPIPE → recovery signal (D9); staged
  ACP watchdog (warn→suggest→hard→cancel, repeating) (D11); stuck-detector evidence-hash fence +
  sooner soft warnings (D5); bound `initAsync` with a degraded-but-usable fallback (D12).
- **Circuit breaker** on respawn/recovery (§3.3, §F).
- Codex paged resume (`exclude_turns`/`initial_turns_page`) + prefer `thread/list` over the depth-5
  `session-scanner` walk; demote scanner to last-resort with a result cap + time bound (D12).

### Phase 5 — Remote resilience
- `remoteTurnId` + heartbeat deadline; remote interrupt returns ack + terminal event; idle monitor
  handles remote heartbeat-stale; distinguish WS-connected / node-degraded / turn-heartbeat-stale /
  disconnected; late-reconnect recovery action; tie into worker-zombie detection (close socket on
  suspected suspension — see MEMORY.md) → **D1, D2, D4**.

### Phase 6 — Event-driven recovery + checkpoints + UI + operator tools
- Event-driven recovery triggers (process exit / EPIPE / resume-not-found / first-token watchdog)
  with the 60s poll as backstop; extend recovery to remote + an `invalid_session_id` category →
  **D4**.
- Save-before-respawn; wire `checkpoint-manager` to respawn/terminate edges + atomic
  `last-stop.json` snapshot (§3.6, C5); register a parallel-tool-result termination gate (C6).
- `InstanceWaitReason` model + renderer activity line + diagnostics drawer + parked-quota countdown
  + queued-message hold-reason → **E1, E2, D7**; typed invalid-session banner (§3.2); repeating/
  escalating stall warnings.
- Loop interrupt awareness (D6) + parked-loop ETA (D7).
- Manual operator actions: retry-resume-proof, blacklist-session-and-replay, force-restart,
  dump-diagnostics, single **"Recover session"** (wire `session-revival-service` /
  `recovery-recipe-engine` to a manual entrypoint).
- (Longer-term / separate milestone) **Decouple the run from the UI** (opencode model): agent loop
  in a supervised main-process/worker service that outlives the renderer; renderer subscribes over
  an event stream and reconnects via a per-instance seq cursor; event-sourced materialized restore
  index so restore is an O(window) query. This is the structural fix that makes stuck sessions rare
  by construction rather than by recovery.

### Sequencing notes
- Recommended first cut: **Phase 0 + Phase 1 (items 1-6)** as one PR series — each independently
  testable with the scripted adapter — then Phase 2 (proof + write-through + fingerprint), then the
  supervisor.
- Phase 3 only after proof/write-through are stable (the supervisor should coordinate proven
  primitives, not invent them all at once). Phases 4 & 5 can run partly in parallel after supervisor
  boundaries are clear. Phase 6 lands incrementally with each backend phase.
- Quick-win sizing (from the original plan): **≤~1 day, low risk** — force-abort net, adapter-delete
  on failure, mutex stale-lock, concurrency default timeout, first-token watchdog, repeating stall
  warnings, bounded `initAsync`. **Medium** — respawn-promise settling, remote RPC bounds, per-adapter
  proof, write-through, save-before-respawn, wait-surfacing, gate/checkpoint wiring. **Larger /
  cross-cutting** — shared resume pipeline, event-driven recovery rewire, supervisor, partial capture,
  telemetry + UX, decoupled run.

### Implementation checklist (concrete PRs)

**PR 1 — reproduce & fix the stuck-interrupt bugs**
- [ ] Extend `interrupt-respawn-handler.spec.ts`: accepted-without-completion, never-settling
      completion, second-interrupt escalation, process-exits-after-interrupt.
- [ ] `instance-communication.spec.ts`: capture adapter A → respawn → swap to B → assert only B
      receives `sendInput()`.
- [ ] `instance-communication.ts`: every respawn wait followed by fresh `getInstance()`+`getAdapter()`
      + adapter-generation/restart-epoch validation.
- [ ] `runtime/operation-deadline.ts` (deadline-wrapped promises; dependency-free; tested).
- [ ] Wrap interrupt completion with a deadline; treat accepted-without-completion as a bounded phase
      (wait grace → escalate bounded termination); await bounded `terminate(true)` before clearing
      ownership; delete/fence the adapter afterward.
- [ ] Keep all interrupt outcomes structured enough to drive a future `waitReason` (no log parsing).
- Verify: `npx vitest run …interrupt-respawn-handler.spec.ts`, `…instance-communication.spec.ts`, +
  the four quality gates.

**PR 2 — durable & classifiable recovery state**
- [ ] `resume-error-classifier.ts`; move `isSessionNotFoundMessage()` behind it; cover the phrase set
      in Phase 1 item 6; consume from adapter-helpers, runtime-readiness, history-restore-helpers,
      adapter resume/catch paths.
- [ ] `SessionContinuity.writeThroughIdentity()` (update state, capture latest cursor, enqueue save,
      await completion); use on provider id/thread id change in `setupAdapterEvents()` and on
      definitive blacklist.
- [ ] Fix `instance-event-forwarding.ts:90,92` to `await`.
- [ ] Tests in session-continuity, instance-event-forwarding, runtime-readiness, history-restore.

**PR 3 — route recovery through one backend owner**
- [ ] Minimal `SessionTurnSupervisor` skeleton (ownership state only: `turnGeneration`, `interruptSeq`,
      `adapterGeneration`, `restartEpoch`, `activeOperation`, `pendingInputs`).
- [ ] `sendInput()` admission through supervisor; `dispatchRecoveryActions()` recipes call supervisor
      recovery APIs not direct adapters.
- [ ] Durable turn journal over the existing continuity event log (small schema first).
- [ ] Late-event diagnostics for provider callbacks rejected by generation.

**PR 4 — remote turn heartbeats**
- [ ] `remoteTurnId` in worker/main flow; worker send returns quick ack then tagged progress/
      heartbeat/terminal events; `RemoteCliAdapter.interrupt()` returns ack + completion; remote
      heartbeat-stale detection in main lifecycle; renderer `waitReason` for remote stale/reconnecting.
- [ ] Tests in `remote-cli-adapter.spec.ts` + worker RPC tests + fake worker (open WS + stale heartbeat).

---

## 6. Newly-named bug classes

### 6.1 Abort-before-turnId race (Codex app-server)
Codex interrupt needs `currentTurnId`; an interrupt arriving between spawn and the first `turn/start`
response is silently dropped (base `interrupt()` falls through; app-server path requires
`this.currentTurnId`). **Fix:** CodePilot's `activeCodexTurns` registry + `pendingAbort` re-interrupt
the moment the turnId is recorded (§3.2). Add a contract test mirroring `codex-interrupt-contract.test.ts`.

### 6.2 Stale-config native resume (provider/MCP fingerprint)
Harness changes model/MCP/auth under a live session, then later resumes the persisted session id
against a **different** config — risking 400s or wrong tools. No fingerprint is stored or checked
today. **Fix:** persist `{providerId, configFingerprint}` with the cursor; `planSessionRecovery()`
skips native resume on mismatch (§3.2, Phase 2).

### 6.3 Respawn crash-loop thrash
A structurally broken session (bad cursor, wedged adapter) is respawned repeatedly with no backoff —
the "stuck session + long waits" James reports, and a contributor to runaway loops (cf. binsout 7h
memory). **Fix:** per-instance circuit breaker with exponential backoff + 1h reset, surfaced as
`waitReason: backoff` (§3.3, Phase 4).

---

## 7. Verification / test strategy

**Scripted adapter fault injection** (`cli/adapters/scripted-cli-adapter.ts`): ignores-SIGTERM,
accepted-no-completion, completion-never-settles, resume-not-found, spawn-then-hang, never-releases-
mutex, app-server-init-timeout (Codex exec degradation), wrong-`turn_id` interrupt, stale-adapter-
send-after-respawn (incl. `refreshAdapterRuntimeConfig===undefined`), stdin-drain-never-fires.

Targeted specs:
- **Force-abort net:** interrupt whose graceful path never settles still frees the instance within
  the force-abort window (port `stop-stream-force-abort.test.ts`).
- **Abort-before-turnId:** interrupt issued before turnId recorded → re-interrupts on `turn/start`
  (port `codex-interrupt-contract.test.ts`).
- **Resume identity:** `waitForResumeHealth` returns false when the provider resumed a different id
  than requested, for every provider.
- **Per-adapter resume-fail parity:** one parameterized test — identical fresh+replay+single-notice
  across all six adapters; never loops (B3).
- **Always-settle:** after any interrupt path, `respawnPromise` resolves within 1s and the instance
  reaches a definite state; no orphan survives a SIGTERM-ignoring adapter.
- **Generation fence:** stale adapter after respawn never receives the send.
- **Fingerprint invalidation:** resume with changed model/MCP fingerprint → fresh+replay, not native.
- **Circuit breaker:** N rapid respawns back off per schedule; 1h stability resets.
- **Abort-verify-escalate ladder:** SIGINT-ignoring adapter escalates to terminate then SIGKILL in bound.
- **Mutex acquisition timeout / poisoned lock:** dead-owner lock reclaimed; waiters unblocked w/ structured error.
- **Bounded awaits:** concurrency-limiter default timeout; remote-RPC timeout/failover.
- **Recovery latency:** event-driven respawn fires in < ~3s vs the 60s poll.
- **Continuity:** identity write-through persists before resolving; blacklist persists immediately;
  event forwarding awaits queued async work; slow-save ordering.

**Integration fakes:** CLI that ignores SIGINT / exits after SIGINT / prints invalid session id then
exits / never drains stdout; Codex-like app-server mock (`thread/resume`, `turn/start`,
`turn/interrupt`); ACP-like mock that times out prompt/cancel; remote worker mock with controlled
heartbeat + disconnect.

**Integration scenarios:** interrupt local turn → respawn native resume succeeds; interrupt → native
resume invalid → replay fallback succeeds; send during respawn → exactly one delivery to new adapter;
kill app after new session id emitted → restart restores from the durable new id; remote heartbeat
stops while WS open → stuck/recovery UI; history restore with invalid id does not loop native resume.

**Manual smoke matrix** — providers {Claude local, Codex app-server local, Codex exec local, ACP
Copilot, ACP Cursor, Gemini, Remote Codex} × flows {normal send, interrupt once, interrupt twice/
escalate, send during interrupt, app quit during active turn, relaunch+restore, provider session
invalidated externally, remote node disconnect, remote alive-but-wedged}. Each must show a legible
status and recover.

**Gates after each change:** `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
`npm run lint`, `npm run check:ts-max-loc`, targeted vitest.

---

## 8. Provider semantics reference (ground truth — design against this)

| Provider | Session id source | Resume flag | ID written | Resume-fail string | Interrupt | Partial-state safety |
|---|---|---|---|---|---|---|
| **Claude Code** | `session_id` in stream system msg | `--resume <id>` (`--session-id` fresh, `--fork-session` fork) | at session start; JSONL `~/.claude/projects/<proj>/<id>.jsonl` | not special-cased today → **add matcher** | SIGINT → `waiting_for_input` (+ in-band `control_request` available) | JSONL best-effort async (flush race possible) |
| **Codex** | app-server `thread/start`/`thread/resume`; JSONL scan fallback (`~/.codex/sessions/rollout-*.jsonl`) | app-server `thread/resume`; exec `codex exec resume <id>` | at thread creation | `session not found\|thread not found\|no matching session` | app-server `turn/interrupt` RPC (clean); exec → SIGINT (degraded) | line-delimited JSONL, atomic per entry (safe) |
| **Copilot** | `sessionId` in `result` event | `--resume <id>` | at first turn completion | not documented → graceful fresh | SIGINT kills exec-per-msg subprocess | exec-per-message; exit = flush (safe) |
| **Cursor** | `session_id` from stream/result | `--resume <id>` | per turn | `invalid session id\|session not found\|session expired` | SIGINT | per-message |
| **Gemini** | none (orchestrator-local id) | **no resume** (`supportsResume:false`) | n/a — replay full history each call | n/a | SIGINT | stateless (safe) |
| **ACP (Copilot/Cursor bridge)** | `session/new` returns id | `session/load` RPC | at session create | RPC validation/throw | `session/cancel` notification + local reject | depends on agent |

Key implication: **Gemini and exec-per-message providers are inherently safe** (replay or atomic).
The risk concentrates in **Claude (flush race + no resume-fail matcher + SIGINT-only interrupt)** and
**Codex (stale cursor across crash + silent exec degradation + abort-before-turnId race)** — Phases 1–3
target exactly these.

---

## 9. File index (where the work lands)

- `cli/adapters/base-cli-adapter.ts` — first-byte watchdog (distinct from stream-idle); stdin-drain
  timeout; EPIPE→recovery signal; carry a completion for SIGINT providers; best-effort interrupt
  timeout; partial capture; emit recovery signal on exit/EPIPE.
- `cli/adapters/claude-cli-adapter.ts` — in-band `control_request` interrupt; `getResumeAttemptResult()`
  keyed on init `session_id` match; verify-transcript-before-`--resume`; pin cwd with id.
- `cli/adapters/codex-cli-adapter.ts` — track `turn_id` per `turn/started`; reject stale interrupts;
  active-turn registry + abort-race; paged `thread/resume`; prefer `thread/list` over FS scan; make
  exec degradation a surfaced, retried event; cursor write-through.
- `cli/adapters/{copilot,cursor,gemini}-cli-adapter.ts` — `getResumeAttemptResult()`.
- `cli/adapters/resume-recovery.ts` *(new)* — shared not-found matcher + fresh+replay path.
- `cli/adapters/resume-error-classifier.ts` *(new)* — central classifier.
- `cli/adapters/codex/session-scanner.ts` — demote to last-resort; result cap + time bound.
- `cli/provider-concurrency-limiter.ts` — default acquire timeout w/ typed, surfaced error.
- `instance/lifecycle/interrupt-respawn-handler.ts` — force-abort net; SIGKILL w/ pre-captured pid;
  completion deadline; abort-verify-escalate ladder; retire-on-fail; await SIGKILL before `cancelled`.
- `instance/instance-communication.ts` — generation fence after respawn wait; persist adopted id
  immediately; surface interrupt rejection.
- `instance/instance-lifecycle.ts` — recovery via supervisor; save-before-respawn; checkpoint wiring;
  clear cursor on fresh fallback.
- `instance/lifecycle/idle-monitor.ts` — event-driven triggers; cover remote + `invalid_session_id`; keep poll as backstop.
- `instance/lifecycle/runtime-readiness.ts` / `session-recovery.ts` — id-match resume proof; codex
  resume precedence; fingerprint check; adaptive timeout.
- `instance/stuck-process-detector.ts` — evidence-hash fence + sooner warnings.
- `session/session-mutex.ts` — acquisition timeout + poisoned-lock (on top of existing warn + forceRelease).
- `session/session-continuity.ts` — `writeThroughIdentity()`; bounded `initAsync`.
- `session/{termination-gate-manager,checkpoint-manager,session-revival-service,recovery-recipe-engine}.ts`
  — register gate; wire checkpoint to respawn/terminate; manual recover action.
- `session/last-stop-snapshot.ts` *(new)* — atomic recoverable-sessions snapshot.
- `session/replay-continuity.ts` — fresh-start preamble (consumed by the shared pipeline).
- `app/instance-event-forwarding.ts` — `await` continuity (`:90,92`).
- `remote-node/{worker-node-connection,worker-node-health,node-failover}.ts` + `worker-agent/*` —
  bounded work RPCs / `remoteTurnId` + heartbeat deadline; faster zombie detection.
- `orchestration/{loop-coordinator,loop-control,loop-provider-limit-handler}.ts` — interrupt awareness
  + parked-loop ETA.
- `instance/session-turn-supervisor.ts` *(new)* + `runtime/operation-deadline.ts` *(new)* +
  `instance/circuit-breaker.ts` *(new)*.
- `shared/types/instance.types.ts` + renderer instance/loop/input-panel — `InstanceWaitReason`,
  diagnostics drawer, hold-reason, countdown, single "Recover session" action.

---

## 10. Open questions for James

1. **Claude in-band interrupt.** Adopt the stream-json `control_request` interrupt (consistent with
   the API-key-first billing decision)? Pin to the SDK control schema, or verify from a captured raw
   `--output-format stream-json --verbose` session first? Highest-leverage single fix for "interrupt
   doesn't take" on our most-used provider.
2. **Claude flush race.** Does a `kill -9`'d Claude leave a readable JSONL turn? Decide if partial
   capture is needed for Claude or just nice-to-have.
3. **Codex: commit to app-server, shrink exec.** Treat exec as a true last resort (retry app-server
   harder, surface degradation loudly) rather than a silent fallback?
4. **Codex fork cursor sharing.** Confirm forked instances don't share one threadId (codex resume
   precedence rejects resuming a running thread; verify Harness fork path honors it).
5. **Config fingerprint contents.** Exactly which fields (model, mcp-config hash, auth provider, cwd)
   belong in §6.2's fingerprint?
6. **Remote RPC bounds vs long agentic turns.** Prefer heartbeat-deadline over a flat timeout (§4.E).
7. **Restore architecture.** Is a materialized, cursor-paginated restore index worth the build, or do
   paged Codex resume + a bounded `initAsync` get us "fast enough" for now?
8. **Decoupled run (Phase 6 longer-term).** Invest in the opencode-style decoupled run loop now as a
   parallel milestone, or treat Phases 0–5 as sufficient this cycle?
9. **Backstop poll interval.** Once recovery is event-driven, keep 60s or shorten?

---

*End of master plan. Implement Phase 0 + Phase 1 first; each item is independently shippable and
testable with the scripted adapter, and de-risks the rest.*
