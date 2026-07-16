# Context Cost Governor Architecture Spec

**Date:** 2026-07-14  
**Status:** Implemented and verified 2026-07-16; active and uncommitted  
**Implementation plan:** `docs/superpowers/plans/2026-07-14-context-cost-governor-plan_completed.md`  
**Scope:** Codex app-server turns only. Prompt payload reduction and graph retrieval are separate projects.

**As-built note:** The interrupt/compact/continue orchestration described below is implemented via
the provider-neutral `ContextSafetyPolicy` + `ProviderContextActionExecutor` architecture (built
later as part of the provider-agnostic-context-evidence work) rather than an adapter-internal
decision loop. See the plan's As-Built section for exact file:line citations. All guarantees
described here (proof-gated compaction, epoch-scoped recovery, retryable pause, fixed-instruction
same-thread continuation) hold under the actual implementation.

## Problem

The 2026-07-13 incident reached 18,910,442 cumulative tokens in one Codex turn while the current context window rose to 242,865 of 258,400 tokens. Roughly 98% of the cumulative input was cached input. The current runtime reports both occupancy and cumulative spend, but it does not enforce a per-turn cost ceiling:

- generic occupancy compaction is suppressed for self-managed Codex app-server sessions;
- the generic cumulative-token trigger is disabled by default and starts compaction without first stopping the active turn;
- `thread/compact/start` acknowledgement is currently treated as success even though completion is only proven by `thread/compacted`;
- outside an active turn, there is no adapter notification handler to release the existing compaction gate;
- no runtime path automatically continues an interrupted task after confirmed compaction.

The result is that a healthy-looking agentic turn can repeatedly pay for a nearly full cached context until the user interrupts it or provider limits intervene.

## Goals

1. Bound cumulative token spend within a Codex app-server turn relative to that model's reported context window.
2. Interrupt only at a provider usage-notification boundary, where the preceding model request has completed.
3. Require proof that the interrupted turn stopped before requesting compaction.
4. Require a matching `thread/compacted` notification before treating compaction as successful.
5. Continue the task on the same native thread with an explicit continuation instruction.
6. Fail closed: if interrupt or compaction cannot be proved, leave the instance idle and visibly paused rather than replaying work or opening a context-empty thread.
7. Keep diagnostics observational and retain a kill switch in adapter configuration.

## Non-goals

- Reducing fixed system-prompt, MCP, skill, or plugin payloads.
- Adding graph edges or changing Codemem retrieval.
- Applying mid-turn recovery to exec-mode Codex, Claude, Gemini, or Copilot.
- Claiming the historical incident's exact per-request payload composition before the pending controlled live test runs.
- Reopening a fresh Codex thread automatically when cost recovery fails. A fresh thread loses transcript state and is not a safe continuation proof.

## Decision Model

`CodexTurnCostGovernor` is a pure, unit-tested state machine. It observes provider-reported cumulative tokens and context-window size and measures spend since the last observed compaction.

Default thresholds:

| Spend since observed compaction | Decision |
| --- | --- |
| below 2x context window | continue |
| 2x to below 4x | emit one warning for the current compaction epoch |
| 4x to below 8x | request controlled recovery once for the epoch |
| 8x or more | request urgent controlled recovery once for the epoch |

The first valid usage observation uses a zero baseline. This deliberately compacts a resumed thread that is already far beyond the ceiling. A lower cumulative counter than the baseline is treated as a provider reset and starts a new epoch.

The governor resets its baseline only after an observed compaction notification. RPC acceptance never resets it.

## Runtime Flow

```text
thread/tokenUsage/updated
  -> governor decision at completed model-request boundary
  -> emit warning, or arm recovery
  -> turn/interrupt
  -> await turn/completed(status=interrupted)
  -> thread/compact/start
  -> await thread/compacted (bounded)
  -> reset governor epoch and cached occupancy
  -> turn/start("continue from the interrupted task...")
```

If the turn completes normally while the interrupt is racing, recovery is cancelled and the completed result is retained. If interrupt acknowledgement is rejected/unknown, or compaction is unavailable/unobserved, the adapter emits a visible pause message and returns to an idle, retryable state. It does not send the original user message again.

At most three automatic recoveries may occur inside one outer `sendInput` call. Reaching that bound pauses the task to prevent an interrupt/compact/continue loop.

## Compaction Proof

`CompactionGate.wait()` returns `observed` or `timed-out`. The adapter registers the wait before sending `thread/compact/start`, preventing a fast notification from racing the waiter. `compactContext()` returns `true` only after `thread/compacted` is observed.

The app-server client keeps a lightweight idle notification handler installed whenever no turn capture handler is active. It handles `thread/compacted` so explicit compaction can be proved after an interrupted turn. Active turn capture continues to own normal notification routing.

The existing per-turn input-cap recovery also adopts observed-compaction semantics. If compaction is acknowledged but not observed, it must not retry against the possibly unchanged thread.

## User-visible Behaviour

- At the warning threshold, one system message explains that the turn has crossed the soft cost budget.
- On recovery, one system message reports that the expensive turn was interrupted and safely compacted before continuing.
- On failed proof, an error explains that automatic recovery paused and the conversation was preserved.
- A successful continuation produces the only final assistant response for that outer send. Partial tool/output events already emitted before the interrupt remain in the transcript as execution evidence.

## Safety and Compatibility

- Enabled by default for Codex app-server mode; `CodexCliConfig.contextCostGovernorEnabled = false` is the programmatic kill switch.
- No change in Codex exec mode.
- No fresh-thread fallback in this governor.
- Recovery is single-flight per adapter and decision epoch.
- Existing runtime capability reporting remains unchanged.
- Generic `CompactionCoordinator` benefits from the stricter `compactContext()` result without owning the mid-turn continuation loop.

## Verification

Unit tests cover threshold normalization, one-shot decisions, compaction resets, counter resets, gate outcomes, idle notification routing, successful recovery ordering, normal-completion races, unobserved compaction pauses, and the three-recovery ceiling. Adapter integration tests prove no original-message replay and exactly one continuation prompt.

A rebuilt-app live test must then confirm the real Codex app-server emits `thread/compacted` for explicit compaction and that a controlled high-cost task resumes without duplicate edits.
