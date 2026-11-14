# Cursor empty-completed investigation: pending current-provider checks

Status: all checks DONE; re-confirmed 2026-11-14 (see "Evidence run — 2026-11-14"). Check 3's real
output-storage -> `HistoryManager.archiveInstance` -> `loadConversation` -> miner path was run on 2026-11-14
after a verifier found it missing (see "Verifier round 1 follow-up — 2026-11-14"). Checks 2 and 3
first done 2026-11-10 (see the plan's Status and its history file). Cursor tool
access returned on the existing account; a failed native read and a failing shell command were
captured, traced through the real adapter, hidden-outcome archive assembly and the miner, and pinned
by `acp-cursor-captured-failure-shapes.spec.ts`. No discarded failure signal, so no production fix.
Nothing remains deferred. The older sections below are historical.

This document records pending acceptance, not permission to close the active investigation by
deferral. No scope reduction or completed status is assumed. The exact scratch-sweep case passed
alone during review-round-2 resumption, but that does not clear the verifier's full-suite failure.

Prerequisites: a current Cursor ACP session that completes `initialize`,
`authenticate { methodId: 'cursor_login' }` and `session/new` against the existing authorized account;
an isolated workspace and profile. The 2026-11-03 attempt completed startup on the existing account,
but every prompt returned "Upgrade your plan to continue" before tools. Tool access on that same
authorized account remains a prerequisite. The exact subscription/model/billing cause is unknown;
do not assume a purchase is required. Automatic browser opening on the Mac remains disabled.
A rebuild/restart is not required for the current adapter-only diagnostic; a future implementation
must be rebuilt before app acceptance. No new account or permission override is authorized.

Plan: [active investigation](2026-10-27-cursor-empty-completed-investigation_plan.md).
Remediation flow: read [campaign runbook](livetest-campaign-runbook.md). Register only a genuinely
reproduced defect in [the register](livetest-remediation-register.md), with observed behavior,
root cause, required behavior and acceptance. Follow the current plan lifecycle: record new
implementation status in an active follow-up; do not append new scope to the completed July plan.
Keep per-check evidence here. Browser work goes through the healthy `windows-pc` gateway;
the runbook's old standing-Mac-fallback wording is superseded by current AGENTS.md.

## 1. Authenticated startup without changing accounts — verified 2026-11-03

- [x] Complete normal Cursor ACP startup on the existing account.

Current evidence: status exit 0 with user information, followed by genuine successful `initialize`,
`authenticate` and `session/new`. No login or credential replacement was needed. See
[the current receipt](2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-current/probe-receipt.json).
The October startup failure's root cause was not established and is not claimed fixed. The older
instructions below apply only if authentication regresses; a fresh login is not needed now that
startup succeeds. Current work is blocked later, on tool access.

From the queue worktree, check the CLI version and run `rtk proxy cursor-agent status --format json`
through an in-memory redactor that retains only status/token-presence booleans and whether user
information exists. Do not print raw status output or token values. Local token presence alone
does not prove authenticated access. Read the 2026-10-31 production-timeout error receipt before
retrying. Do not retry the unsupported skip-auth diagnostic.

Use project credential references, then the shared mirror and Bitwarden if credentials are actually
needed, following the documented scratch-CLI route. Preserve the existing account. If the evidence
establishes a fresh browser login is required, preflight `windows-pc` and use the gateway's secure
credential-fill/approval routes. Do not type credentials, open a local browser, or infer approval.
The October classification receipt confirms a browser login was requested, without retaining the
OAuth URL. The safe Bitwarden lookup found no Cursor item. The Windows browser redirected a
task-opened login page to `/agents`, but its account identity and a CLI consent were not verified;
the tab was closed. Establish that the web account matches the existing CLI account before any
login consent. Use the gateway's approval mechanism for that consent. No consent approval has been
requested or supplied by this run. Do not assume that a web login proves CLI authentication, that
the stored tokens expired, or that a human must repair an untested underlying technical problem.

Expected: `initialize`, `authenticate` and `session/new` all succeed on the existing account.
Failure is inconclusive and leaves the remaining checks open. This cannot be verified with mocked
provider success or by changing global permission/account settings.

## 2. Capture bounded genuine provider failures and controls

- [x] Retain current read/permission-failure tool-update shapes, including any explicit signal (2026-11-10: read and shell captured; no permission request was issued).

Resume condition: genuine tool access on the existing authorized account. The original three-prompt
attempt ended; the current instruction to continue authorized one new bounded read attempt, which
again returned the upgrade message. An unanswered historical process question is not a permanent
approval gate for authorized diagnostics. Further identical prompts without changed access would
add no useful evidence. No account, billing, login or permission change is authorized, and no answer
to a scope/account decision may be inferred.

The small diagnostic retained at `_scratch/cursor-empty-probe.ts` in the queue worktree observes
the actual adapter's JSON-RPC input and emitted messages without changing them. Review it before
rerunning. It disables automatic browser opening, keeps its compile cache/workspace in
`_scratch/cursor-empty-runtime`, rejects every permission request, and bounds each startup request to 60 seconds
and each of three prompts to 90 seconds. It uses an Electron path stand-in solely to isolate local
archive/output storage and disables automatic native-history import; it is not a rebuilt app UI test.

Run with a NEW evidence attempt directory so old evidence is preserved:

```sh
rtk proxy npx tsx _scratch/cursor-empty-probe.ts /Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-cursor-empty-completed-investigation_evidence/next-authenticated-attempt
```

Do not set `PROBE_SKIP_AUTH`. Do not use force, trust, approval, sandbox overrides or global rule
changes. Stop if a sign-in flow would be required; do not let a CLI open the Mac's browser.
The prompts request, separately: one native Read of a nonexistent disposable file, one harmless
shell command whose permission is rejected, then one invalid-option shell command and its corrected
form. If the last pair requires permission, reject and stop; do not grant permission just to force
the pair. At most three candidate prompts are authorized by this bounded procedure.

Expected: real terminal updates linked to their real tool calls and known filesystem/permission
outcomes, redacted while retaining status, key names, content presence, exit codes and correlation.
Keep raw wire strings only in memory; only redacted receipts survive cleanup. Normalized messages
are temporarily persisted in the disposable profile to exercise real archive/reload. Preserve empty
strings as empty. Never inject a status, fabricate error text, suppress real output or conclude
failure merely because a completed result is empty.

Why pending: the provider accepted three prompts on 2026-11-03, but returned the upgrade requirement
for each before any tool call. That response cannot replace genuine failed-tool evidence. Do not
send more candidates in this attempt or change account/billing/permission settings to force tools.
Resume once tool access on the existing authorized account is available; James owns any decision
to change the account or billing. Neither an access response nor the old authentication rejection
proves the historical tool report unreachable.

## 3. Follow actual outcomes through archive and miner; fix only with evidence

- [x] Compare actual adapter emissions with persisted/reloaded history and execute the miner (2026-11-10; real `HistoryManager` archive/reload added 2026-11-14, see "Verifier round 1 follow-up").
- [x] Implement, verify live and add regressions only if a genuine discarded signal is established (none established; regression spec added).

For captured events, correlate provider `toolCallId` to emitted `tool_use`, visible `tool_result`
or hidden `tool_outcome`. Use the production output store and `HistoryManager.archiveInstance` /
`loadConversation` on the isolated profile, then execute `extractToolInvocations` and
`mineCorrections` on that reloaded transcript. The retained diagnostic performs those steps only
after startup succeeds and produces `archive-and-miner.json`. The 2026-11-03 artifact exists, but
contains only prompts and upgrade replies: no tool outcomes. It does not satisfy this check.
Verify that hidden outcomes stay out of the visible buffer, enter the archive once, and leave the
side store after archival. Do not claim the diagnostic manually routing hidden outcomes proves the
complete `InstanceCommunication`/renderer path; verify that path in a rebuilt isolated app if changed.

Expected: explicit failed status/nonzero exit evidence is retained as an error, cancellation does
not become success, non-command reads are excluded from mining by design, and an eligible genuine
shell fail/fix with classifiable error text yields the expected correction. A denied shell with no
classifiable output may yield no correction legitimately. Distinguish that from loss of a real signal.
If the provider supplies no failure indicator, document the provider limitation; do not infer one.
Only add regression expectations after verifying any fix against genuine current runtime events.

Why pending: the real text-only archive reloaded with six unique messages and the real miner returned
zero invocations/corrections. No tool event occurred, so failure preservation, hidden-outcome
archival and eligible shell-correction mining remain untested. Local focused tests cannot establish
those external facts.

## 4. Complete verification and cleanup

- [x] Run focused tests and fast/static gates for the current investigation (2026-11-03).
- [x] After a genuine implementation, repeat the applicable gates; coordinator runs the full
  canonical suite and independent completion gate. Do not rename this plan or live-test document.
  (No production change was needed; only the regression spec exists. The seven project gates and the
  spec were re-run 2026-11-14, all exit 0. The full suite and the independent gate remain the
  coordinator's step.)
- [x] Retain the report, command exits and evidence hashes, terminate only task-owned processes,
  verify their PIDs gone and remove the disposable runtime/cache. Preserve dependencies in the
  worktree and preserve unrelated work.

## Evidence run — 2026-11-14

James's recorded answer: Cursor access is restored; re-run the checks. Evidence is in
`2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-14-rerun/` (hashes in `SHA256SUMS.txt`).

- Check 1 (startup): `cursor-agent 2026.10.22-27dcf5f`; raw ACP `initialize`, `authenticate
  { methodId: 'cursor_login' }` and `session/new` all succeeded on the existing account, with
  `NO_OPEN_BROWSER=1`. No login, no account, billing or permission change.
- Check 2 (genuine failure shapes): same probe script as 2026-11-10, two prompts, both `end_turn`, no
  "Upgrade your plan" text (the plan-limit refusal is gone). Native read of a missing file:
  `tool_call read pending` -> `in_progress` -> `completed` with no `rawOutput` and no `content`;
  the model alone reported "File not found". Invalid-option shell: `tool_call execute` -> `in_progress`
  -> `completed` with `rawOutput.exitCode 1`. Zero `session/request_permission` requests. Identical to
  the 2026-11-10 shapes, so the conclusion stands: the provider sends no failure signal for a failed
  native read, and nothing is discarded by the adapter.
- Check 3 (adapter, archive, miner): `acp-cursor-captured-failure-shapes.spec.ts` (3 tests, real adapter,
  side-store/archive assembly and miner over the captured shapes) passed, exit 0. No new shape appeared,
  so no new fix or regression is warranted.
- Check 4 (gates): `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints,
  build:main, build:renderer) exit 0 on the Windows PC in 2m 8s. Provider PID verified gone; the
  disposable workspace was removed. The full suite was not run (coordinator's job).
- Still not captured, and not claimed: a cancelled tool call and a permission-request shape (this account
  issues no permission requests), and an eligible shell fail->fix pair with classifiable error text.
  These are provider behaviours this account does not produce, not work James must do.
- No dev app was launched: this is an adapter-level diagnostic with no UI or rebuilt-app dependency, so there
  was nothing to stop. No defect reproduced, so nothing was added to the remediation register.

## Verifier round 1 follow-up — 2026-11-14

A verifier correctly noted that check 3 required the captured outcomes to go through the production output
store and `HistoryManager.archiveInstance` / `loadConversation` before mining, and that the earlier spec only
called `getCompleteInstanceMessages` with a mocked store. Closed by a new spec,
`src/main/cli/adapters/acp-cursor-captured-failure-archive.spec.ts`. Evidence in
`2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-14-archive-reload/` (hashes in `SHA256SUMS.txt`).

- The spec replays the two captured wire shapes (failed native read; shell `exitCode 1`, same as
  `2026-11-14-rerun/wire-shapes.json`) through the real `AcpCliAdapter`. Only Electron's `userData` path is
  replaced, by a temp dir. Nothing else is mocked.
- Hidden `tool_outcome` goes to the side store, as `InstanceCommunication` does; the visible buffer contains none.
- The early part of the transcript (prompt, read `tool_use`, shell `tool_use`) is written to real disk chunks
  with the real `OutputStorageManager`; the tail stays in the buffer. `archiveInstance` returned `'archived'`
  and wrote `<entry>.json.gz`.
- A fresh `HistoryManager` instance then loaded that gzip file with `loadConversation`. Reloaded transcript:
  unique ids; exactly one `tool_outcome` (read, `is_error: false`); two `tool_use`; the shell `tool_result`
  with stderr, `(exit code 1)` and `metadata {exitCode: 1, is_error: false}`. The side store was empty after
  archive.
- Miner on the reloaded transcript: `extractToolInvocations` returned the one shell invocation
  (`isError: false`, as the shared exit-code rule gives); the read is not minable; `mineCorrections` returned [].
  This matches the live-provider conclusion: no failure signal is lost after the wire.
- Sensitivity check: with the `recordToolOutcome` step removed, the spec fails (`expected [] to have a length of
  1`, `archive-spec-mutation-fail.log`), then the file was restored and re-run green. Final run: both
  captured-shape specs, 4 tests, exit 0 (`both-specs-final.log`). `npm run checks` (typecheck, typecheck:spec,
  lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer) exit 0 (`checks.log`).
- Still not covered, and not claimed: hidden-outcome delivery through the real `InstanceCommunication` and
  renderer in a rebuilt app (no production code changed, so none is needed); the full suite (coordinator).

## Evidence run — 2026-11-03

Review-round-8 response evidence is in
`2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round8-remediation/`.
All 20 hashes in the latest prior-resume seal matched before root-document edits. Its genuine
two-message archive/miner receipt and upgrade response remain evidence of that earlier access
response only. The earlier three-prompt run and later single-prompt run are separate attempts,
four historical prompts altogether; this resumption adds zero. Checks 2–3 still hold substantive
unmet acceptance, not permissible completion deferrals. The same-account tool-access prerequisite
remains unestablished; no purchase, account repair or additional process approval is inferred.
The current instruction already authorizes routine bounded diagnostics. Older statements below
requiring an unanswered process confirmation are historical, not current gates.

The focused checks and fast/static gates have separate fresh exit receipts. No full suite is run
by this worker, as instructed, and no product/test/generator changes or builds are made. A fresh
independent reader could read documents but its shell commands were denied, so no independent
completion PASS is claimed. Cleanup and final check results are in the report and receipts.
The root plan and this procedure remain untracked and unrenamed. The coordinator's tracked
worktree duplicates and their checkpoint history were not changed; they must be excluded from
the eventual landing tree while active. No completion-by-deferral or ready-for-verification
signal is intended by this blocked handover.

Review-round-6 remediation evidence is in
`2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round7-resume/`.
One new native missing-file read was dispatched using the existing account and actual adapter.
Startup passed; the provider returned exactly `Upgrade your plan to continue`, with zero tool
updates and zero permission requests. The genuine two-message archive reloaded uniquely and the
actual miner returned zero invocations/corrections. This confirms the current access response,
not a tool failure or its preservation. The provider PID was verified absent. Checks 2–4 remain
open. No account/billing action, production patch, regression expectation or completion is claimed.
The prior three-prompt and zero-new-prompt notes below describe earlier attempts only.

Review-round-4 evidence is in
`2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round4-resume/`.
No new provider prompt was sent. Confirmation of restored access and permission for one more bounded
attempt were requested, with no answer received at handover. Checks 2–4 remain open; this document
does not authorise reusing the spent allowance or closing the plan by deferral.

An additional read-only check of 26 existing Cursor archives found 358 hidden outcomes and ran the
actual miner over the original decoded messages: 524 command invocations, 36 error flags, ten
classifiable errors and seven correction candidates. Retained evidence contains only counts,
error-class enums, booleans and checksums, not commands or conversation strings. No `rawOutput`
metadata was present. This supports historical archive/miner behavior, but does not capture the
missing current-provider failure shapes or replay their normalization and archival. Original
acceptance item 3 therefore remains partial. Live history was not changed or copied.

The focused tests and all five fast/static gates passed with fresh command receipts. No full
suite, builds, new regression, product change or generator update was performed. The independent
reader's review is limited (its Git tool calls required approval) and is not an acceptance PASS;
the parent worker checked the actual branch diff directly. See the report/seal/cleanup receipt.

Review-round-2 resumption re-read the receipts and verified all 22 inherited seal hashes before
updating the root documents. Its separate report, command receipts and seal are in
`2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round2-resume/`.
No new provider run or product/test change occurred. The main plan remains one of five items
complete, with checks 2–4 here still open. Focused/static evidence cannot replace genuine provider
events, and an isolated test pass cannot clear a failed full-suite gate.

Authenticated startup passed. Three prompts returned exactly "Upgrade your plan to continue";
zero tool updates and zero permission requests arrived. Real output storage, archive/reload and
miner calls ran, but only on text-only turns. Focused tests and all five fast/static commands passed;
see `2026-11-03-current/check-receipts.json`. No product/test changes, defect register entry, generator
update, build, full suite or independent PASS is claimed. See the active plan and the current evidence
report/seal for the boundary and cleanup record. All genuine tool checks above remain open.

## Evidence run — 2026-10-31 (historical)

The provider/archive/fix behavior checks remain open. Real startup receipts and passing local verification
are linked from the active plan. Current authentication failed before every proposed tool prompt.
The production-timeout attempt's PID was verified gone and runtime/cache removed. No product fix,
new regression, current archive/miner result, full-suite result or independent PASS is claimed.

> Closure history: `2026-10-27-cursor-empty-completed-investigation_livetest_history_9a50f33b3db283222d089a852e63a5ea487d0b92c7e1489f975b8c76ee545109_completed.md`.
