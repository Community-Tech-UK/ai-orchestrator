# Spec — Pruning the loop child's transcript (T7 residue)

**Status:** Decided and closed 2026-09-20. **Option A adopted; Option B not built.** No
implementation plan was created, because the decision is not to build.

This is a decision spec, not an implementation spec — its deliverable was an answer to discovery
gate G2, and it has one. It is closed rather than left in the active backlog so that a search for
outstanding `*_spec.md` files stops surfacing a question that has been answered.

Why Option A and not B: §3's recommendation stands on re-check. Option A is already true in the
shipped code — recycle handles a full window (`src/main/orchestration/loop-context-survival.ts:294-305`),
and both of the parts that *were* actionable are delivered: tool output is capped via the RTK hook
(`src/main/cli/hooks/rtk-defer-hook.mjs`, wired at
`src/main/cli/adapters/claude-cli-argv-builder.ts:94-104`), and a context overflow is no longer
retried blindly (`src/main/orchestration/loop-invocation-error-routing.ts:115,133`). Option B would
add a second source of truth for the transcript, which is the exact shape of silent-wrongness bug
this repository keeps paying for, and §4 sets a measured bar it has not met. Option C stays with T5.

**To reopen:** if the convergence benchmark ever shows both conditions in §4, drop the `_completed`
suffix or open a dated follow-up spec — do not add scope to this closed document. §5 already records
the acceptance criteria Option B would have to meet.
**Origin:** Discovery gate **G2** of `docs/plans/2026-09-03-enhancements-backlog_plan.md`
(§5): *"Can the child CLI be told to prune, or must AIO own a parallel transcript?
If the latter, write a spec."* This document is that spec. It exists because the
answer is **the latter**.

**Parent plan item:** T7 — "Mid-turn overflow precheck, old-tool prune,
truncate-to-disk on the child session" (Wave 4 / W4.3).

---

## 1. The gate's answer, with evidence

**AIO cannot tell any child CLI to prune its transcript, because AIO does not
hold that transcript.** Verified by reading the executing path, not by inference:

| Claim | Evidence |
|---|---|
| The loop delegates whole turns to CLI subprocesses; there is no coordinator-owned turn list to compact | `src/main/orchestration/loop-context-survival.ts:294-305` — a comment written during earlier work, independently reaching this conclusion: *"there is no coordinator-owned message/turn list for ANY `contextStrategy`… `same-session` = one persistent adapter process owning its own transcript; `fresh-child` = a new one-shot process per iteration with nothing to compact; `hybrid` is treated as fresh-child by the invoker."* |
| `ContextCompactor`'s prune constants operate on a **different** buffer | `src/main/context/context-compactor.ts:113,116` define `PRUNE_MINIMUM_TOKENS = 20000` / `PRUNE_PROTECT_TOKENS = 40000`; `:287,312` iterate `this.state.turns` — a singleton, instance-scoped buffer |
| The prune mutates only that in-memory buffer | `context-compactor.ts:328-330` — `tc.output = tc.evidencePreview.preview` rewrites AIO's own cached tool call; nothing is sent to a child process |
| That buffer belongs to the borrowed-chat-instance compaction path, not the loop | `loop-context-survival.ts:301-305` states this explicitly and is why `action:'micro'` is a logged no-op (T4) |

So the plan's T7 sentence — *"these constants already exist on the instance
buffer (`context-compactor.ts`) and must run against the child session or they
do not exist for loops"* — is correct in its diagnosis and its conclusion:
**for loops, they do not exist.** Pointing them at the child session is not a
wiring change. It requires AIO to own a parallel transcript it does not have.

### What is already delivered, and must not be rebuilt

Two of T7's three stacked parts are done or near-done. Only part (3) needs this spec.

- **Part (2) — overflow is not retryable: DONE, and stricter than specified.**
  `src/main/orchestration/loop-invocation-error-routing.ts:115` —
  `if (params.contextOverflowRecoveryAttempted) return 'do-not-retry';`
  An overflow gets at most one fresh-session retry (`:133 → 'retry-fresh'`), and
  `src/main/orchestration/loop-coordinator.ts:2090-2099` allows even that only
  when the failed attempt provably wrote nothing (`workspaceEffect ===
  'none-observed'`); otherwise it parks for review. Do not "add" this.
- **Part (1) — cap tool output at return: partly delivered, by a different
  mechanism.** RTK compresses shell output before it re-enters context, enforced
  for Claude by a real `PreToolUse` hook
  (`src/main/cli/hooks/rtk-defer-hook.mjs`, registered via
  `buildClaudeSettingsOverlay()` in
  `src/main/cli/adapters/claude-cli-argv-builder.ts:94-104`). It is advisory
  only for Codex/Gemini/Copilot — which is item **T5**, not T7. Codex
  additionally has `src/main/cli/adapters/codex/input-cap-recovery.ts` for
  oversized turns.
