# Regular-session announce-then-halt guard specification

Status: complete

Implementation plan: [2026-09-04-regular-session-announce-then-halt-guard_plan_completed.md](../plans/2026-09-04-regular-session-announce-then-halt-guard_plan_completed.md)

## Problem

A top-level orchestrated session can return a normal provider completion whose final sentence promises an immediate next action, such as running the full test suite, without starting that action. The process remains healthy and the session becomes idle, so crash recovery, stuck-process detection, and background-work continuation do not apply. The transcript then appears to have died until the user manually sends `continue`.

## Evidence

The 2026-09-04 incident completed normally at 16:04:25 BST with `stop_reason=end_turn` after the sentence “I'll run the full suite and send Wave 3 back for a second gate pass.” No tool or background-work event followed. The same live session accepted the user's manual `continue` at 16:23:27 and then performed the promised work.

## Required behaviour

1. Detect a high-confidence, first-person future action in the trailing portion of a completed assistant reply.
2. Apply only to root `orchestrated` instances. Do not affect interactive terminals, child agents, Loop Mode's separate guard, degraded completions, provider-limit waits, or sessions with real background work pending.
3. Wait for the instance to settle, then send one automatic continuation through the normal `InstanceManager.sendInput` path with `autoContinuation: true`.
4. Suppress delivery if a newer turn starts, the instance becomes unavailable, the application is paused, or the existing context-budget gate refuses the continuation.
5. Allow at most one recovery nudge per user turn chain. A later manual user turn starts a fresh chain.
6. Keep detection and lifecycle coordination provider-neutral and directly unit-testable.

## Non-goals

- Recovering a dead provider process; existing runtime-loss and respawn paths own that case.
- Continuing conditional promises that explicitly depend on user approval or information.
- Replacing provider-native background-task continuation.

## Acceptance criteria

- The incident sentence schedules exactly one continuation after settlement.
- Newer user input, active background work, interactive/child sessions, conditional user-dependent language, degraded output, and a repeated promise after the automatic nudge do not schedule another continuation.
- Existing Loop Mode announce-then-halt behaviour remains green.
- Canonical project verification passes.

## As-built and verification

- A provider-neutral regular-session coordinator now detects only high-confidence trailing immediate commitments and sends one guarded continuation through the normal input path.
- Eligibility and delivery fail closed for stale or untyped completions, newer manual turns, child/interactive/degraded/waiting sessions, active Loop ownership, pause, provider-native background work, context-budget refusal, explicit dependencies, deferral, uncertainty, meta/example prose, blockers, and already-completed results.
- Provider-dispatch eligibility and context-continuity state are transactional, so a cancelled automatic send cannot mutate request/history/snapshot/tool/last-sent state before the adapter call.
- Both TypeScript checks, lint, LOC ratchet, main/preload build, 255 focused tests, and the full 1,944-file/21,341-test suite pass. Six frozen detector corpora pass 273/273, and the final independent completion gate returned `VERDICT: PASS` with zero actionable findings.
- Rebuilt-app interaction is intentionally pending in [the live-test document](../plans/2026-09-04-regular-session-announce-then-halt-guard_livetest.md). The code and agent-runnable verification are complete; no deferred check is represented as already verified.
