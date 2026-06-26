# Bigchange: Steer / Interrupt Redesign — "Resident Session, Don't Respawn"

> Status: IMPLEMENTED + VERIFIED. Author pass: 2026-06-26. Completed pass: 2026-06-26.
>
> ## Implementation outcome (2026-06-26)
>
> The core redesign shipped and is the single, default behavior (no A/B, no flag gate):
> - **Resident Claude session**: instances drive Claude via `adapter.spawn()` +
>   `sendInputImpl()`, which holds stdin open across turns — the process is resident.
>   (`sendMessage()`'s one-shot `formatter.close()` path is only used by auto-title.)
> - **Resident interrupt**: `control_request{interrupt}` over the open stdin aborts the
>   turn without SIGINT/respawn; settles to `idle` via `handleInterruptCompletion` or
>   `noteInterruptSettled`. SIGINT→respawn remains only as the genuine `process-died`
>   fallback. (`claude-cli-adapter.ts` interrupt + control_response handler.)
> - **Steer control plane**: new `InstanceManager.steerInput()` + `INSTANCE_STEER_INPUT`
>   IPC (schema/preload/service/renderer). Steer = resident-interrupt-then-`sendInput`
>   over the same process; loud fallback to enqueue+interrupt on failure.
> - **On by default**: `residentClaudeSession` defaults `true` + `migrateResidentClaudeDefault()`
>   forces it on existing installs; `residentClaudeForSpawn()` forces it per-spawn.
> - **Codex app-server**: resident `turn/interrupt`, caps `{t,t,t}`.
> - **Capability descriptor**: `AdapterCapabilities` on base + Claude/Codex overrides.
>
> Verified: `tsc` (app/spec/electron), `ng lint`, ts-max-loc, full vitest suite
> (10,403 tests, 0 failures), incl. resident-interrupt control_request/control_response
> + EPIPE-fallback + main-process steer + "no double interrupt after Escape" coverage.
>
> Deliberately diverged from the section-3 names (functionally equivalent, kept simpler):
> the op queue is the `steerInput` control plane + `respawnPromise` ordering; `TurnAbortReason`
> is `lastTurnOutcome` + interrupt-boundary metadata; the old respawn path is retained on
> purpose as the fallback (not deleted per 2e).
>
> Deferred as out-of-scope follow-ups (do NOT add to this file — open a new spec):
> - **2d now/later steer affordance** for one-shot providers (Gemini/Copilot/Cursor) — a UX
>   feature needing a design decision; one-shot steer currently queues-at-boundary with loud
>   failure, which is safe.
> - **3.5 per-message `interrupted:true` marker** — redundant with the existing
>   interrupt-boundary rendering (`display-item-processor`) which already surfaces the
>   interruption; partial output is preserved either way.

---

## 1. Problem

When the user **steers** (sends a message while the agent is mid-turn), the session
sometimes dies silently — no error, input box flips to "Type to restart Claude and
continue…". Reproduced live on 2026-06-25.

### Root cause (verified)

Our steer path does **terminate + respawn** of the CLI process:

1. `steerInput()` enqueues the message and fires `requestInterruptForSteer()`
   → `INSTANCE_INTERRUPT` (`instance-messaging.store.ts:250-347`).
2. `interrupt-respawn-handler.ts:252-402` calls `adapter.interrupt()` → **SIGINT**
   (`base-cli-adapter.ts:344-365`), expects the process to exit, then
   `respawnAfterInterrupt()` (`:693-1089`) re-spawns with `--resume`, acquiring the
   per-instance `SessionMutex` (`:687`) and falling back to fresh-session + replay.
3. The queued steer message is only delivered **after** respawn settles to `idle`.
4. `sendInput()` blocks on `instance.respawnPromise` with a 30s timeout
   (`instance-communication.ts:575-613`).

Three confirmed silent-death paths in that chain:

- **`respawnPromise` never settles** → `sendInput()` blocks, the 30s force-abort timer
  misses (GC/event-loop stall), instance hangs in `respawning`, never returns to `idle`.
- **`SessionMutex` non-reentrant self-deadlock** (120s) — a lock holder calling
  `writeThroughIdentity()` instead of `writeThroughIdentityLocked()`. Known
  "steering session-killer." Currently the two sites are correct but unguarded.
- **Abort-swallow** — mid-respawn error paths `return` with no user-visible output.

**The deeper problem is architectural: we respawn the process to steer. No good
orchestrator does that.**

---

## 2. What the references do (verified by source read)

| Orchestrator | Interrupt | Steer (new msg mid-turn) | Session on interrupt | Drives subprocess? |
|---|---|---|---|---|
| **Codex** (gold) | `Op::Interrupt` via one bounded FIFO submission queue → `TurnAborted{reason}`; `cancellation_token.cancel()` + `task.handle.abort()` | **True mid-turn**: `steer_input()` pushes to `turn_state.pending_input`; turn loop drains it next iteration and records to history | Alive; `maybe_start_turn_for_pending_work()` | n/a (is the engine) |
| **t3code** | Claude SDK `query.interrupt()`; Codex `turn/interrupt` RPC | Prompt queue at turn boundary; graceful no-throw if session missing | Alive (status `interrupted`) | No — SDK/RPC |
| **opencode** | `AbortController` + `Fiber.interrupt()`; 2-press Esc (5s) | Two-tier queue (`queue` + editable `queued`); no mid-turn inject | Runner→`Idle`, same sessionID, history intact; `flushInterrupted()` marks partial parts `interrupted:true` | No — SDK |
| **ours today** | SIGINT **+ terminate + respawn `--resume`** | Enqueue, deliver after respawn | **Destroyed + recreated** ← the bug | Yes — PTY/pipe |

### The keystone finding (verified by reading the real Claude CLI)

`Actual Claude/cli/print.ts` proves the Claude CLI in `--print --input-format
stream-json` mode is a **resident, steerable server**, not a one-shot:

- Two parallel loops: stdin-reader → command queue, queue-drainer → generate
  (`print.ts:2807-2816`). **stdin stays open** (`for await … structuredInput`).
- `control_request {subtype:"interrupt"}` → `abortController.abort()` of the in-flight
  turn **without exiting**, replies `control_response: success` (`:2830-2849`).
- A new `{type:"user"}` message enqueued mid-turn is **steered**: a `now`-priority
  command triggers `abortController.abort('interrupt')`, then the drainer picks up the
  new input (`:1858-1863`). `later`-priority waits for the turn boundary.
- `end_session` (`:2850-2862`) is the **only** explicit exit.
- Interrupted turns are persisted and auto-resumed on the next run
  (`:1169-1184`, `interrupted_prompt` transform).

So **Claude already supports exactly the Codex steer model** — we just drive it as
one-shot (write one message → `formatter.close()` closes stdin → wait for process
exit → SIGINT + respawn to interrupt). This is the whole gap.

### Per-provider capability (verified from our adapters)

| Adapter | Spawn today | Resident-capable? | Live interrupt | Live steer |
|---|---|---|---|---|
| **Claude** | `spawn` pipe, stream-json **but stdin closed after 1 msg**, waits for exit | **YES** (stdin-open streaming) | `control_request interrupt` over stdin | new `user` msg over stdin |
| **Codex app-server** | persistent JSON-RPC, thread reused | **YES (already)** | `turn/interrupt` RPC | new `turn/start` on same thread |
| **Codex exec** | `codex exec` per msg | No | SIGINT | — (respawn) |
| **Gemini** | `spawn` per msg, prompt as argv, stateless | No (no session) | — | — (restart) |
| **Copilot** | `spawn` per msg, argv, `--resume` | No | — | — (respawn) |
| **Cursor** | `spawn` per msg, argv, `--resume` | No | SIGINT | — (respawn) |

Conclusion: **Claude + Codex(app-server) get true resident steer. The argv/one-shot
providers (Gemini/Copilot/Cursor/Codex-exec) physically cannot — they keep a
queue-at-boundary + respawn model, but made loud and safe.**

---

## 3. Target architecture

One uniform control plane (Codex's model), with per-adapter delivery that respects
capability. **Stop respawning to steer; respawn only when the process is genuinely dead.**

### 3.1 Adapter capability descriptor

Add to `base-cli-adapter.ts`:

```ts
interface AdapterCapabilities {
  residentSession: boolean;  // process survives across turns
  liveInterrupt: boolean;    // can abort a turn without killing the process
  liveSteer: boolean;        // can inject a user message into/after the live turn
}
```

- Claude (new streaming driver): `{true,true,true}`
- Codex app-server: `{true,true,true}`
- Codex exec / Gemini / Copilot / Cursor: `{false,false,false}`

The op queue + state machine are uniform; only the **delivery primitives**
(`deliverInput`, `deliverInterrupt`, `deliverSteer`) differ per adapter.

### 3.2 Per-instance ordered op queue (replaces scattered send/interrupt/respawn paths)

A single FIFO per instance, owned in the main process (Codex's `submission_loop`):

```ts
type InstanceOp =
  | { kind: 'input';     id; content; attachments }   // start/continue a turn
  | { kind: 'steer';     id; content; attachments }   // inject into the running turn
  | { kind: 'interrupt'; id; reason }                 // abort current turn, keep process
  | { kind: 'cancel';    id }                          // hard stop, no follow-up
```

A single drainer serializes them. This kills the current race between "queued steer
message" and "respawn settling" — there is no respawn, and ordering is explicit.

Lives near `instance-communication.ts`; replaces the implicit status-gated branching in
`instance-messaging.store.ts` (renderer keeps an optimistic mirror for the editable
queue UI, à la opencode).

### 3.3 Turn loop / delivery, by capability

**Resident (Claude streaming, Codex app-server):**
- `input` → if idle, deliver and mark turn running; if a turn is running, treat as `steer`.
- `steer` → deliver the user message to the live process:
  - Claude: write `{type:'user',…}` to stdin (priority `now` to abort+resteer, or `later`
    to wait for the boundary — expose as a UI choice "interrupt vs queue").
  - Codex app-server: `turn/interrupt` then `turn/start` on the same thread (or the
    pending-input equivalent if exposed).
- `interrupt` → Claude: stdin `control_request{interrupt}`; Codex: `turn/interrupt` RPC.
  **No SIGINT, no respawn.** Process stays resident.
- `cancel` → `interrupt` + do not enqueue follow-up.

**One-shot (Gemini/Copilot/Cursor/Codex-exec):**
- `input` → spawn, run to completion, capture session id.
- `steer` → enqueue behind current turn (opencode two-tier; editable/removable until it
  runs). Delivered as a fresh spawn at the next boundary.
- `interrupt` → SIGINT (+ respawn `--resume` only if a follow-up is queued). This is the
  ONLY place respawn survives, and it is now a deliberate fallback, not the steer default.

### 3.4 State machine

```
idle ──input──▶ running ──(turn end)──▶ idle
running ──steer(now)──▶ running'         (resident: abort+resteer, same process)
running ──steer(later)─▶ running (queued) ──(boundary)──▶ running'
running ──interrupt──▶ interrupting ──(ack)──▶ idle      (resident: process alive)
running ──interrupt──▶ interrupting ──(exit)──▶ respawning ──▶ idle|error  (one-shot only)
any ──process-died──▶ respawning ──▶ idle|error          (genuine fallback)
```

`TurnAbortReason` (Codex): `interrupted | replaced | steered | cancelled | process-died`,
surfaced to the UI and to continuity logic. No more "guess why the turn ended."

### 3.5 Partial output / continuity

- On interrupt, finalize streamed parts as `interrupted: true` and keep them in history
  (opencode `flushInterrupted`). Don't discard.
- Resident path needs **no `--resume`, no fingerprint check, no `SessionMutex` dance, no
  replay** — the session never died. This deletes the entire deadlock surface for the
  common path.
- One-shot fallback keeps the existing `writeThroughIdentityLocked` continuity, now
  reached far less often.

---

## 4. Migration plan (incremental, each step shippable)

**Phase 2a — Op queue skeleton + capability descriptor (no behavior change).**
Introduce `AdapterCapabilities` (all `false`) and the per-instance op queue, routing
today's send/interrupt through it. Pure refactor; existing respawn path untouched.
Verify: full steer/interrupt test suite still green.

**Phase 2b — Codex app-server through the resident path.**
Lowest risk because it is already resident. Route `interrupt`/`steer` to `turn/interrupt`
+ same-thread `turn/start`; stop respawning Codex on interrupt. Set Codex caps `{t,t,t}`.

**Phase 2c — Claude resident streaming driver (the big one).**
New driver mode for the Claude adapter: keep the process alive, hold stdin open, deliver
turns as `{type:'user'}` messages, interrupt via `control_request{interrupt}`, steer via a
`now`/`later` user message. Keep `end_session` for teardown. Capture `session_id` from the
init/stream for crash-fallback only. Set Claude caps `{t,t,t}`. Gate behind a setting
(`residentClaude`) for rollout; default off → on after soak.

**Phase 2d — One-shot providers: loud queue-at-boundary.**
Gemini/Copilot/Cursor/Codex-exec keep respawn-on-interrupt but: op-queue ordered, editable
queued UI, and every failure emits a visible system message (no silent "restart").

**Phase 2e — Delete dead respawn-on-steer code** once resident paths soak, leaving respawn
strictly for `process-died`.

---

## 5. Risks

- **Claude resident driver is a real rearchitecture** of the hottest adapter. Mitigate
  with the `residentClaude` flag + parallel-run the old path until soak passes.
- **Long-lived process leaks / zombies** — resident processes must be reaped on instance
  close and on `process-died`. Reuse the worker-zombie socket-close lessons.
- **stdin backpressure / interleaving** — the resident writer must serialize control vs
  user messages (the op queue gives this for free).
- **Per-provider divergence** — capability descriptor keeps the branching explicit and
  testable rather than scattered status checks.
- **SessionMutex** still guards the one-shot fallback; keep the Phase 1 reentrancy assert.

---

## 6. Test plan

- Unit: op-queue ordering (input/steer/interrupt/cancel), per-capability delivery.
- Resident Claude integration: spawn streaming CLI, send turn, mid-turn `interrupt`
  (assert process alive + `control_response success`), mid-turn `steer` now vs later
  (assert injection + history), `end_session` teardown.
- Codex app-server: `turn/interrupt` + same-thread continue, no respawn.
- One-shot: interrupt→respawn fallback emits visible message; queued-edit/remove.
- Regression: the exact 2026-06-25 repro (steer mid-turn) must not produce a dead session.
- Chaos: kill the resident process mid-turn → `process-died` → respawn fallback → visible.

---

## 7. File map (where work lands)

- `src/main/cli/adapters/base-cli-adapter.ts` — `AdapterCapabilities`, delivery hooks.
- `src/main/cli/adapters/claude-cli-adapter.ts` + `input-formatter.ts` — resident
  streaming driver (hold stdin open; `control_request` interrupt; user-msg steer).
- `src/main/cli/adapters/codex/…` — route interrupt/steer through `turn/interrupt`.
- `src/main/instance/instance-communication.ts` — per-instance op queue + drainer.
- `src/main/instance/lifecycle/interrupt-respawn-handler.ts` — shrink to `process-died`
  + one-shot fallback only.
- `src/renderer/app/core/state/instance/instance-messaging.store.ts` — editable queued
  UI, `now`/`later` steer choice, loud failure surface.
- `src/shared/types` — `TurnAbortReason`, op types, capability descriptor.

---

## 8. One-paragraph summary

Every good orchestrator aborts the **turn**, never the **process**; we abort the process
and respawn, which is the entire source of the silent steer-death. The Claude CLI and
Codex app-server both already support resident, steerable sessions (verified in source) —
Claude via stdin `control_request{interrupt}` + queued `user` messages, Codex via
`turn/interrupt`. The fix is to drive them resident through one per-instance ordered op
queue (Codex's model), keep partial output (opencode's flush), and demote respawn to a
genuine `process-died` fallback used only by the argv/one-shot providers that physically
cannot steer.
