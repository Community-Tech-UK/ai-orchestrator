# ADR: Integrating `/goal` by aliasing into Loop Mode

**Status:** Implemented
**Date:** 2026-06-27
**Deciders:** James (owner), loop/orchestration maintainers

## Implementation Reconciliation (2026-07-01)

The architectural decision has shipped in its core form: `/goal` is a built-in
orchestrator command (`src/shared/types/command.types.ts`) that routes through
`src/main/commands/goal-loop-command.ts` and `command-handlers.ts` into Loop
Mode rather than forwarding slash text to the provider. It supports objective
start plus `status`, `pause`, `resume`, and `clear`.

The two non-negotiable rollout fixes are also present:

- Fresh-eyes infrastructure failures no longer silently pass the completion
  gate; `evidence-resolver.ts` and `loop-coordinator-completion-gates.ts` fail
  closed to operator review.
- Loop run/checkpoint persistence is atomic for state and iteration snapshots,
  with pre-iteration idempotency markers on `LoopState.inFlightIteration`.

The remaining reliability follow-up has now shipped. Verify failures carry a
`verifyFailureKind` (`command`, `timeout`, or `infra`) through detector results,
iteration state, persistence, contracts, and the loop UI. Completion rejection
messages distinguish verifier infrastructure faults from real red commands, and
the anti-flake full-verify rerun now confirms failed runs as well as passing
runs.

## Context

Both Claude Code (`/goal`, built-in since CLI v2.1.139) and OpenAI Codex (`/goal`,
behind the `features.goals` flag) ship a slash command that sets a persistent
objective and lets the agent loop autonomously across turns until a checker
decides the stopping condition is met. We were asked whether we should "pass
`/goal` through" to the underlying CLIs from the orchestrator.

Two facts from the codebase shape the decision.

We do not drive either CLI interactively. The Claude adapter spawns
`claude --print --output-format stream-json --input-format stream-json`, and the
adapter's own validated comment (`claude-cli-adapter.ts` ~248-251) states that in
this mode slash commands are not intercepted by the CLI; they reach the model as
plain user text. The same is noted for `/fast` and compaction. Codex we drive over
the app-server JSON-RPC protocol with structured turns, where the prompt is message
content. So a literal `/goal ...` sent through either path is inert: Claude reads the
string as a user message, Codex treats it as content. Neither activates the native
goal loop.

We already are a goal loop. Loop Mode (`loop-coordinator.ts`, `loop-stage-machine.ts`,
`loop-completion-detector.ts`, and the completion-gates / cross-model-review modules)
owns exactly this responsibility: it drives the CLI across iterations toward a goal,
classifies goal intent (`loop-intent.ts`), detects completion, runs cross-model
fresh-eyes review, and enforces iteration and cost caps. It is also cross-CLI, which
the native commands are not (Gemini and Copilot have no `/goal`).

There is also a billing constraint. Reaching the native `/goal` loop means running the
CLI in its interactive session, and we previously ruled PTY-driving interactive Claude
impermissible. So the native loop is off the table on more than technical grounds.

Constraint going in: Loop Mode is the right home architecturally, but it is currently
flaky. A deep dive (2026-06-27) found the failure modes cluster, and most fail closed
(the loop refuses to stop, which is annoying but safe). A few fail open or lose work,
and those are the real risk surface this decision has to account for.

### Loop Mode flakiness summary (evidence for the decision)

- **Fresh-eyes review fails open on verify-gated loops.** A reviewer that throws or
  returns unparseable JSON resolves to non-blocking when a verify command passed
  (`loop-coordinator-completion-gates.ts` ~217-228, `evidence-resolver.ts` ~304). The
  semantic "is this really done" check silently disappears and the loop completes on
  verify alone. The same fault on a no-verify loop correctly pauses for a human.
- **Persistence is non-atomic.** `upsertRun` and `upsertCheckpoint` are two separate
  writes with no transaction (`loop-handlers.ts` ~57-109); a crash between them lets the
  run row and the checkpoint blob disagree, so a loop can drop off the resume list or
  restore from a checkpoint whose run row is terminal.
- **In-flight work is lost on cancel or crash.** The iteration counter advances only
  after a turn is sealed, and `cancelLoop` force-terminates and drops the in-flight
  result (`loop-coordinator.ts` ~1706-1716). Files may already be edited and committed
  on disk with no iteration row and no idempotency key, so the next run re-runs that
  sequence.
- **Provider-limit auto-resume is volatile.** It is an in-memory `setTimeout`
  (`loop-provider-limit-handler.ts` ~184-196); an app restart during a rate-limit park
  loses the resume and the loop sits paused forever.
- **Verify cannot distinguish infra failure from test failure.** Spawn errors and
  timeouts all report `failed` and get fed back to the agent as "fix these errors."
  `runVerifyTwice` only de-flakes the pass-then-stop direction.
- **Review-driven and ping-pong modes depend on a free-text/regex/LLM clean-review
  classifier** (`loop-clean-review-classifier.ts`) that is false-positive and
  false-negative prone, and one misclassification zeroes the clean-streak. These two
  modes are the flakiest and can look like a hang.

## Decision

Expose `/goal <objective>` as an orchestrator command that configures and starts our
own Loop Mode. Do not pass it through to the CLIs' native goal loop.

Specifically, `/goal` maps to the classic signal-driven completion path with a verify
command required (falling back to operator-review when none is configured, which is the
existing behavior). That path is the most deterministic because its stop authority
requires an actual verify pass, so it sidesteps the flaky clean-review classifier that
poisons the review-driven and ping-pong modes. `/goal` becomes the narrow, reliable
front door to the subset of Loop Mode we trust.

