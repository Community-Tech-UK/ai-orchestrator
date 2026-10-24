# Browser approval after replacing a chat: installed-app check

Status: pending; not verified in the installed app.

Prerequisites: install/restart a build containing the linked implementation. Use the intended Harness instance and `windows-pc` for all browser work; perform gateway worker and browser-channel preflight first. Do not start or control a local Mac browser. Harness itself is a hard-denied Computer Use target, so the visible approval click belongs to James.

Implementation: [completed implementation plan](2026-10-21-browser-approval-replaced-chat_plan_completed.md).

Remediation flow: [campaign runbook](livetest-campaign-runbook.md). A reproduced new defect must be recorded in [the remediation register](livetest-remediation-register.md) and the active remediation plan, following current instructions. Do not edit a closed `_completed` document; reopen it or create a dated follow-up. Browser-routing instructions in AGENTS.md override older fallback advice in the runbook.

## Check 1: saved-login approval after edit-and-resend

- [ ] In a disposable conversation, send a harmless prompt and then edit/resend it, preserving its old replaced copy. Request access to an existing saved login for an authorised task on `windows-pc` using `browser.request_credential_access` with the live profile, tab and exact saved-login item. Do not include a password in the prompt.
- [ ] James approves the visible request. Expected: it becomes approved without a session-unavailable error, and the current conversation receives the decision notice exactly once. The replaced copy does not resume.
- [ ] The current agent checks the request status and receives `approved`. Stop before sign-in or submission unless that task separately authorises it.

Why deferred: the source checkout tests execute the production resolver and decision notifier, but they do not replace the installed app's main process. This check additionally requires the operator's visible consent decision in Harness, which agents may not control. No real account submission is needed to verify this bug fix.

## Evidence already run locally

The regression failed before the fix for superseded status, a replacement marker with idle status, a replacement marker with hibernated status, and a hibernated current owner. The focused IPC and saved-login suites passed after the fix, including refusal when two eligible runtimes share a conversation. All seven canonical gates and a fresh independent completion review subsequently passed, including a complete unfiltered suite and the real approval-service/SQLite/notifier smoke. Full evidence is recorded in the completed implementation plan. These source checks do not verify the visible installed-app consent click; every live checkbox above remains pending.
