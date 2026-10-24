# Phase E: deployed live validation

Status: pending. Prerequisites: coordinator integration and independent verification, a safely rebuilt/restarted Harness and matching worker, signed-in disposable provider sessions, and a phone build for check 6. The worker does not restart/control the running Harness, publish a phone build, force real accounts into a usage limit, or make purchase/delete submissions. No new feature flags are required. Source-level checks remain in [history](2026-10-20-oct2-phaseE-calm-screen_history.md), not deferred here.

Plan: [Phase E](2026-10-20-oct2-phaseE-calm-screen_plan.md).

Remediation flow: read [the live-test campaign runbook](livetest-campaign-runbook.md) before execution. Record a reproduced defect as a new `LT-NNN` item in [the remediation register](livetest-remediation-register.md), with the matching implementation-status section in the remediation plan specified by the runbook (AGENTS names `2026-07-19-livetest-failure-remediation-followup_plan.md`). Keep per-check evidence here. Rename this document `_livetest_completed.md` only after all checks pass. Never amend a completed document to add new campaign work.

All browser work starts through the AIO Browser Gateway with worker/channel preflight and explicitly targets `windows-pc`. No Mac browser or desktop fallback is authorised. In this unattended queue run, an unavailable Windows worker blocks browser checks; record the actual health result and continue non-browser checks. The Harness desktop itself is a hard-denied computer-use target. Use an authorised web renderer/disposable browser page or James's observation for native desktop checks.

## 1. A naturally reported usage limit

- [ ] In a disposable signed-in Claude session which naturally reaches a limit, inspect the notice in the rebuilt app. Expect one account-specific plain message, its allowance window and reset time; more than twelve hours away also includes day and date. `rejected` and `seven_day` must not be prominent copy. Raw diagnostics remain behind Details. Account switching uses the existing account control and must not replay the original request.

Why live: unit tests can seed the provider event, but cannot establish what a real deployed provider currently reports for an actual account without that external state. Do not create expensive work to exhaust the allowance.

## 2. A normal native launch

- [ ] James safely restarts the independently verified build. With normal configured providers/local models healthy, expect the title bar to retain quota and notifications and hide healthy startup/local-model chips. A genuinely missing configured provider remains actionable, while an unused optional CLI is disabled. Each attention check opens the matching existing fix surface.

Why live: seeded component/probe tests and Angular production build run in-loop; the installed native process, real installed CLI inventory and real startup state require a rebuilt/restarted app.

## 3. A real tool turn and failed-edit warning

- [ ] In an expendable git folder, ask a disposable session to read files, run a harmless no-match search and edit a file. Expect the one-line end-of-turn note, neutral search exit status, sensible plurals, and an actual per-turn file comparison which opens the review surface. The tool group retains its expand control and failure count.
- [ ] Use a disposable intentionally denied/unwritable test file to obtain a genuine failed edit, then allow a normal text reply without interrupting. Expect the warning to name the unrecovered path and say to check the summary. A later successful write to that path clears that warning. Never use private/protected user files for the exercise.

Why live: message/summary/DOM and git-boundary tests run in-loop; this checks deployment wiring against the native CLI's actual event stream.

## 4. Failure and interruption continuation

- [ ] Observe a genuine disposable failed turn. Expect a calm failure notice, closed Details and Copy error. Try again sends exactly `Continue from where you stopped. Check which actions already completed before retrying anything.`; it does not replay the old prompt. An automatic retry displays the reported countdown in the working row.
- [ ] Stop a disposable turn, leave the composer empty, and Continue. Expect the short visible continuation and preserved historical context, including the last 8 KiB of partial output, in the hidden input context. Existing replay/compaction context must also survive. A second interruption offers Continue again; a newer active question must not. Inspect diagnostic field names/counters only, never log private prompt text.

Why live: transport, state, queue generation and component tests run in-loop; native provider cancellation/resumption and deployed event ordering require the rebuilt process and real provider.

## 5. Native question and approval cards

- [ ] Ask a disposable session to issue a question. Type an exact choice in the composer, then use another question with a free-text answer. Expect the waiting question to consume each answer and a short receipt afterwards. A permission card must never consume ordinary composer text as approval.
- [ ] On a harmless disposable Windows page, request a browser click/typing approval. Expect the plain action, actual reason where supplied, website/computer, closed technical Details and truthful scope buttons. Verify publish/delete phrase gating using a harmless fixture; do not execute a real destructive or purchase action. Check saved-login duration wording using the secure credential-access flow, without recording credentials.

Why live: seeded card/registry/DOM and scope tests run in-loop; the real provider/browser request lifecycle and secure saved-login channel require rebuilt app/worker processes and authorised external sessions. CLI once-cache semantics belong to Phase A Step 12 and must be integrated before claiming combined CLI/browser once behaviour.

## 6. Phone and lock-screen widget

- [ ] Build and install the verified mobile source through its normal phone pipeline. Check working, thinking, question, permission, restart, asleep, stopped and problem states, including the lock-screen widget. A question reads Needs your answer; only a permission request reads Needs your OK. Compare colours and labels with the desktop presenter.

- [ ] With the phone app suspended, verify actual APNs Live Activity updates carry the optional display label/tone and the final status. Check expanded, compact and minimal lock-screen/Dynamic Island views.
- [ ] Restore an activity created by the older phone build, without the two new optional fields. Expect successful decoding and the legacy label/colour fallback. Do not publish a build from this coding-worker task.

Why live: mobile source/parity checks run in-loop. Device installation, a signed widget build, push registration and lock-screen rendering require the phone release pipeline and a device. No release is authorised by this coding-worker task.

## 7. Usage explanations and native diagnostic samples

- [ ] In the rebuilt app, open Costs on the computer holding the Claude records. Expect the seven-day card to progress from Reading to measured results, show only causes at or above 10% of the actual share, and state that the figures are cost-weighted estimates from this computer. Usage from other computers and Claude apps is outside its coverage. A model/effort record that cannot be measured must say so.
- [ ] Open a Claude session's Status and usage disclosure. Expect that session's report, and confirm opening another session closes the disclosure and cannot retain the previous session's results. Exercise Compact first (preview only), Chat size cap, Helper settings, Scheduled jobs and Context details where offered. No real caps setting exists on this base for big tool results; that button awaits Phase D's control.
- [ ] Run one disposable Claude turn at Max effort and inspect field names/counters only in the new attribution record. Expect the effort and provider-session identity captured for that turn, even if settings change while late usage arrives. Attribution is enabled by default; an explicit `AIO_COST_ATTRIBUTION=0` or `false` opts out and must produce honest missing-effort coverage rather than guessed data.
- [ ] Against a disposable deliberately broken tool-server configuration, obtain a real deployed Codex diagnostic sample. Expect one plain tool-server message per turn/category, the server's safe display name where available, and timestamp-free raw details only under Details. Restore the disposable configuration afterwards.

Why live: bounded scanner/parser, real local transcript shape/count checks, seeded cards, routing and attribution capture run in-loop. These checks concern the rebuilt native event stream, installed account profiles and worker/app tool-surface compatibility. They require the deployed build and external provider state; no credential values or private transcript text should be recorded.

## Evidence

Pending deployed checks. No Mac browser/desktop or real provider/credential action was used by the worker. No independent-verifier PASS or live success is implied by this document.
