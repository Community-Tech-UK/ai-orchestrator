---
name: test-stabilizer
description: Find flaky tests, fix their root cause, and prove stability with repeated runs.
triggers: ["/test-stabilizer", "flaky test", "stabilize tests"]
version: 1.0.0
category: loop
effort: high
---

# Test Stabilizer Loop

A convergence loop: pick one flaky test, fix its root cause, and prove it is
stable before stopping. Best run in loop mode so each iteration tackles one test
until the suite is reliable.

## Loop contract

- **OBJECTIVE** — identify one flaky test and eliminate its root cause this iteration.
- **CHECKS** — re-run the affected test file multiple times; it must pass on *every* run before the fix counts.
- **STOP**
  - done — the flaky test has a root-cause fix and repeat-run evidence.
  - stalled — no reproducible flaky test or root cause can be found.
  - needs-permission — the fix requires destructive changes, external credentials, or approval.
- **GUARDRAILS** — do not delete tests, weaken assertions, add blanket retry wrappers, or hide instability behind longer timeouts.

## Behavior

1. Identify a candidate flaky test (intermittent failures, order-dependence, timing).
2. Reproduce the flake — run the file repeatedly until you observe both pass and fail.
3. Diagnose the underlying cause: timing/races, shared mutable state, test ordering, leaky mocks, real clock/network use.
4. Apply a targeted fix at the root cause, not the symptom.
5. Verify by re-running the file many times; require an unbroken pass streak.

## Output

A concise summary of the flaky test found, the root cause, the fix applied, the
repeat-run evidence, and any blockers.
