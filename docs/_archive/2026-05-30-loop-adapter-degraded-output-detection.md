# Loop — Adapter-Layer Degraded / Batched / Synthetic Tool-Output Detection

**Status:** Open (deferred follow-up). Untracked until implemented; rename `_completed` on completion per repo convention.
**Date:** 2026-05-30
**Owner:** TBD
**Related:**
- `docs/plans/2026-05-29-loop-intelligence-improvements-plan_completed.md` (context discipline / progress signal — sibling, not overlapping)
- `loopfixex_completed.md` (block-sanity gate + degraded-iteration retry — the *backstops* this plan completes)
- MEMORY: "Verify reads in replay fallback — degraded harness can return synthetic file reads"

---

## Why this exists

This is the genuinely-deferred piece from the 2026-05-30 degraded-harness incident. Two
backstops already shipped in `loop-coordinator.ts` (block-sanity gate + degraded-iteration
retry), but they are **coordinator-level** mitigations. They stop a hallucinated block from
halting a healthy loop and retry *void* iterations — they do **not** detect the underlying
failure, because the failure happens **inside the child CLI adapter** and is invisible from
the orchestrator.

Right now this gap is recorded **only** as two inline comments in modified, uncommitted code:

- `src/main/orchestration/loop-coordinator.ts:2046` — *"Follow-up (out of scope here):
  adapter-layer empty/batched tool-output detection + retry belongs in the CLI adapter path,
  not coordinator logic."*
- `src/main/orchestration/loop-coordinator.ts:2224` — `classifyDegradedIteration` docstring
  NOTE: *"a child whose internal tools returned empty/batched/synthetic results is NOT
  detectable here."*

Comments are not a backlog. This doc is the actionable capture.

---

## The failure mode (what actually happened)

A per-iteration CLI harness entered a degraded mode with three compounding symptoms, all
observed live during the incident:

1. **Delayed / batched tool delivery misread as empty.** Tool calls return nothing, then *all
   flush at once* much later. During the gap, `Bash`/`Read`/`Write` look dead, so the agent
   concludes "the toolchain is non-responsive."
2. **Synthetic / hallucinated file reads.** In degraded mode `Read` returns fabricated content
   (e.g. a "file does not exist" blob, or a stale/invented file body) before — or instead of —
   the real content. The agent then reasons against content that was never on disk.
3. **Parallel batch cancelled by one non-zero exit.** A chained command (e.g. `rm … && ls`)
   exits non-zero (file legitimately absent) and cancels the *entire* parallel batch, so
   legitimate sibling work silently vanishes — looking like more "empty output."

Net effect: degraded harness → false "toolchain dead" + fabricated "nothing exists on disk" →
agent files a `block` → a perfectly healthy loop halts on a hallucination.

---

## Why the coordinator cannot see it

By the time an iteration result reaches the coordinator (`loop:invoke-iteration` →
`default-invokers.ts` → `CliResponse`), a degraded iteration looks **identical to a healthy
one**:

- `response` is **full** — the child streams complete narration (false reasoning *and* its own
  self-correction), so "empty output" detection never fires.
- `toolCalls` is **non-empty** — the calls were *made*; it's their *results* that were
  empty/batched/synthetic, and those internal results never surface to the orchestrator.

So `classifyDegradedIteration` (coordinator) can only catch the *void* case (no output + no
files + no tool calls). The hallucinating-but-chatty case must be caught where the tool
results are actually produced and parsed: **the adapter streaming layer.**

---

## Candidate detection points (adapter layer)

All in `src/main/cli/adapters/`:

- **`base-cli-adapter.ts`**
  - `streamResponse()` (~`:432`) — where streamed chunks/events arrive.
  - `parseResponse()` / "Parse raw CLI output into a standardized response" (~`:437`).
  - `flushOutputBuffer()` (~`:779`) — the buffer flush boundary; a "long silence then a single
    bulk flush" is the batching signature and is observable *here* but not upstream.
  - `'complete'` event emission (~`:235`) and the `CliResponse.toolCalls` shape (~`:147`).
