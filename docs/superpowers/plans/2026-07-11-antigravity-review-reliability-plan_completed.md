# Antigravity Review Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Antigravity automated reviews survive known harmless JSON-shape drift and the observed 120-second cutoff without weakening fail-closed review validation.

**Architecture:** Keep the canonical contract in the prompt and Zod schema, bounded provider-neutral normalization in `review-response-parser.ts`, and retry/deadline policy in `CrossModelReviewService`. A reviewer gets one reformat-only retry through the same adapter and one total operation deadline; refusals, unknown shapes, and invalid repaired output remain failures.

**Tech Stack:** TypeScript, Node.js `AbortController`, Zod 4, Vitest.

## Global Constraints

- Do not synthesize scores, reasoning, summaries, or verdicts.
- Do not convert refusals, empty output, or unknown JSON shapes into reviews.
- Antigravity and Codex review operations use a 300-second minimum; other providers retain the configured timeout.
- One initial response plus at most one format-repair response share one operation deadline.
- Cancellation, pause, and shutdown must still interrupt and force-terminate the adapter.
- Do not commit unless James explicitly asks.

---

### Task 1: Align and Safely Normalize the Review Contract

**Files:**
- Modify: `src/main/orchestration/review-prompts.ts`
- Modify: `src/main/orchestration/review-response-parser.ts`
- Modify: `src/shared/validation/cross-model-review-schemas.ts`
- Modify: `src/shared/types/cross-model-review.types.ts`
- Test: `src/main/orchestration/review-response-parser.spec.ts`
- Test: `src/shared/validation/cross-model-review-schemas.spec.ts`

**Interfaces:**
- Consumes: `parseCrossModelReviewResponse(reviewerId, rawResponse, reviewDepth, durationMs)`.
- Produces: parsing of bounded assumption/risk variants; `isLikelyReviewRefusal(rawResponse): boolean`; `buildReviewFormatRepairPrompt(reviewDepth, invalidResponse): string`.

- [x] **Step 1: Add failing parser and schema tests**

Create parser cases for:

```ts
expect(parseCrossModelReviewResponse('antigravity', JSON.stringify({
  ...validTiered,
  assumptions: [
    'The API remains available',
    { description: 'The caller supplies a workspace', severity: 'HIGH' },
    { assumption: 'Authorization is configured', severity: 'critical' },
  ],
  integration_risks: [{ risk: 'A downstream schema may lag' }],
}), 'tiered', 10)).toMatchObject({
  assumptions: [
    { assumption: 'The API remains available', severity: 'medium' },
    { assumption: 'The caller supplies a workspace', severity: 'high' },
    { assumption: 'Authorization is configured', severity: 'critical' },
  ],
  integrationRisks: ['A downstream schema may lag'],
});
```

Also assert that an unknown assumption object, unknown severity, invalid verdict,
empty risk alias, and plain-text refusal return `null`/fail validation. Add a
schema test proving `critical` is accepted.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm run test:quiet -- src/main/orchestration/review-response-parser.spec.ts src/shared/validation/cross-model-review-schemas.spec.ts
```

Expected: failures for missing bounded normalization and rejected `critical` severity.

- [x] **Step 3: Implement the minimal contract changes**

Update the shared severity union and Zod enum to
`'critical' | 'high' | 'medium' | 'low'`. Expand the tiered prompt example with
non-empty canonical assumption and integration-risk entries.

In `review-response-parser.ts`, normalize only these aliases:

```ts
const ASSUMPTION_TEXT_KEYS = ['assumption', 'description', 'text', 'issue'] as const;
const RISK_TEXT_KEYS = ['risk', 'description', 'text', 'issue', 'summary'] as const;
const ASSUMPTION_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
```

String assumptions become medium-severity objects. Object aliases must resolve
to non-empty strings and recognized severities; otherwise leave them invalid so
Zod rejects them. Risk objects must resolve to one recognized non-empty string.
Do not alter verdicts except the existing uppercase normalization.

Add a conservative refusal detector for the observed forms (`cannot fulfill`,
`unable to assist`, `cannot assist`) so orchestration will not ask a refusal to
manufacture a JSON review.

- [x] **Step 4: Add the repair prompt builder**

Add `buildReviewFormatRepairPrompt` to `review-prompts.ts`. It must wrap the
invalid response as untrusted data, include the exact structured or tiered JSON
shape, and state: preserve conclusions/scores/verdict; add no facts; output JSON
only.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run the same focused test command and require zero failures.

---

### Task 2: Add One Repair Attempt and a Shared Deadline

**Files:**
- Modify: `src/main/orchestration/cross-model-review-service.ts`
- Modify: `src/main/review/review-execution-host.ts` only if a small shared helper is needed
- Test: `src/main/orchestration/cross-model-review-service.spec.ts`

**Interfaces:**
- Consumes: `buildReviewFormatRepairPrompt`, `isLikelyReviewRefusal`, `sendAbortableReviewerMessage`, and `combineAbortSignals`.
- Produces: one accepted `ReviewResult` or `null`; no more than two `sendMessage` calls; one total deadline.

- [x] **Step 1: Add failing orchestration tests**

Add tests proving:

```ts
// invalid first response, valid repair
expect(sendMessage).toHaveBeenCalledTimes(2);
expect(sendMessage.mock.calls[1]?.[0].content).toContain('reformat');
expect(result).toMatchObject({ reviewerId: 'antigravity', parseSuccess: true });

