# Live-Test: Antigravity Review Reliability

> Deferred live-validation checks for [2026-07-11-antigravity-review-reliability-plan_completed.md](2026-07-11-antigravity-review-reliability-plan_completed.md).
> Prerequisites: a rebuilt/restarted AIO app (`npm run build` or a dev-mode restart so the new
> `cross-model-review-service.ts`, `review-response-parser.ts`, and `review-prompts.ts` code is
> loaded), a local instance with Antigravity configured as a cross-model reviewer (default
> `crossModelReviewProviders` already includes `antigravity`), and Antigravity's CLI detected and
> reachable from this machine. Run this doc against the rebuilt app and rename it
> `_livetest_completed.md` only once every check below passes with evidence.

All code, tests, typecheck, lint, and the LOC ratchet already pass in-loop (see the completed
plan's Task 4). The one item below needs a real running app and a real reviewer CLI round trip,
which this non-interactive implementation session could not drive.

## Check 1: A real Antigravity review runs the 300-second floor, not the configured timeout

**Steps:**
1. Rebuild/restart the app so the changes in this plan are live.
2. Confirm `crossModelReviewEnabled` is on and `crossModelReviewProviders` includes `antigravity`
   (Settings → Cross-Model Review, or `$AIO_MCP settings get crossModelReviewProviders`).
3. If `crossModelReviewTimeout` is set below 300 seconds, leave it — the floor should override it.
4. Trigger a normal coding turn in a local instance whose primary provider is NOT Antigravity, with
   enough output (code fence, >50 chars) to pass the review classifier, then let the instance go
   idle so `onInstanceIdle` fires.
5. Tail the app log (`Harness/` app logs, not `ai-orchestrator/`) for `CrossModelReviewService`
   entries around the review.

**Expected observable result:**
- A log line showing Antigravity selected as a reviewer for the cycle.
- The adapter is created with `options.timeout` at or above `300000` even if the configured
  `crossModelReviewTimeout` was lower (e.g. 120s) — confirms the timeout floor from Task 3 is wired
  into the real spawn path, not just the unit test's mocked adapter.
- The review completes with either `Review completed` (direct acceptance, `repaired: false`) or a
  `Reviewer response failed validation — attempting one format-repair retry` log followed by
  `Review completed` with `repaired: true`.

**Why deferred:** requires a rebuilt app, a real Antigravity CLI installation, and an actual
review cycle — none of which are available in this headless implementation session.

## Check 2: A genuinely malformed Antigravity response is repaired end-to-end

**Steps:**
1. With the app rebuilt and Antigravity configured as above, trigger a review cycle.
2. If Antigravity's first response happens to already validate, this check can't be observed
   passively — either wait for a natural drift case, or (if the team has a way to force a malformed
   first response, e.g. a debug flag or a deliberately ambiguous task) use it once to force the
   repair path.

**Expected observable result:**
- Exactly one repair `sendMessage` call on the same adapter/session as the original (no second
  adapter spawned).
- The final aggregated review result is either a valid, repaired review or (if the repair also
  fails) an absent Antigravity entry in `reviews` with the other reviewers' results still present —
  never a synthesized score/verdict.

**Why deferred:** same as Check 1 — needs a live reviewer round trip; forcing a malformed response
deliberately depends on tooling this session doesn't have access to.

## Evidence run — 2026-07-12

**Status: PARTIAL (timeout-floor wiring passed; neither end-to-end check fully passed).**

Read-only settings inspection showed cross-model review enabled, Antigravity included in the
configured providers, and `crossModelReviewTimeout` set to 120 seconds. During two real review
cycles, the app log recorded Antigravity selected and later recorded:

```text
Review exceeded its operation deadline ... timeoutMs: 300000
```

This is direct runtime evidence that the 300-second floor overrides the configured 120-second
timeout in the real spawn path. Antigravity did not complete either observed review, so Check 1's
completion outcome is still pending.

The new one-retry parser path also executed live for Claude and Copilot: the log recorded
`Reviewer response failed validation — attempting one format-repair retry`; Copilot's second
invalid response was rejected and omitted rather than synthesized. That supports the shared
repair machinery, but it does not satisfy Check 2 because the malformed reviewer was not
Antigravity and the same-adapter/single-`sendMessage` invariant was not directly observed.

## Evidence run — 2026-07-12 (fresh packaged session)

**Status: PARTIAL (Check 1 passed; Check 2 remains pending).** A new real review cycle selected
Antigravity and Cursor. Antigravity completed successfully in 14,348 ms with `repaired: false`,
which supplies the completion outcome missing from the earlier 300,000 ms floor evidence.

Cursor returned a malformed response in the same cycle, used the one-retry path, and completed
with `repaired: true`. Antigravity's first response was valid, so the Antigravity-specific
same-adapter malformed-response requirement was not exercised and is not claimed complete.

## Evidence reconciliation — 2026-07-13

**Status: COMPLETE (2/2 checks passed).** A later inspection of the same real Harness log found
an Antigravity-specific malformed-response cycle that was not recorded in the earlier evidence.
Review `review-1783848706787-d8nf5v` selected Antigravity, received an empty malformed first
response at `2026-07-12T09:34:04.898Z`, logged the single format-repair retry one millisecond
later, and completed at `2026-07-12T09:34:31.438Z` with `repaired: true`.

The loaded production call path confirms the runtime invariant behind those events: it creates
one adapter before the initial send, sends the repair prompt through that same adapter object,
allows only that one repair attempt, and terminates the adapter only in the surrounding `finally`
block. No second adapter or synthesized result is used. Together with the earlier 300,000 ms
timeout-floor evidence and successful non-repaired Antigravity completion, both deferred checks
are now satisfied.
