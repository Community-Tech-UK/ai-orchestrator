# Resilient Threads & Sessions — Spec

Status: **Completed — implemented and verified 2026-07-17 (live checks deferred to the plan's `_livetest.md`)**
Author: Claude (build mode)
Date: 2026-07-17
Plan link: [`2026-07-17-resilient-threads-sessions_plan_completed.md`](./2026-07-17-resilient-threads-sessions_plan_completed.md)
Decision resolved: full structural fix (§2 items 1+2+3+4 folded into the resume-gate reshape;
item 5 as an isolated later phase; item 6 remains a research note).

As-built: §2 items 1–3 landed as plan Phases 1–2 (load-scaled three-way resume-health verdict,
retry-then-proceed recovery gate); item 4 as Phase 3 (`[SESSION DEGRADATION NOTICE]` appended
to every fresh-fallback continuity message, listing orchestration children); item 5 as Phase 4
(`reconcileChildrenAfterRestart` drops dead children, keeps live ones, records the event).
Item 6 remains an open research note (provider-session durability / never fresh-spawn while
in-process agents live). Full as-built detail is in the plan.

Trigger: James, showing a Claude session history preview on `~/work/12steps` where the
transcript read "Session restarted automatically (resume failed)" **twice**, then
"I lost the live thread on resume — the background screenshot agents' state didn't
survive." Ask: "We need more resilient threads/sessions please."

---

## 1. What actually happened (verified diagnosis)

The resume ladder, when a running session looks unhealthy or a turn is interrupted, is:

1. **Native resume** — respawn the CLI and reconnect to its own provider session
   (Claude/Codex session file), keeping everything the provider held internally.
2. **Health gate** — `waitForResumeHealth` waits up to **5 s** for proof the resume
   took (`src/main/instance/lifecycle/runtime-readiness.ts:57`). If no proof arrives it
   returns `false`.
3. **Destructive fresh fallback** — if the gate returns false, the reconciler *throws*,
   terminates the resuming adapter, spawns a **brand-new** provider session, and injects a
   replay/handoff preamble reconstructing the conversation
   (`src/main/instance/lifecycle/runtime-reconciler.ts:510-587`). This is the path that
   emits "Session restarted automatically (resume failed)"
   (`interrupt-respawn-handler.ts:909`, `:1200`).

Two distinct things broke in the screenshot, and they need different fixes:

**A. The health gate is too eager, so recoverable sessions get destroyed.**
The 5 s window is fixed. Under host load (see memory: loadavg 290 killed healthy Codex
sessions via calm-weather watchdog timeouts) a session that *would* have resumed fine
just doesn't emit proof within 5 s → gate returns false → destructive fallback. "Resume
failed" here often means "resume was slow," not "session is corrupt." Seeing it **twice
in a row** is the tell: a genuinely dead session doesn't get two restarts; a transient
one gets repeatedly torn down. The `RespawnCircuitBreaker`
(`src/main/instance/lifecycle/respawn-circuit-breaker.ts`) throttles the cadence but does
not distinguish "session unrecoverable" from "host was briefly busy."

**B. Anything living inside the old provider process is gone the instant we fresh-spawn.**
The screenshot's "background screenshot agents" are **Claude Code's own in-process
subagents**, not AIO orchestration children. When AIO spawns a fresh `claude` process,
those in-process agents cannot be revived by AIO — they only survive if we reconnect to
the *same* provider session (native resume). This is why (A) matters so much: the fresh
fallback is what loses them. The replay preamble rebuilds the conversation text but has
**zero knowledge** of in-flight background work
(`src/main/session/fallback-history.ts`, `replay-continuity.ts` — no child/subagent refs).

**C. Separately: AIO orchestration children are orphaned across a restart.**
When an AIO *instance* spawns child AIO instances via the orchestration protocol, a
replay-fallback restart never calls `unregisterOrchestration`
(only termination does — `instance-termination.ts:126`). The restarted parent keeps stale
`childrenIds` (`orchestration-handler.ts:112-116`) but its new session has no
conversational memory of them → zombie children or silently-lost work. This is a real gap
but a *different layer* from the screenshot's symptom.

### What already exists (do not rebuild)

Recent, still-`_livetest` work already hardened parts of this ladder:

- `2026-07-17-rolling-handoff-state-plan` — rung-3 rolling-summary handoff document
  (fold-by-8, redaction) fed into the fallback preamble. **OFF by default.**
- `2026-07-17-interrupt-respawn` / `unexpected-exit` / `history-restore` reconciler
  migrations — unified the spawn→health→fallback→persist core in `RuntimeReconciler`.
- `2026-07-15-codex-resume-interruption-recovery` — Codex metadata-only resume +
  dangling-tool-call recovery.
- `2026-07-15-aio-review-resume-reliability` — review dedup + Codex MCP startup timeouts.

None of them address (A) the eager health gate, or (B)/(C) in-flight background/child
survival. Those are the open gaps.

---

## 2. Decisions for James (answer by number)

Grouped by how much they change. Each is independent — pick any subset.

**Make resume win more often before anything is thrown away (targets your exact symptom):**

1. **Give the resume health gate more patience under load.** Scale the 5 s window up when
   the host is busy (reuse the existing SystemLoadMonitor signal), and treat "process
   alive but quiet" as success rather than failure. Low risk, directly stops recoverable
   sessions being destroyed. — Wire it? (yes / no)

2. **Retry native resume once or twice before the destructive fresh fallback.** Today one
   slow resume → immediate fresh spawn. A single re-attempt catches transient stalls.
   Low–medium risk. — Wire it? (yes / no)

3. **Only fresh-fallback when the session is *proven* unrecoverable** (explicit
   session-not-found / corruption), not merely "no proof in time." On an unproven failure,
   surface "reconnecting…" and keep trying rather than nuking the thread. Medium risk
   (needs a clear "give up" bound). — Wire it? (yes / no)

**Don't silently lose background work when a fresh restart is unavoidable:**

4. **Tell the model what it was doing.** When a fresh fallback happens, add a short line to
   the continuity preamble listing the in-flight background tasks/subagents that were
   running, so the restarted session re-establishes them instead of guessing. Medium risk.
   — Wire it? (yes / no)

5. **Clean up / re-attach orphaned AIO orchestration children on restart** (gap C): on a
   replay-fallback, either re-adopt live children or terminate zombies, and record it.
   Medium risk, only affects instance-spawns-instance orchestration. — Wire it? (yes / no)

**Expectation-setting (not a code change unless you say so):**

6. **Claude/Codex *internal* subagents can't be revived by AIO once we fresh-spawn** — only
   native resume (decisions 1–3) preserves them. Do you want me to also investigate
   provider-session durability (e.g. never fresh-spawn Claude while it has live in-process
   agents, prefer parking/waiting instead)? — Investigate? (yes / no)

**Recommended default if you'd rather I just proceed:** 1 + 2 + 4 (highest value, lowest
risk, directly fixes the screenshot). 3 and 5 are the bigger, more valuable structural
wins; 6 is a research spike.

---

## 3. Notes

- (Historical) No implementation begins until §2 is answered; this file stays untracked.
- (Historical) Once decisions are set I'll write `..._plan.md`, rename this to
  `..._spec_planned.md`, and link them per the plan/spec lifecycle.
- Key files: `runtime-readiness.ts` (§gate), `runtime-reconciler.ts:510-587` (§ladder),
  `interrupt-respawn-handler.ts` (§orchestration), `orchestration-handler.ts` (§children),
  `fallback-history.ts` / `handoff-state-service.ts` (§preamble).