Gate the rollout behind two non-negotiable correctness fixes (see Action Items): close
the fresh-eyes fail-open, and make iteration persistence atomic and idempotent. We do
not want `/goal` to be the feature that makes the fail-open bug easy to hit.

## Options Considered

### Option A: Pass `/goal` through to the native CLI command

| Dimension | Assessment |
|-----------|------------|
| Complexity | High (would require interactive/resident or codex goals-enabled invocation) |
| Cost | High, and reopens the interactive-Claude billing question |
| Scalability | Poor; only Claude and Codex have `/goal`, no cross-CLI story |
| Team familiarity | N/A, new surface we do not control |

**Pros:** Reuses a maintained upstream feature; nothing for us to build on the loop side.
**Cons:** Technically inert in how we invoke both CLIs today (reaches the model as plain
text); even if reached, it runs many turns inside one invocation and fights our turn
accounting, timeouts, interrupt/restore, cost tracking, and cross-model review; conflicts
with the interactive-Claude billing decision; no coverage for Gemini or Copilot.

### Option B: Alias `/goal` into Loop Mode, classic verify-gated path (recommended)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low-to-medium; maps to existing config, plus two prerequisite fixes |
| Cost | Bounded; reuses iteration/cost caps already in the coordinator |
| Scalability | Cross-CLI by construction; one `/goal` for every provider |
| Team familiarity | High; our own subsystem |

**Pros:** Works in headless/app-server invocation because it never relies on the CLI
interpreting the slash command; keeps full control (turns, cost, interrupt/restore,
cross-model review); consistent UX across all providers; gives us a clean reason to fix
the two highest-risk loop bugs.
**Cons:** Inherits Loop Mode's flakiness unless we fix it; the prerequisite fixes are
real work; we own the maintenance.

### Option C: Alias `/goal` into the review-driven or ping-pong completion mode

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Cost | Medium |
| Scalability | Cross-CLI |
| Team familiarity | High |

**Pros:** Review-driven mode matches the "keep going until clean" feel of native `/goal`
most closely.
**Cons:** Both modes sit directly on the flaky clean-review classifier; the streak reset
makes convergence non-monotonic, so the loop can oscillate near completion or appear to
hang. Wrong foundation for a headline command.

## Trade-off Analysis

The core trade-off is control versus reuse. Option A reuses upstream but is both inert
in our invocation model and in conflict with our architecture and billing posture, so
its apparent "free" benefit is illusory. Options B and C both keep control; the
difference between them is which completion engine we put behind the command. The
classic verify-gated path (B) trades a slightly less "autonomous-feeling" stop condition
for determinism: it stops on a real verify pass rather than on an LLM's free-text
self-assessment. For a command users will lean on to run unattended, determinism wins.
Choosing B also lets us defer the hardest reliability problem (the clean-review
classifier) rather than block `/goal` on it.

## Consequences

- **Easier:** one consistent `/goal` across Claude, Codex, Gemini, and Copilot; full
  observability and cost control; a forcing function to fix two correctness bugs that
  bite outside `/goal` too.
- **Harder:** we carry the maintenance and must keep the loop honest; `/goal` will feel
  slightly less "magical" than the native command because it stops on verify rather than
  on the agent's say-so.
- **To revisit:** the clean-review classifier (`loop-clean-review-classifier.ts`) if we
  later want `/goal` to support a no-verify "until clean" mode; the verify infra-vs-test
  failure distinction; whether to offer `/goal pause|resume|clear` sub-commands mirroring
  the native UX, mapped onto `pauseLoop`/`resumeLoop`/`cancelLoop`.

## Action Items

Prerequisites (correctness, non-negotiable before `/goal` ships):

1. [x] Close the fresh-eyes fail-open: a reviewer infrastructure error on a verify-gated
       loop should route to operator-review or surface, never silently stop
       (`loop-coordinator-completion-gates.ts`, `evidence-resolver.ts`). Smallest and
       highest-risk; do this first. Add a Vitest spec asserting reviewer-throw on a
       verify-gated loop does not resolve to `stop`.
2. [x] Make iteration persistence atomic and idempotent: wrap `upsertRun` +
       `upsertCheckpoint` in a single transaction, add a pre-iteration checkpoint, and
       attach an idempotency key so a cancel or crash mid-iteration does not drop
       committed work or blindly re-run it (`loop-handlers.ts`, `loop-coordinator.ts`,
       `loop-store.ts`). Add specs for crash-between-writes and cancel-mid-iteration.

`/goal` implementation:

3. [x] Parse `/goal <objective>` in the input panel and map it to a `LoopConfig`:
       `initialPrompt` = objective, intent via `detectLoopGoalIntent`, classic
       signal-driven completion with verify required (manual-review fallback when none).
4. [x] Enforce the native objective constraints we are mirroring: non-empty objective,
       reasonable length cap; for long objectives accept a file reference.
5. [x] Wire `/goal` (no args) to report current loop status, and decide whether to add
       `pause|resume|clear` sub-commands mapped to existing coordinator methods.
6. [x] Vitest specs for the parser and the config mapping, including intent
       classification and the verify-required / manual-review-fallback branch.

Recommended follow-ups (reliability, not blocking):

7. [x] Persist provider-limit resume-at and rehydrate the timer on boot.
       Implemented through durable one-time provider-limit resume automations plus
       resumable provider-limit checkpoints.
8. [x] Separate verify infra failure from test failure; apply the anti-flake double-run
       to fails as well as passes.
