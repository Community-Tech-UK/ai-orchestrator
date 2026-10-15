# Automation standard Opus default

Status: implemented and verified, untracked. James requested that automations stop using Opus 1M. Rebuilt-app activation remains explicitly deferred to the linked live-test document.

## Scope and acceptance

- [x] Change the live automation default from `opus[1m]` to `opus`; read it back.
- [x] Through `update_automation`, change all 23 active (including paused) automations pinned to `opus[1m]` to `opus`. Preserve providers, prompts and enabled states. Completed historical automations and in-flight runs remain historical/current snapshots.
- [x] Change the shared new-automation selector to standard `CLAUDE_MODELS.OPUS`, covering form-created, draft-created, native-command and MCP-created automations. Keep explicit selections and non-Claude provider handling intact.
- [x] Correct the two MCP creation descriptions and existing default-selection tests.
- [x] Run focused tests, typechecks, lint, LOC gate, both builds and full quiet tests, preserving complete logs. Obtain independent fresh `task-completion-gate` PASS.
- [x] Record rebuilt-app activation requirement in [pending activation checks](2026-10-07-automation-standard-opus_plan_livetest.md); do not restart the running Harness or interrupt James's sessions. Close this plan only after agent-runnable gates pass.

## Implementation

Replace only the shared fallback `CLAUDE_MODELS.OPUS_1M` with `CLAUDE_MODELS.OPUS`. Update the existing form/page/MCP/native-orchestration assertions that specifically cover default creation, plus MCP provider help copy. Leave fire-time resolver, manual model choices, non-Claude choices and interactive defaults unchanged.

## Risks and verification

Shared default affects app forms, generated drafts and MCP create. Existing coverage exercises all three and explicit non-Claude selection. Live settings have been read back; read-only SQLite confirmed zero active pins remaining. Code changes require the rebuilt app to be loaded; the live config repair already applies to subsequent existing-automation runs.

No branch/worktree, commit, push, or deployment. Preserve the substantial unrelated dirty checkout.

## Verification so far

- Focused form/page/MCP/forwarder run passed (78 tests); native orchestration passed (27 tests); rebuilt shared-selector probe returned `opus` for omitted/auto/Claude selections, preserved Codex and explicit Sonnet.
- Typecheck, spec typecheck, lint, production LOC gate, main build and renderer build exited 0. Logs: `_scratch/automation-standard-opus/`.
- First full run: 29,906 passed, 3 failed. One native creation assertion still expected 1M; corrected and focused rerun passed. Two executable-packaging checks require the SEA fuse missing in Homebrew Node26; both passed under the project's pinned Node24.15.0, log `_scratch/test-run.automation-opus-sea-node24.log`. No packaging source or test suppression was changed.
- The first fresh reviewer independently passed clean-install snapshot typechecks, lint, main/renderer builds and 100 focused tests; durable evidence is in `_scratch/automation-standard-opus/independent-gate/`. Its non-Git snapshot was unsuitable for Git-dependent full-suite checks, so final full verification moved to the existing checkout with pinned Node24. The review context and process handle were lost before a final result; the partial raw log is not pass evidence. A second fresh reviewer investigated the observed native-outcome test failure and completed the final full verification recorded below.
- Second reviewer independently confirmed the native-outcome spec, runner and input-writing code are byte-for-byte HEAD. Focused test file passed 7/7; its unchanged fixture prints ACK before installing its SIGINT handler, and a direct immediate-interrupt stress probe reproduced that readiness race. This is baseline test-fixture behavior outside the automation-selection diff. No fixture or unrelated production file was changed; the final full run passed as recorded below.

## Final verification and as-built status

- Canonical full quiet suite under pinned Node24.15.0 exited 0: 2,374 files passed, 29,903 tests passed, six unchanged baseline skips, zero failures. Raw report independently parsed with `success:true`. Logs: `_scratch/test-run.automation-opus-final-review.log` and `_scratch/test-results.automation-opus-final-review.json`; exact exit recorded in `_scratch/automation-standard-opus/independent-gate/final-suite-status.json`. Earlier failed/interrupted runs are not pass evidence.
- Fresh independent `automation_final_gate` review returned `VERDICT: PASS` with no unresolved actionable findings. It checked the seven-file unstaged diff, acceptance criteria, test integrity, architecture, provider/model preservation, security/state/performance surfaces, clean-install verification and live readback. Durable verdict: `_scratch/automation-standard-opus/independent-gate/final-verdict.md`. The previously observed native-outcome fixture also passed in the canonical full run.
- Final live readback: `automationDefaultModel=opus`; zero active `opus[1m]` definitions; all 23 converted definitions retain their 15 enabled/eight paused states. Twelve inactive historical definitions retain their original model. No automation was fired for verification.
- Shared creation fallback, aligned tool help and exact default assertions are implemented in seven unstaged source/test files. Explicit model selections, non-Claude providers and interactive defaults retain their existing behavior.
- Source/configuration work is complete. The running Harness retains its already-loaded creation code; loading the rebuilt app is still pending and covered by the linked activation checks. No restart, commit, push, deployment, branch or worktree was performed.
