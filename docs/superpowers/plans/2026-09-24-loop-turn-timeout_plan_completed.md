# Loop turn timeout recovery implementation plan

Status: completed. Spec: [2026-09-24-loop-turn-timeout_spec_completed.md](../specs/2026-09-24-loop-turn-timeout_spec_completed.md).

## Tasks

1. [x] Add focused tests that reproduce the prompt, timeout/evidence, and summary problems.
2. [x] Update review-driven and default continuation prompts for bounded slices; preserve legacy prompt migration.
3. [x] Add an interruption settlement grace in the child invoker, preserve observed evidence and usage, and ensure timed-out turns cannot count as completed.
4. [x] Ensure both owned and borrowed adapters receive timeout interruption without changing ownership or cleanup.
5. [x] Explain checkpoint/hard-cap timing and recorded usage in configuration and terminal summary surfaces.
6. [x] Run focused tests, canonical project gates, and a fresh independent completion review; record any live check that genuinely requires a restarted app.

## Progress checkpoint — 2026-09-24

- Repository inventory reconciled: this is the only confirmed active implementation plan; the remaining open-name documents are live-validation work, registries, archived drafts, or capability backlog without an active plan.
- The main implementation is already present at `HEAD` (`98ad8ede`); this continuation is verifying and closing it rather than replaying completed edits. The independent review found one accounting edge case, now fixed in the working tree with a focused regression.
- End-to-end trace confirmed the bounded review prompts, timeout interruption and settlement grace, owned/borrowed adapter handling, failed-attempt evidence and usage accounting, and renderer wording.
- Pre-review focused verification passed: 8 files, 181 tests. The pre-review canonical gates also passed, including the full quiet suite (2,223 files / 26,475 tests).
- First independent completion gate returned `FAIL`: aggregate-only provider usage was dropped when a timed-out success-shaped callback also carried an empty breakdown object. A focused regression reproduced the loss (`RED`), and the timeout conversion now preserves the finite positive aggregate alongside the breakdown (`GREEN`: 8/8 in `loop-child-invoker.spec.ts`; complete focused surface: 8 files / 182 tests).
- Post-fix gates passed: main TypeScript, spec TypeScript, lint, TypeScript LOC ratchet, main build, and renderer production build. The first post-fix full run found one unrelated ACP timing assertion; that assertion and its complete 77-test file both passed immediately in focused reruns.
- An intermediate canonical full-suite rerun was not valid completion evidence because a separate messaging/Codex change set appeared in the shared checkout while it ran: the collected test count increased from 26,477 to 26,479 and the two failures were in the newly moving `messaging-retry-disposition` surface. Those files are unrelated work and were not edited here.
- After that concurrent work stabilized, the complete post-fix canonical gate passed: main TypeScript, spec TypeScript, lint, TypeScript LOC ratchet, main build, renderer production build, and the full quiet suite (2,223 files / 26,480 tests in 311.7 seconds; log `_scratch/test-run.pid-47199.log`).
- A genuinely fresh completion-gate reviewer independently reproduced the focused suite (8 files / 182 tests), every canonical gate, a compiled-runtime accounting/settlement smoke, ownership and cleanup tracing, gitleaks, and scoped accessibility checks. Its independent full suite passed 2,223 files / 26,480 tests in 546.2 seconds (`_scratch/test-run.pid-86453.log`), with `VERDICT: PASS` and no findings.
- No remaining acceptance check requires a rebuilt/restarted app, human interaction, or an external service, so no live-test deferral was created.

## As built

- Review-driven and default continuation prompts now request coherent bounded work slices and resumable handoffs while preserving first-turn directive placement and legacy prompt migration.
- Timed-out child invocations request interruption, accept callback evidence only within the 30-second settlement grace, and remain failed/degraded even when a callback is success-shaped. Silent settlement retains unknown evidence and pauses safely.
- Timeout error conversion preserves detailed usage and any finite positive aggregate token count, so failed-attempt charging cannot silently record zero for aggregate-only providers.
- Owned and borrowed adapters both receive interruption without changing cleanup ownership; listener, activity, adapter-loan, replay, context, and prompt-cache safeguards remain intact.
- Configuration and terminal summaries explain the checkpoint/hard-cap/grace model and distinguish recorded zero usage from evidence of work.

## Risks and checks

- Late callbacks could double-settle: fake-clock timeout tests check single settlement and listener cleanup.
- Partial success could look completed: degraded-retry tests verify timeout remains an error or degraded result.
- Borrowed adapters must not be terminated by loop cleanup: existing adapter ownership tests and a focused timeout test cover this.
- Existing unrelated working-tree changes must be retained; inspect the final diff and status.