// invalid first and repaired responses
expect(result).toBeNull();
expect(sendMessage).toHaveBeenCalledTimes(2);

// refusal
expect(result).toBeNull();
expect(sendMessage).toHaveBeenCalledTimes(1);
```

Use fake timers for a hanging initial/repair operation and assert the adapter is
interrupted/terminated when the single deadline expires. Assert that an
upstream abort still reports `Review cancelled` immediately.

- [x] **Step 2: Run the service spec and verify RED**

```bash
npm run test:quiet -- src/main/orchestration/cross-model-review-service.spec.ts
```

Expected: repair-call and deadline assertions fail against current behavior.

- [x] **Step 3: Implement the single operation controller**

At the start of `executeOneReview`, create a deadline `AbortController`, combine
it with the caller signal, and arm one timer for `timeoutMs`. Pass the combined
signal to both sends. Track whether the deadline controller fired so the catch
path reports a provider-specific review deadline rather than misclassifying it
as a user cancellation. Clear the timer in `finally`.

- [x] **Step 4: Implement one format-repair send**

Parse the initial response. If valid, return it. If invalid and not a refusal,
log a bounded repair-attempt event and call `sendAbortableReviewerMessage` once
more on the same adapter with the repair prompt. Parse the repaired response
through the same parser. Never execute a third send.

Log final success with `cliType`, `reviewId`, `durationMs`, and `repaired`; log
repair rejection without full output. Keep adapter cleanup in the existing
`finally` block.

- [x] **Step 5: Run the service spec and verify GREEN**

Run the service spec command and require zero failures and no timer leaks.

---

### Task 3: Apply the Antigravity Review Timeout Floor

**Files:**
- Modify: `src/main/orchestration/cross-model-review-service.ts`
- Test: `src/main/orchestration/cross-model-review-service.spec.ts`

**Interfaces:**
- Consumes: reviewer CLI ID plus configured timeout seconds.
- Produces: effective timeout milliseconds.

- [x] **Step 1: Add failing timeout-policy tests**

Add table-driven assertions through `executeOneReview` and captured adapter
options:

```ts
expect(timeoutFor('antigravity', 120)).toBe(300_000);
expect(timeoutFor('antigravity', 420)).toBe(420_000);
expect(timeoutFor('codex', 120)).toBe(300_000);
expect(timeoutFor('copilot', 120)).toBe(120_000);
```

- [x] **Step 2: Run the service spec and verify RED**

Expected: the 120-second Antigravity case receives `120_000` before the fix.

- [x] **Step 3: Implement the timeout floor**

Replace the Codex-only constant/branch with an explicit provider-floor map or
equivalent small helper. Both `codex` and `antigravity` have a `300_000` minimum;
all other providers use the configured value.

- [x] **Step 4: Run targeted review tests**

```bash
npm run test:quiet -- \
  src/main/orchestration/review-response-parser.spec.ts \
  src/shared/validation/cross-model-review-schemas.spec.ts \
  src/main/orchestration/cross-model-review-service.spec.ts \
  src/main/orchestration/cross-model-review-service.headless.spec.ts
```

Require zero failures.

---

### Task 4: Canonical Verification and Runtime Evidence

**Files:**
- Review only: all changed files and `git diff --check`

- [x] **Step 1: Inspect the complete diff and preserve unrelated changes**

Run `git diff -- <changed paths>` and `git diff --check`. Confirm no secret-like
data, full model outputs, or unrelated work entered the patch.

- [x] **Step 2: Run both TypeScript programs**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

- [x] **Step 3: Run project static gates**

```bash
npm run lint
npm run check:ts-max-loc
```

- [x] **Step 4: Run the full quiet suite**

```bash
npm run test:quiet
```

- [x] **Step 5: Verify live behavior when a reviewable local instance is available**

Deferred to [2026-07-11-antigravity-review-reliability-plan_livetest.md](2026-07-11-antigravity-review-reliability-plan_livetest.md) — requires a rebuilt app and a real Antigravity review cycle, unavailable in the implementing session.

