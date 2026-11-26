# Regular-session announce-then-halt guard implementation plan

Status: complete

Specification: [2026-09-04-regular-session-announce-then-halt-guard_spec_completed.md](../specs/2026-09-04-regular-session-announce-then-halt-guard_spec_completed.md)

## Tasks

- [x] Extract the existing provider-neutral action detector and add a stricter trailing-action classifier for regular sessions.
- [x] Add failing unit tests for the reproduced incident, eligibility boundaries, newer-turn suppression, background-work suppression, and the one-nudge cap.
- [x] Implement a lifecycle coordinator that observes normalized completion events, waits for settlement, and uses the normal auto-continuation send path.
- [x] Wire the coordinator during application initialization and cleanup.
- [x] Run focused tests and the canonical TypeScript, lint, LOC, main-build, and full-test gates.
- [x] Obtain an independent fresh-agent `task-completion-gate` PASS and resolve every actionable finding.
- [x] Record the rebuilt-app-only checks in [the live-test document](2026-09-04-regular-session-announce-then-halt-guard_livetest.md), update as-built notes, and close the spec and plan.

## Risk controls

- One automatic nudge per manual-turn chain prevents runaway loops.
- Request-count fencing prevents a queued nudge from racing newer user input.
- Root-orchestrated eligibility and a trailing high-confidence match reduce false positives.
- Existing async-work and context-budget guards remain authoritative.

## As-built notes

- Added a provider-neutral, precision-first trailing intent detector. It accepts only high-confidence immediate first-person action commitments and filters quoted/code containers, meta/example/reporting prose, user or provider dependencies, deferred timing, uncertainty, blockers, and completion evidence. Six frozen adversarial corpora covering 273 cases pass without mismatches.
- Added `InstanceAnnounceThenHaltContinuation`, initialized and stopped with the main runtime. It observes normalized provider completions, applies only to root `orchestrated` instances, waits for settlement, and sends at most one automatic nudge per manual-turn chain through `InstanceManager.sendInput`.
- Added a typed request-count fence captured synchronously at provider completion, before asynchronous evidence draining. Raw completion content is authoritative when present; crash-redacted fallback is limited to the latest assistant message and fails closed when freshness cannot be proven.
- Rechecks pause state, active Loop ownership, provider-native background work, cancellation, and request freshness at scheduling, settlement, send preflight, and the synchronous provider-dispatch boundary.
- Added `automatedInput` lifecycle semantics so system-generated resumptions preserve the manual-turn chain while genuine human actions reset it. Doc-review and secret-card actions remain manual by design.
- Changed context-continuity input handling to prepare/commit semantics. Aborted or budget-refused automatic sends retain queued continuity and do not create phantom request counts, history, snapshots, tool state, or last-sent state.
- Verification passed: both TypeScript checks, lint, LOC ratchet, main/preload build, 255 focused tests, and the full 1,944-file/21,341-test suite. A fresh independent `task-completion-gate` returned `VERDICT: PASS` with no findings, including diff, secret, architecture, async/state, TOCTOU, security, and performance review.
- Rebuilt-app interaction remains deferred to [the live-test document](2026-09-04-regular-session-announce-then-halt-guard_livetest.md); no live behavior is claimed until those checks are run.
