# Automation standard Opus activation check

Status: pending rebuilt Harness launch. The current app was not restarted or replaced.

Prerequisite: launch the rebuilt Harness containing the shared-selector change. A restart of an older installed package is insufficient. The running app's launch location could not be established because a read-only `ps` probe returned `Operation not permitted`.

Plan: [automation standard Opus](2026-10-07-automation-standard-opus_plan_completed.md). Source/configuration verification and the independent completion gate passed; this document remains open for rebuilt-app activation.

Remediation flow: [live-test campaign runbook](livetest-campaign-runbook.md). Record any reproduced defect in [remediation register](livetest-remediation-register.md), with corresponding implementation status in `2026-07-19-livetest-failure-remediation-followup_plan.md`. Keep per-check evidence here; rename this document `_livetest_completed.md` only after these checks pass.

## Checks after rebuilt app launch

1. Open the new-automation form without saving. Expected: Claude standard Opus (`opus`) selected, rather than `opus[1m]`. Close the form.
2. Through `create_automation`, save a disabled verification automation with provider omitted, no recipients/external actions, and prompt `Report the selected model only; perform no external actions.` Use a future schedule and `enabled:false`; never fire it. Read its stored `action.model` through the read-only automation store: expected `opus`, provider `claude`. Delete only this new disabled verification automation using its returned identifier.
3. Re-read the dedicated `automationDefaultModel` setting and active automation selections. Expected default `opus`, zero active `opus[1m]` pins. Historical completed definitions may retain their original model.

Why deferred: compiled code and component/MCP/native-command paths are testable now and have been checked, but the existing running app retains its loaded creation code. No live test requires sending, submitting or executing an automation.
