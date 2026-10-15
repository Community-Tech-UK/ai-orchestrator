# Localhost browser approval live check

Status: pending. Prerequisite: run a rebuilt Harness instance containing this change, with Browser Gateway connected to `windows-pc`. The currently running app is not restarted by this coding task.

Plan: [localhost browser approval](2026-10-04-localhost-browser-approval_plan_completed.md).

Remediation flow: read [live-test campaign runbook](livetest-campaign-runbook.md) before executing. A reproduced defect belongs in [live-test remediation register](livetest-remediation-register.md) and the matching implementation-status section of [live-test failure remediation plan](2026-07-19-livetest-failure-remediation_plan.md). Keep evidence here; rename this file `_livetest_completed.md` only after every check passes.

## Deferred check: rebuilt app startup and visible approval banner

Why deferred: automatic localhost consent is composed into the main-process service during app initialization. Building the checkout does not replace the already-running packaged main process. Restarting the current app would interrupt James's active sessions. Unit/integration behavior, banner-poll data, and builds are verified separately in-loop.

1. Build/run the changed checkout through the normal local application workflow. No automation/autonomous-mode opt-in is needed for local pages.
2. Use `browser.health`, then `browser.preflight_target` with `computer: "windows-pc"` and an HTTP(S) localhost development URL. If no Windows localhost fixture exists, serve a throwaway page on that worker; do not treat a coordinator-local server as Windows localhost.
3. Use `browser.find_or_open` with the same explicit computer. Request a session grant for the exact local scheme, host, and port, with classes `input`, `submit`, and `destructive`, `allowExternalNavigation: false`, and `autonomous: true`.
4. Expected: tool result `decision: allowed`, `outcome: succeeded`; no approval request or hostname confirmation appears in the app's approval banner. `browser.list_approval_requests` with `status: pending` must exclude this request.
5. Perform a harmless save on the throwaway page. Expected: the page records the save and no approval banner appears. Repeat the grant request; expected: it succeeds without adding another grant request.
6. Compare an external fixture page with automation mode off. Expected: ordinary grant requests still return `requires_user`. Do not submit external forms or enter credentials for this check.

Evidence: pending rebuilt/restarted-instance campaign.

## Evidence run — 2026-10-04 (orchestrating session)

**Not runnable yet.** The change is still uncommitted in the working tree
(`src/main/browser-gateway/browser-auto-approve.ts`, last modified 21:32 BST) and the installed app
was built at 19:06. A search of `/Applications/Harness.app/Contents/Resources/app.asar` finds no
`auto_approved_localhost`, `withLocalBrowserAutoApproval` or `isLocalBrowserApproval`. The running
app therefore cannot exhibit the behaviour; this check waits for a rebuild that includes the change
and a restart by James.
