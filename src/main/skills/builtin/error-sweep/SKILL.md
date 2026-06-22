---
name: error-sweep
description: Find the highest-signal recurring error in local logs, trace it, and propose a verified fix.
triggers: ["/error-sweep", "production error sweep", "log error triage"]
version: 1.0.0
category: loop
effort: high
---

# Production Error Sweep Loop

A convergence loop that picks the single most actionable recurring error each
iteration, traces it to a root cause, and proposes (or applies) a narrow,
verified fix.

## Loop contract

- **OBJECTIVE** — pick the single most actionable recurring error from recent logs and trace it to a root cause.
- **CHECKS** — confirm the error is real and recurring (multiple occurrences, a clear trace), and identify the originating code path before proposing a fix.
- **STOP**
  - done — one recurring error is traced to a root cause with a narrow proposed or applied fix.
  - stalled — recent logs contain no actionable recurring error.
  - needs-permission — the fix requires credentials, production access, or approval.
- **GUARDRAILS** — do not apply broad changes or delete logs; propose a narrow fix and only apply it if it is clearly safe and verifiable.

## Behavior

1. Scan recent local logs for repeated errors, failed jobs, or crash traces.
2. Distinguish actionable errors from expected noise; ignore one-off or already-handled cases.
3. Pick the highest-signal recurring error and trace it to the originating code path.
4. Propose a narrow fix; apply it only when clearly safe and verifiable.

## Output

A concise summary of errors triaged, the chosen error and its root cause, the
proposed/applied fix, verification, and any blockers.