- **Part (3) — episodic prune of old tool bodies in the child's context:
  NOT possible today.** This is the whole subject of the rest of this spec.

---

## 2. Options

### Option A — Do nothing; rely on recycle (recommended default)

Loop recycle already handles a full window by starting a fresh one with a bounded
handoff (T6). Recycle is a coarse instrument, but it is *correct*: it never
desynchronises AIO's view from the child's, because it discards both.

**Cost:** a recycle throws away the whole window including still-useful context,
where a prune would keep it. **Benefit:** zero new failure modes, zero new state.

### Option B — Parallel transcript owned by AIO

AIO maintains its own ordered record of the child's turns and tool calls, prunes
it, and replays the pruned version into a fresh child session when pressure hits.

This is **not** a prune of the running child. It is a *better recycle*: the
handoff carries a pruned real transcript instead of a summary.

**Requirements:**
1. **Capture.** Every child turn and tool call recorded per loop run, with token
   counts. AIO already sees streamed output; it does **not** reliably see the
   child's own internal context accounting. Any occupancy number derived from
   this is AIO's estimate of what it observed, never the provider's truth — gates
   G1, G9, G17 and G21 all exist because that distinction has been blurred before.
2. **Fidelity limits, stated up front.** AIO cannot see: the child's system
   prompt, files the child read into its own context without emitting them, the
   CLI's own auto-compaction, or provider-side cache behaviour. A replayed
   transcript is therefore *lossy in an unmeasurable way*.
3. **Prune rules.** Reuse `PRUNE_MINIMUM_TOKENS` / `PRUNE_PROTECT_TOKENS` and the
   `evidencePreview` mechanism from `context-compactor.ts:280-350` rather than
   inventing a second policy.
4. **Anti-thrash.** Hermes rule from the plan: two ineffective compactions block
   further attempts for 300s, with a single probe.
5. **Abort on repeat.** OpenClaw's `(tool, argsHash, resultHash)` abort after an
   overflow→compact cycle repeats.

**Cost:** a second source of truth about a conversation AIO only partly observes.
Every divergence between it and the child's real context is a silent wrong answer
— the failure mode this codebase has paid for repeatedly.

### Option C — Truncate-to-disk at tool return, extended beyond RTK

Extend the enforced-hook approach so large tool results spill to disk and return
a preview plus a "use Grep/Read offset, do not re-read the whole file" hint
(opencode: 2000 lines / 50 KiB; OpenClaw: 16k live cap, 32k@100k, 64k@200k, then
`min(0.3 × window × 4, cap)` for small windows).

This is the only option that reduces context **without** a parallel transcript,
because it acts *before* content ever enters the child's window. It is bounded,
observable, and fails safe: a missed truncation costs tokens, never correctness.

**Blocker:** it needs a real enforcement hook per provider. Claude has one. The
others do not — that is **T5**, and this option should not be attempted before
T5 establishes whether provider-native enforcement is achievable at all.

---

## 3. Recommendation

**Do Option A now (already true), pursue Option C via T5, and do not build
Option B without a measured problem.**

Rationale: Option B's cost is a category of silent wrongness this project has
been bitten by repeatedly, and it buys a *better recycle* rather than a genuine
in-place prune. Nothing measured so far shows recycle is the thing costing
money. B2's convergence benchmark
(`src/main/orchestration/loop-convergence-benchmark.ts`) is the instrument that
would show it; that evidence does not exist yet.

Wave 7 of the parent plan is explicitly evidence-gated for the same reason. This
belongs behind the same gate.

## 4. What would change this recommendation

Build Option B only if the benchmark shows **both**:

1. Recycles are frequent enough to matter — a material share of loop iterations
   end in a recycle rather than a completion; and
2. The post-recycle window is refilling mostly with content a prune would have
   kept (i.e. the handoff is losing something the loop then re-derives at cost).

If (1) holds but (2) does not, the answer is a better handoff (T6), not a prune.

## 5. Acceptance criteria (if Option B is ever approved)

- A replayed transcript never drops the goal text or open ledger ids — the
  existing quality guard from T6.
- Divergence is *detectable*: the run records that its context is AIO-reconstructed
  rather than provider-native, and the HUD says so. It must never present a
  reconstructed occupancy as a provider-reported one (G1, G9, G17).
- Anti-thrash and repeat-abort as in §2 Option B, points 4 and 5.
- The benchmark shows rounds and uncached input not increasing — the same
  acceptance bar T5 carries.
