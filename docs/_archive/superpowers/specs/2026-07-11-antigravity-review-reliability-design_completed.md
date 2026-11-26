# Antigravity Review Reliability Design

**Date:** 2026-07-11
**Status:** Implemented — see `docs/superpowers/plans/2026-07-11-antigravity-review-reliability-plan_completed.md`; live reviewer round-trip checks deferred to `docs/superpowers/plans/2026-07-11-antigravity-review-reliability-plan_livetest.md`
**Scope:** Automated cross-model review parsing and Antigravity review deadlines

## Problem

Production logging confirms that Antigravity is selected for automated reviews,
but many attempts do not contribute a result. Recent failures fall into two
classes:

1. Antigravity returns a substantively structured review whose tiered metadata
   differs slightly from AIO's strict JSON shape. The current prompt also says
   `critical` is a valid assumption severity while the schema rejects it.
2. The non-streaming `agy --print` process inherits the shared 120-second review
   timeout even though the Antigravity adapter's normal default is five minutes.

Plain-text refusals and responses without a usable review must remain failures.
Malformed output must never be interpreted as approval.

## Decision

Use three complementary controls:

- Make the canonical tiered JSON contract explicit and internally consistent.
- Normalize only a bounded set of recognizable, meaning-preserving JSON
  variants before validation, then make one format-repair request when the
  initial response remains invalid.
- Give Antigravity review operations a 300-second minimum deadline while
  retaining immediate cancellation and the user's longer timeout when set.

This is preferable to prompt-only enforcement because model formatting can
still drift, and preferable to permissive parsing because review gates must
remain fail-closed.

## Canonical Review Contract

The tiered prompt will include concrete examples for non-empty `assumptions`
and `integration_risks` arrays. Assumption severities are:

- `critical`
- `high`
- `medium`
- `low`

The runtime schema and shared `ReviewResult` type will use the same enum.
Required verdicts, dimension scores, reasoning, issues arrays, and summary stay
strict. The structured review contract is unchanged.

## Bounded Normalization

Normalization runs on extracted JSON before Zod validation. It may only perform
these transformations:

- Uppercase a recognized verdict, as today.
- Convert numeric score strings to integers and scalar issue values to arrays,
  as today.
- Convert a non-empty string assumption to an object with the same text and a
  conservative `medium` severity.
- For an assumption object, accept the text aliases `description`, `text`, or
  `issue` when `assumption` is absent.
- Normalize recognized assumption severity case to lowercase.
- Convert a recognizable integration-risk object containing `risk`,
  `description`, `text`, `issue`, or `summary` to that non-empty string.

Unknown shapes, missing required score dimensions, invalid verdicts, empty
content, and unrecognized severities still fail validation. Normalization never
creates an `APPROVE` verdict or changes scores.

## One Repair Attempt

If the initial reviewer response cannot be extracted or validated, orchestration
may send one follow-up message through the same adapter. The repair prompt:

- Includes the canonical JSON contract and the invalid response as untrusted
  data.
- Asks only for reformatting, not a new review or changed conclusions.
- Forbids adding facts, changing scores, or changing the verdict.
- Requires JSON only.

The repaired response goes through the same extraction, bounded normalization,
and strict validation. If it still fails, the reviewer result is discarded and
fallback selection proceeds. A refusal is not converted into approval; if it
does not contain recoverable review content, repair remains invalid.

The repair attempt shares the adapter's existing operation deadline. It does
not receive an additional five-minute budget.

## Timeout Policy

`CrossModelReviewService` will resolve reviewer deadlines as follows:

- Antigravity: `max(configured review timeout, 300 seconds)`.
- Codex: retain its existing 300-second minimum.
- Other providers: retain the configured timeout.

The five-minute minimum applies only to automated review adapters. Ordinary
Antigravity sessions keep their existing configuration behavior. Abort signals,
pause handling, shutdown, and explicit review cancellation still interrupt and
terminate the process immediately.

## Logging

Per review attempt, logs will distinguish:

- Initial parse failure.
- Repair attempted.
- Repair accepted or rejected.
- Final reviewer success, including provider, review ID, duration, and whether
  repair was used.
- Deadline failure with the configured effective timeout.

Logs must not include full review output or repository content. Existing bounded
response previews remain limited to parse diagnostics.

## Testing

Tests will prove:

- The prompt, runtime schema, and shared type agree on `critical` severity.
- Known assumption and integration-risk variants normalize successfully.
- Unknown shapes and invalid verdicts still fail closed.
- A failed initial parse followed by valid repaired JSON yields one accepted
  result.
- Two invalid responses yield no result and trigger normal fallback behavior.
- Repair does not receive a second independent deadline.
- Antigravity receives a 300-second review minimum when settings specify 120
  seconds, preserves a larger configured timeout, and remains abortable.
- Other provider timeout behavior is unchanged.

Targeted tests run first. Final verification uses the repository's canonical
TypeScript, lint, LOC, and quiet-test gates.

## Non-Goals

- Accepting arbitrary JSON shapes.
- Synthesizing scores, reasoning, summaries, or verdicts.
- Retrying provider execution after timeouts.
- Extending ordinary Antigravity chat deadlines.
- Treating refusals or empty output as clean reviews.
