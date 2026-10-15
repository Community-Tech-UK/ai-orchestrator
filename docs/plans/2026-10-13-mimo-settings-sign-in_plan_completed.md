# MiMo settings sign-in repair

Status: code repair completed and independently verified on 2026-10-13; untracked. No commit or push authorised.

Deferred real-account Xiaomi login: [live verification steps](2026-10-13-mimo-settings-sign-in_livetest.md). No real usage login was performed or claimed.

## Acceptance

1. Coding sign-in and usage sign-in are clearly distinguished; copying a coding command is explicitly labelled.
2. Successful and failed account actions show feedback inside the account card, including clipboard actions.
3. Long remote sign-in commands remain complete and copyable without widening the settings window. Account forms and policies fit narrow windows.
4. Existing account-scoped usage login remains securely wired; missing usage login is not presented as coding authentication failure.
5. A previous coding poll cannot replace a newer usage action or stop a newer account's poll. A new account's sign-in-copy failure remains visible before its card has loaded.

## Work

- [x] Reproduce the current button/feedback and overflow with the real Angular component in an isolated automated UI fixture; use synthetic accounts only.
- [x] Repair labels, feedback placement and width containment in the existing component and template. Preserve provider account commands and credential boundaries.
- [x] Verify the corrected UI before extending regression tests. Cover independent usage/coding actions, per-account feedback, and error feedback.
- [x] Run focused tests and all canonical checks: application and spec typechecks, lint, size check, both builds, full quiet suite.
- [x] Run an independent fresh-agent task-completion gate; fix and re-review any findings.
- [x] Close this document only after code verification passes. Record any genuine live Xiaomi login check separately with exact steps; do not claim a real account is connected without observing it.

## Risk and verification

MiMo usage needs a separate Xiaomi console login from its coding API key. Do not switch the command-copy action into an unexpected terminal launch. Feedback identity must include provider and account ID because each provider has a legacy account. Preserve full command text and actual clipboard success/failure. Automated headless UI tests may run locally under James's explicit test-tooling exception; interactive browser work uses the healthy Windows worker only. No branches/worktrees or application restart without request.

## Review corrections

The first fresh gate independently reproduced two defects in the initial repair: a prior coding poll replaced the same account's newer Xiaomi instructions, and a newly created account's copy failure was hidden until its card loaded. The repair now invalidates/cancels previous polls at each action and teardown, checks the generation after asynchronous verification, and falls back to global feedback when no matching card exists. Both corrected paths passed real Angular headless UI reproduction before regression tests were extended. Final canonical checks and a second genuinely fresh gate passed on this corrected state.

Verification environment: `.nvmrc` pins Node v24.15.0. A later full-suite command picked up Homebrew Node v26.3.0, whose executable does not contain the packaging fuse; only the two SEA repeatability tests failed. Their output is retained in `_scratch/mimo-full-tests-node26-failure.log`. The pinned Node binary was verified to contain the fuse, and the two unchanged failing tests passed under it. Final full-suite verification uses an explicit per-command PATH prefix to the already installed pinned version; no dependencies, test assertions or machine-wide settings were changed.

Accessibility: automated axe comparison of the repaired component and HEAD reproduced the same two existing colour-contrast findings (disabled status and Remove button), with no new violations. These unchanged palette rules are outside the sign-in/layout repair. Evidence: `_scratch/mimo-a11y.json` and `_scratch/mimo-a11y-before.json`.

## As built and final evidence

- Changes are limited to the provider-account component, template and adjacent specs. Coding and usage sign-in remain separate actions; copying does not unexpectedly open a terminal. Existing secure Xiaomi login, storage, schemas and IPC are unchanged.
- Per-account success/error/clipboard feedback uses provider plus profile ID. New-card failures fall back to a visible global alert. Delayed verification belongs to the action that launched it and cannot overwrite newer usage instructions or cancel a newer account's polling.
- Long commands retain all 1,755 characters in the synthetic fixture at widths 870/640/400. Their boxes scroll and can receive keyboard focus. Controls remain within the viewport; complete command text is copied.
- Implementer final full suite: exit 0, 2,407 files, 31,060 passed, six existing skipped tests; `_scratch/mimo-full-tests.log` and `_scratch/test-run.pid-92789.log`.
- Independent final gate: **VERDICT: PASS**, no unresolved actionable findings. All seven canonical checks independently rerun under pinned Node v24.15.0 and exited 0. Focused 32 tests passed; independent full suite also passed 31,060 tests. Report and command evidence: `_scratch/mimo-final-gate-review.md`, `_scratch/mimo-final-gate-*.log`; raw full output `_scratch/test-run.pid-38517.log`.
- Original/final UI evidence and negative reproductions are retained in `_scratch/mimo-ui-{before,after,race}.json`, `_scratch/mimo-settings-*.png`, the first gate report, and the synthetic new-account-copy-error fixture. No user credentials, account settings, running app, branches or worktrees were altered. No changes are staged or committed.
