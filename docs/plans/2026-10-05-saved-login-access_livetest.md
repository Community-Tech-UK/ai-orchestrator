# Saved login approval live continuation

Status: pending. This is not evidence of successful sign-in.

**Latest operator direction:** James chose **keep other sessions running; continue checks only**. Installation and relaunch are not authorised now. Keep this live campaign pending until James changes that direction; do not repeat the relaunch question.

**Prerequisites:** The checked, signed local update must be installed and Harness relaunched when unrelated sessions can safely stop. The requesting 12steps conversation must be resumed in the updated app. windows-pc must be connected with its Browser Gateway extension healthy. James must personally accept the actual saved-login access request. Do not restart active unrelated sessions to run this check.

**Owning plan:** [Saved login access implementation](2026-10-05-saved-login-access_plan_completed.md).

**Remediation:** Read [Live-test campaign runbook](livetest-campaign-runbook.md) first. A reproduced defect requires a new numbered entry in [the remediation register](livetest-remediation-register.md) and a matching implementation-status section in `2026-07-19-livetest-failure-remediation_plan.md`. Keep per-check evidence here. Never edit a closed `_completed` document to add a new requirement; open a follow-up or reopen its lifecycle first.

## 1. Activate without interrupting unrelated work

- [x] Finish local checks, independent code review and signed packaging before installation. All canonical commands passed and the fresh code review returned PASS. The exact staged package and startup limitation are recorded below; actual installation/startup remains pending.
- [ ] At the operator's chosen safe relaunch point, install using the normal local DMG procedure, then reopen Harness and resume the existing 12steps conversation. Do not replace another session's connection variables or manually edit permission records.
- [ ] Preflight `browser.health` explicitly for windows-pc. Discover `browser.request_credential_access`, `browser.get_credential_access_status` and `browser.cancel_credential_access` through Browser Gateway tool search. If the session's MCP connection retains an old tool inventory, reconnect that requesting session to the updated app and repeat discovery. The credential request route does not require a working shell bridge. Browser RPC is now version 2 and requires this session’s injected capability. Old provider forwarders must reconnect to the updated app; never copy another session’s capability or connection variables. The worker extension protocol is unchanged.
- [ ] Verify presence only of that session's injected CLI bridge variables. Run `$AIO_MCP browser-credentials status --id <this-task-request-reference> --json` after a request exists. Do not print connection values. A pre-update running provider needs supported native resume/reconnect to receive the fixed isolated shell policy.

## 2. Actual visible decision and automatic continuation

- [ ] Use `browser.find_or_open({computer:"windows-pc", url:"https://www.babylovegrowth.ai"})` and read the live page. The previously observed signed-in dashboard is unrelated to this change. Preserve its existing session: do not sign James out to manufacture a login check. If it remains signed in, use an approved separate test account/context or wait for a genuine login requirement.
- [ ] Moved from plan Task 1: before requesting access, while the live login target stays open, run the original `browser.fill_credential` once against the chosen saved login and record its actual refusal code as baseline evidence. A `target_unavailable` result proves only that the tab closed, not a credential-authorisation refusal; reopen the target and repeat. Never read or type the secret to produce this evidence.
- [ ] From the actual requesting conversation call `browser.request_credential_access({profileId:<live-profile>,targetId:<live-target>,item:"12steps BabyLoveGrowth Login",reason:"Sign into BabyLoveGrowth for the current 12steps task",purposes:["login"]})`. If testing a separately approved account, substitute only its actual saved-login title and matching website. Never supply a password, forged origin, duration or authorisation record.
- [ ] Retain the returned real reference. Verify pending status and the visible Harness banner: asking session/reason, exact website, windows-pc, saved login title, login purpose, current-task default, explicit bounded remember option, folder-movement disclosure and Approve/Deny. YOLO must not resolve this new request.
- [ ] James selects Approve on that actual banner. Observe approved status only after enrolment and scoped authorisation succeed. Confirm the originating session receives the decision and resumes without commands copied by James. Repeated polling/approval must not create duplicate prompts, enrolment or grants.
- [ ] Retry the original `browser.fill_credential` using the actual live field selectors and returned authorised saved-item reference. The password stays in the secure broker/extension. Never read password-field values, capture a screenshot containing a filled secret, or pass a password in tool arguments. Before submitting sign-in, use the existing Browser Gateway action approval where required.
- [ ] Confirm the resulting authenticated page using safe page text such as the account/dashboard identity. Record decision/status and safe text evidence, excluding secret fields. This is the required complete visible approval → secure fill → authenticated-page proof.

## 3. Actual denial and reconnect behaviour

- [ ] A separate fresh task/account scope without existing consent requests access; James selects Deny. Verify denied status, no enrolment/authorisation, no successful secure fill, and the requesting conversation receives denial. Repeating the same request while its request window remains valid reuses the denied reference.
- [ ] Resume the requesting logical conversation and query its reference; its durable status remains truthful without creating another prompt. A different task cannot query/cancel its request or fill with its task-scoped permission.

## Why these checks remain live

