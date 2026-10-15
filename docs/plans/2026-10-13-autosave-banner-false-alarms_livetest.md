# False "work missing from History" banners: packaged-app check

Status: pending live verification. Open: 2 · Closed: 0

Prerequisites: rebuild the packaged Harness from this checkout through the
normal local build pipeline, then restart that rebuilt instance when its live
sessions can be safely interrupted. The implementing agent did not replace or
restart the running app (sessions were live). Code, tests and builds are
recorded in the
[implementation plan](2026-10-13-autosave-banner-false-alarms_plan_completed.md).

Remediation flow: before running a campaign, read
[the campaign runbook](livetest-campaign-runbook.md). A reproduced defect needs a
new LT-NNN index row and full entry in
[the remediation register](livetest-remediation-register.md), plus its matching
implementation-status section in
[the remediation plan](2026-07-19-livetest-failure-remediation_plan.md).
Keep per-check evidence here. Rename this file `_livetest_completed.md` only
after every check passes.

## 1. The four reported sessions are no longer flagged

Steps: after restarting the rebuilt app, open the dashboard. If the banner
appears, choose "Review autosave".

Expected: no banner, or a banner that does not list "BinsOut daily council
additions", "(retry 2)", "(retry 3)" or "Plan Queue workflow execution" (runtime
ids `xa1m0mnnz`, `xq0q00ggd`, `xo2pvb5u5`, `x8295hh05`). Those autosaves age out
of the 7-day window around 2026-10-20, so run this before then for it to prove
anything.

Why deferred: needs the rebuilt, restarted packaged app.

## 2. Startup log reports real outcomes

Steps: in `~/Library/Application Support/harness/logs/app.log`, find the
`Startup autosave archive finished` line from the restart.

Expected: the data carries `archived` and `declined` counts (no `submitted`
field). The four sessions above should not be counted, because they are no
longer candidates. If the line is absent, nothing was left to save, which also
passes.

Why deferred: needs the rebuilt, restarted packaged app.
