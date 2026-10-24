# Usage-limit account switch: installed-app live check

Status: pending external validation.

Prerequisites: install a build containing this fix and restart that Harness instance when its active sessions can safely be interrupted. Use the existing acknowledged automatic Claude pool; keep paid overage disabled. Requires a genuine provider quota event and another signed-in account with included usage available.

Plan: [usage-limit account switching](2026-10-16-usage-limit-account-switch_plan_completed.md).

Remediation flow: before running a live campaign, read [the campaign runbook](livetest-campaign-runbook.md). Record a reproduced defect as a new LT-NNN index row and full acceptance entry in [the remediation register](livetest-remediation-register.md), with a matching implementation-status section in [the remediation plan](2026-07-19-livetest-failure-remediation-followup_plan.md). Keep per-check evidence here. Rename this document `_livetest_completed.md` only after its check passes.

- [ ] When a Claude chat naturally reaches a refused five-hour or weekly usage window, confirm it stops the exhausted account, announces that it is moving accounts, selects another eligible account and continues the interrupted task once. Confirm the header shows the new account and the quota pause banner is absent. Confirm it retains earlier work rather than repeating the original task from the beginning. Record the observation time and redacted relevant log evidence here.

Why deferred: source-level event-to-dispatch behavior is covered by automated runtime integration tests. Observing the installed desktop build with the real provider requires an updated/restarted app and an external quota event. The task does not deliberately exhaust an account, spend paid credits, restart James's active app, or control the Harness desktop.

No flags or settings changes are needed for James's current configuration: automatic account switching and automatic quota resume were enabled, ownership was acknowledged, and paid overage was disabled at investigation time.