- Per-provider adapters that parse tool-result frames: `claude-cli-adapter.ts`,
  `codex-cli-adapter.ts`, `gemini-cli-adapter.ts`, `copilot-cli-adapter.ts`,
  `acp-cli-adapter.ts`.

The detector should live in the base adapter (shared signal extraction) with provider hooks
where the wire format differs.

---

## Proposed detection signals

Detect a *degraded streaming episode* (not just empty output) using signals available only at
the adapter boundary:

1. **Batch-flush timing.** A cluster of tool-result frames arriving within a very tight window
   after a long preceding silence (gap ≫ inter-frame delta). Configurable silence threshold +
   burst window.
2. **Empty-result ratio.** N consecutive tool calls (Bash/Read/Write) returning empty/zero-byte
   results within one iteration, above a configurable ratio/count.
3. **Cancelled-batch marker.** A parallel batch where ≥1 child non-zero exit collapses siblings
   to no-output. Detect the cancellation frame explicitly rather than treating siblings as
   "ran and produced nothing."
4. **(Best-effort) synthetic-read heuristic.** A `Read` result that the harness flags as
   replay/fallback/synthetic, or content that fails a cheap consistency check against a
   simultaneously-issued raw probe (e.g. byte length / first-line mismatch). This one is
   inherently heuristic — flag, do not hard-fail, and prefer to *re-issue the read* over
   guessing.

---

## Proposed behavior on detection

Mirror the coordinator's existing degraded-iteration-retry philosophy, one layer down:

- **Re-issue, don't trust.** On a detected degraded episode, transparently re-run the affected
  tool call(s) once (bounded) before surfacing results to the agent. Prefer single exit-0
  commands over parallel batches when re-issuing.
- **Signal upstream.** Annotate the `CliResponse` with a `degraded: { reason, signals }` flag
  so the coordinator's `classifyDegradedIteration` can treat the *whole iteration* as suspect
  and retry with a fresh session (the plumbing for that already exists from the retry work).
- **Never fabricate.** If a real result genuinely can't be obtained, return an explicit
  error/marker — never pass synthetic content through as if real.
- **Config-gated, default-on**, consistent with `LoopBlockSanityProbeConfig` /
  `LoopDegradedIterationRetryConfig`. New config likely on the adapter/CLI side, e.g.
  `degradedStreamDetection { enabled, silenceMs, burstWindowMs, maxEmptyRatio, reissue }`.

---

## Acceptance criteria

- [ ] A simulated batched-flush stream (long silence → bulk flush of empty results) is
      classified as degraded and the affected calls are re-issued (or the iteration flagged),
      instead of empty results reaching the agent as real.
- [ ] A cancelled parallel batch (one non-zero exit) is detected as cancellation, not as
      "siblings produced nothing."
- [ ] The `CliResponse` carries a `degraded` annotation the coordinator can act on; an
      integration test shows a flagged iteration triggers the existing fresh-session retry.
- [ ] Healthy streams are untouched — no added latency or false positives on normal iterations
      (guard against flagging legitimately-fast or legitimately-empty results).
- [ ] Synthetic-read heuristic, if implemented, only *flags/re-issues* — it never hard-fails a
      real read.
- [ ] `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, and the CLI
      adapter + loop-coordinator test suites are green.

---

## Risks / notes

- **False positives are the main hazard.** A legitimately fast batch or a legitimately empty
  `ls` must not be flagged. Keep thresholds conservative and config-tunable; prefer
  re-issue-once over hard failure so a false positive costs latency, not correctness.
- **Provider divergence.** Each CLI's wire format frames tool results differently; the batching
  signature may differ per provider. Start with the base-adapter signal and add provider hooks
  only where needed.
- **Synthetic-read detection is fundamentally heuristic** from outside the harness. Treat it as
  a best-effort flag, not a guarantee; the durable guarantee is "re-issue and cross-check
  load-bearing reads," matching existing MEMORY guidance.
- This completes the defense-in-depth started by the coordinator backstops: adapter detects &
  re-issues → coordinator retries the iteration → block-sanity gate refuses to halt on a
  hallucinated conclusion if anything slips through.