The running Harness was built before these changes. Main-process code has no supported hot reload; the normal updater quits the app to install. A renderer preview with placeholder IPC and real service/database integration tests cannot prove the installed app's human decision, session wake, worker secure fill and authenticated website together. The existing BabyLoveGrowth dashboard was already signed in by another actor and is not credited to this workflow. No actual request has been approved through the new running code yet.

All agent-runnable unit/integration, typecheck, lint, build and review gates remain in the active plan; they are not deferred into this document.

## Staged build and startup evidence

Use only this replacement, which includes the independently reviewed queue repair:

`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/saved-login-access-package-final/Harness-0.1.0-mac-arm64.dmg`

The normal local build and packaging exited zero. Deep strict signature verification, matching helper signing identity, packaged compiled-module comparison and bundled CLI help checks passed. Evidence is linked from the owning plan; independent code report: `_scratch/saved-login-gate-queued-report.md`. The older `_scratch/saved-login-access-package/` build is superseded and must not be used for this campaign.

The packaged startup smoke has **not passed**: temporary-profile launches of both this replacement and the currently installed build encountered Chromium helper `sandbox initialization failed: Operation not permitted`, then a fatal GPU-process exit. Physical-path and existing-heap-flag repeats did not resolve it. All these checks preserved the Chrome native-host manifest and used separate disposable profiles. The real existing app and unrelated sessions were not restarted. Do not describe the installed app as broken or this package as startup-verified from these results; normal-launch acceptance remains outstanding and no sandbox restriction was disabled.

At James's chosen safe stopping point, close Harness normally only after unrelated sessions are ready to stop, open the replacement DMG, replace `/Applications/Harness.app` through the normal local installation procedure, and reopen it. First confirm ordinary startup and worker reconnection. Then resume the existing 12steps conversation through Harness's supported resume path so it receives its own new tool connection and shell environment. If this implementing conversation needs resumption too, use this document as the continuation prompt: **"Continue the saved-login live checks from this document. Preserve the existing signed-in tab and other sessions. Request the actual saved-login permission and wait for my banner decision before secure fill."** No password or connection value needs copying.

Do not sign James out of the existing BabyLoveGrowth dashboard. A genuine login requirement or an explicitly approved separate test account/context is required to prove the final sign-in step. Keep this document pending until actual approval, secure fill, safe authenticated-page evidence and denial/resume checks have been recorded.

## Evidence run — 2026-10-05 continuation

- Reviewed source fingerprints are unchanged. The replacement DMG remains staged, and repeated deep strict signature verification exited zero.
- Windows Browser Gateway preflight is healthy and deliverable. The running app still reports the old protocol/tool inventory; exact discovery does not return the new credential-request tool.
- A background/hidden new-instance launch through the normal macOS launcher used only a fresh smoke profile. The launcher returned zero, but no private main-process or ready marker appeared within the startup deadline. Startup is still unverified; a successful launcher exit is not an application readiness result.
- The machine-global Chrome native-host manifest remained unchanged. Exact staged executable/helper-code inspection found no remaining staged processes. No installed-app replacement, existing-session quit, vault read/fill or credential decision occurred.
- Evidence: `_scratch/saved-login-launchservices-smoke-evidence.json`, `_scratch/saved-login-launchservices-smoke.log`, `_scratch/saved-login-continue-signature.log`.
- The explicit safe-relaunch question remains pending. Once James chooses a safe relaunch point, follow activation section 1, resume the original requesting conversation, and run sections 2–3. Do not substitute the already-authenticated dashboard for a new-workflow login proof.

## Evidence run — 2026-10-05 checks only

- James answered the relaunch question with **keep other sessions running; continue checks only**, superseding its pending state above. No installation or existing-app quit was attempted.
- The exact staged-app-path macOS log query returned exit 64 and `log: Cannot run while sandboxed`. This proves a restriction on this session's diagnostic command environment, not the cause of the app's failure to become ready. Evidence: `_scratch/saved-login-launchservices-os-metadata.json`.
- All four existing startup-monitor/bootstrap/main-entry test files passed the targeted rerun, including detached synthetic-process readiness/failure/cleanup behavior. Actual exit zero: `_scratch/saved-login-checks-only-startup-monitor.log`; raw log: `_scratch/test-run.pid-77310.log`. No code/test changes were made. Synthetic readiness does not count as packaged startup or saved-login sign-in.
- Reviewed source fingerprints remain unchanged. Actual installed approval, denial, session wake, secure Windows fill and new authenticated-page evidence remain pending. Preserve the existing authenticated tab and all current sessions.

## Evidence run — 2026-10-06 plan queue

- The reviewed code now sits on the base branch (landed inside commit `4ca6ef366`, "provider hardening"). In the clean queue worktree, all 98 source and test files covered by the passing independent review match their recorded SHA-256 fingerprints exactly, so the staged replacement package above still corresponds to the base-branch code.
- Agent-runnable checks rerun in the queue worktree all exited zero: the 44 reviewed test files (628 tests), main and spec type-checks, full lint, LOC ratchet, and the IPC/alias/architecture generators plus contracts-alias check with no drift. Evidence: `_scratch/saved-login-queue-*.log` in the root checkout.
- The plan's Task 1 live-refusal baseline item moved into section 2 above. No installation, relaunch, vault read, fill or credential decision occurred. James's checks-only direction still holds, so every item in sections 1–3 stays open.
