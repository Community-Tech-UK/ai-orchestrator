# Browser persistent approvals: installed-app smoke check

**Status:** Pending installed-app validation. This is not a claim that the running Harness was restarted or upgraded.
**Prerequisites:** Start the intended Harness instance from the updated main and renderer build, with `windows-pc` connected and its Browser Gateway extension ready. The implementation session did not alter live grants or restart Harness.
**Implementation plan:** [Browser persistent approvals](2026-09-19-browser-persistent-approvals_plan_completed.md).
**Remediation flow:** Before a campaign, read [the livetest campaign runbook](livetest-campaign-runbook.md). Record each reproduced defect as a new LT-NNN entry in [the remediation register](livetest-remediation-register.md), with a matching implementation-status section in [the remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md). Keep per-check evidence here. Rename this file `_livetest_completed.md` only after all checks pass.

The actual Angular components and real payload schema have already been exercised through the Windows Browser Gateway in an isolated fixture. Real SQLite migration, grant reload, later agent sessions, revocation, and origin/computer isolation have automated coverage. These checks cover only the installed application's upgrade and interaction with its existing live state. They require a rebuilt/restarted app and a human operating Harness, which is a hard-denied Computer Use target.

## 1. Existing request and standing consent

1. In the updated Harness, obtain a fresh approval for a harmless credential-classified click on the intended site through `windows-pc`, such as opening the token-configuration panel shown in the original report. Do not enter credentials or submit configuration changes for this smoke check.
2. Open Browser Gateway > Permissions and confirm the request has Allow once, Allow for session, Allow unattended, and Allow forever.
3. Choose Allow forever. The request resolves; the active grant shows the exact approved origin, Forever, and Until revoked.
4. Restart the same Harness instance, then use a new agent session for the same harmless action class on that exact site and computer. It executes without another permission request. Existing unrelated grants remain visible according to their original expiry.
5. Revoke the standing grant in Permissions. If it is beyond the first 25 active grants, use Load more grants to reach it. A subsequent action that depended on it requires approval again, provided no other matching user-approved grant exists.

Expected: approval survives restart and a different agent session; operator revocation removes its authority. This is pending because the implementation session intentionally leaves live app state and active sessions in place.

## 2. Top banner unattended selection

1. Obtain a fresh harmless credential-classified request without a matching standing grant.
2. Select Allow unattended in the top banner and wait at least six seconds, crossing the five-second polling interval.
3. Confirm the dropdown still shows Allow unattended, then approve it.

Expected: the request resolves, the agent can retry the approved action, and the active grant uses the existing expiring unattended mode. This is pending only for the installed application's real IPC/session-resume path; selection persistence and emitted payloads already passed in the Windows fixture.

## Evidence

- Installed-app check 1: pending.
- Installed-app check 2: pending.

## Evidence run — 2026-10-04 (orchestrating session; re-examined, not run)

The installed app (built 19:06, restarted 20:45:59) is now an updated build, so the "installed
upgrade" prerequisite is met. Both checks still need a person to choose **Allow forever** /
**Allow unattended** in the running Harness's Permissions panel and top banner. Harness is a
hard-denied Computer Use target, the packaged app has no debug port, and agent sessions in this
environment hold YOLO auto-approval (a request raised here is auto-granted with
`auto_approved_by_yolo_mode` before any banner appears — observed today for a `browser.close_tab`
grant, `9bd1352f-…`). An honest run therefore needs James, ideally from a non-YOLO session.
Open: 2 · Closed: 0 · Failed: 0.
