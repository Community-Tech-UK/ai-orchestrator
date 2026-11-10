# Cursor empty-completed outcome investigation

On main: the regression spec only; no production change was needed.

## Status

On main: yes (this landing commit)
DONE pending the independent gate (updated 2026-11-10). Cursor tool access came back on the existing
account (no account or billing change). Captured real wire shapes: a failed native read ends
`completed` with no `rawOutput` or `content` (the "File not found" reached only the model, so the
provider sends no failure signal); a failing shell ends `completed` with `rawOutput {exitCode: 1,
stdout: '', stderr}`. The real adapter keeps the exit status and stderr, and the shared rule treats a
non-check exit as neutral by design. The read yields a hidden `is_error: false` outcome, archived
once. The miner correctly returns nothing. No discarded failure signal, so no fix; a 3-test
regression spec pins the shapes. Checks pass (typecheck, spec typecheck, lint, size, UI hints, both
builds, 7 focused files). Not captured: cancelled call, permission-request shape. Evidence:
[history](2026-10-27-cursor-empty-completed-investigation_plan_history_e68c51b1cb581e64d56eb1a9813578da11a8cff468e69851455cc87fc1ce1108_completed.md). Sections below are old rounds.

Source: the [agent-runtime residual report's 2026-10-04 batch C observation](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-007--inconclusive-leaning-towards-retirement-copilot-not-run).
The cited raw receipt is missing and the `LT-711` citation in the original plan is unresolved. No
standalone linked spec exists; this plan's evidence condition is the investigation contract.

- [x] Record the attributed historical report and distinguish missing proof from verified behavior.
- [x] Capture bounded genuine current Cursor read/permission failures and retain redacted wire shapes (read and shell captured 2026-11-10; no permission request was issued).
- [x] Trace adapter normalization, archived outcomes and the executing correction-miner result.
- [x] Fix only if an actual discarded failure signal is established; verify live, then add regressions (none established; regressions added).
- [x] Run the canonical gates and independent completion review for any implementation (gates run by the worker; the independent review is the coordinator's step).

Do not inject status/output or infer failure solely from empty completed content. No account,
billing change, permission override or global rule change was made.

## Review round 8: blocked handover, not a completion signal — 2026-11-03

This round is historical; the Status block at the top is current. The supplied worktree started
clean at `a6cfce3c9`. Its diff from the main merge-base adds only the active plan and live-test
copies committed by previous queue checkpoints. The authoritative documents remain these root
originals, both untracked. The worktree copies contain later review notes, which were read rather
than copied over these originals. No branch, index, commit or document filename was changed.

| Round-8 verifier finding | Disposition and exact remaining work |
| --- | --- |
| 1. Four unchecked acceptance items | Unresolved. The original checklist is still 1 of 5 complete. Neither the request to fix findings nor passing checks supplies the missing acceptance evidence. |
| 2. No genuine current failed-tool capture | Unresolved. The latest retained probe receipt records one prompt, the exact upgrade reply, zero tool updates and zero permission requests. Its real archive/miner receipt contains two text messages and no invocations or corrections. No restored tool access is established, and this resumption did not repeat an identical prompt. |
| 3. No implementation/regressions; substantive work in live procedure | Unresolved. There is no captured discarded failure signal on which to base a fix. Live checks 2–3 remain original acceptance work. They cannot be deferred to declare the investigation complete. Once genuine events are available, trace those same events through normalization/archive/mining, implement only any demonstrated fix, verify it at runtime and then add regressions. |
| 4. Active documents committed by checkpoints | Confirmed, not repaired. Root originals remain untracked; no active document was staged or committed by this worker. The coordinator must keep the two duplicate active documents out of the eventual landing tree. It can omit them during integration or remove them in a later checkpoint; rewriting old commits is not technically necessary. This worker edits the designated documents only at the root and does not commit, rename or alter the coordinator's tracked copies. |

### Evidence and next prerequisite

Every one of the latest retained prior-resume seal's 20 hashes matched before these edits,
including its probe, wire shapes, archive/miner receipt, executing diagnostic, check logs and root
documents. This validates the retained bytes, not current provider access. Earlier three-prompt
and later one-prompt attempts are separate: four historical prompts in total, all before tool
execution, and zero new prompts in this resumption. No account, billing, login or permission
change was made. The exact reason for the upgrade reply remains unestablished.

Continuation needs evidence of usable tools on the existing authorized Cursor account. Routine
bounded diagnostics remain authorized by the current task; no old unanswered process question
creates a new approval requirement. Changing the account or billing is a separate authority
boundary. Do not prescribe a purchase, infer an expired login or label this a provider outage.
Another unchanged verification round cannot supply the missing genuine tool events.

Fresh local checks, command exits, logs, evidence recheck, report, seal and cleanup are retained in
[round-8 remediation evidence](2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round8-remediation/).
The independent reader used the task-completion-gate skill but its shell commands were denied;
its document-only opinion is not an independently executed gate or PASS. Parent Git commands
succeeded. No full suite is run by this worker, as expressly instructed. No product, test,
dependency or generator input changed, so no generator refresh or builds are warranted.
Original acceptance and independent completion verification remain open. Final command and
cleanup results are recorded in the evidence report and receipts; no completion claim is made.

## Review round 6: fresh provider check and actual disposition — 2026-11-03

**Not ready for acceptance. One of five original items remains complete.** This section supersedes
the earlier current-state summaries. The supplied branch started clean at coordinator checkpoint
`31ef5ea83`; its merge-base diff contains only the two investigation documents. The latest worktree
notes also leave four acceptance items open. They were read without copying or changing them.
Only the designated root documents are edited; they remain untracked. No commit, stash, branch
change, worktree creation, staging or completion rename is performed.

### New bounded evidence, rather than another inferred access decision

The current user instruction explicitly authorizes continuing the investigation and resolving
routine evidence gathering. The historical exhausted allowance is not a permanent new approval
gate. This resumption therefore made **one** fresh bounded native missing-file read on the existing
authorized account, using the actual adapter and a disposable worktree-local workspace/profile.
No account, billing, login, permission, global setting or provider message was changed. Automatic
browser opening stayed disabled, and every permission request would have been rejected.
The same diagnostic's unused shell probes were removed before running it.

`cursor-agent 2026.10.22-27dcf5f` completed normal authenticated startup. At 13:10 UTC the single
prompt again produced exactly `Upgrade your plan to continue`, with **zero tool updates and zero
permission requests**. The provider process exited and its PID was confirmed absent. This is a
fresh current observation, unlike the inherited three-prompt receipt; it establishes no specific
subscription, quota, billing or authentication cause. No additional prompt is useful without a
change in tool access, so this attempt stopped there.

The real output store and archive/reload ran on the two genuine text messages. The archive contained
two unique messages; actual invocation extraction and correction mining both returned zero.
There were no hidden outcomes to route or persist. These observations do not satisfy the genuine
tool-failure, failure-preservation or shell-correction requirements.

| Round-6 verifier finding | Actual disposition |
| --- | --- |
| 1. Four acceptance items unchecked | Unresolved. The original five-item checklist is unchanged; no evidence or requirement was waived. |
| 2. No current genuine tool-failure capture | Unresolved, with a fresh check: one read attempt reached the same upgrade response before any tool call. Tool access on the existing account remains the prerequisite. |
| 3. Documents-only diff and no implementation/regressions | Unresolved. No actual discarded failure signal is established. Inferring failure from empty content or inventing a regression fixture would violate the investigation contract. |
| 4. Live-test deferral cannot close unfinished local work | Confirmed. The live document remains a continuation procedure. After genuine events exist, tracing, any justified fix, regressions and all local verification must run in-loop. No completion waiver is claimed. |

The safe remaining boundary is access to tools on the existing account. This run does not prescribe
a purchase or technical account repair. Decisions to change the account or billing remain James's;
routine bounded diagnostics within the authorized investigation do not require a separate process
approval. Requeueing unchanged local work cannot supply the missing provider events.

### Verification and evidence

Focused adapter/outcome/side-store/archive/miner checks passed before the root-document edits.
Both typechecks, lint, TypeScript-size and UI-hint checks also exited 0; exact commands and full
local-log hashes are in `check-receipts.json`. The full suite is deliberately excluded by the
queue-worker instruction. No product, test, dependency, generator input or generated output
changed, so builds are not repeated. No independent completion PASS is claimed.

Fresh wire shapes, archive/miner results, exact command exits, full local-log paths, report,
seal and cleanup receipts are retained in
[round-6 remediation evidence](2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round7-resume/).
The directory is named for the seventh worker attempt following verifier round 6. The inherited
current-run seal matched 20 of 22 entries: only the two root documents changed by later rounds
differed. The executing source and original diagnostic still matched that seal.
The cleanup receipt records removal of this attempt's isolated profile, workspace and compile/tsx
caches after writing the report, receipts and initial seal. Dependencies and small evidence remain.
No database cluster, browser binary or source-tree copy was created. This is a blocked handover,
not a completion signal.

## Review round 4: actual progress and unresolved findings — 2026-11-03

**Not ready for acceptance or a completion rename. One of five original items is complete.**
The three verifier findings remain unresolved. This worker has not substituted passing local
checks, old archived results or a live-test deferral for missing current-provider evidence.
Resume requires usable tool access on the existing authorized Cursor account and a fresh bounded
prompt allowance. The question requesting confirmation and one further bounded attempt has no
answer at this handover. No approval is inferred and no account or billing repair is prescribed.

Read `git log` and the base diff before investigating: supplied HEAD `43723e3b9` includes the
coordinator's round-4 checkpoint; `git diff main...HEAD --name-status` lists just the two active
investigation documents. The authoritative documents remain the root originals at this path,
both confirmed `??` by root-checkout status. The coordinator's tracked worktree copies contain
additional prior notes; they were not copied, edited, renamed or untracked by this worker.
No product, test, manifest, lockfile or generator change was made. No commit or branch action occurred.

### Additional genuine archive evidence, with limits

A fresh independent reader suggested checking already archived Cursor conversations. Its Git
commands were refused by its own tool channel, so its review is limited and is **not** a gate PASS.
The parent worker's Git commands succeeded. The suggested archive route was then checked directly,
read-only, without sending prompts, logging in, opening a browser or changing the live history.

The installed app's history contained 26 Cursor archives. Direct gzip decoding found 4,316 tool-use
messages, 3,989 visible tool results and 358 hidden tool outcomes. No tool metadata in these
archives retained `rawOutput`. The actual repository `extractToolInvocations` and `mineCorrections`
functions then ran on the unchanged decoded messages: 524 command invocations, 36 marked as errors,
10 classifiable errors and seven correction candidates. All 358 hidden outcomes had a false error
flag. These counts describe archived messages, not a fresh provider capture. Commands, account
details, IDs and conversation strings were neither printed nor copied into retained evidence.

This supplies genuine historical archive/miner execution beyond the earlier text-only diagnostic.
It does **not** verify the missing native-read/permission-failure shapes, explain a false hidden
outcome, prove that an error signal was discarded, or replay current archive creation/side-store
cleanup. A classifiable message or a correction candidate alone is not proof of that reported bug.
The original item 3 therefore has additional partial evidence but stays open until the same
captured provider events are correlated through normalization, archival and mining.

| Round-4 verifier finding | Actual disposition |
| --- | --- |
| 1. Four original acceptance items remain unchecked | Unresolved. Original checklist retained; plan explicitly blocked and not ready. |
| 2. No genuine current Cursor failure capture | Unresolved. Re-read probe receipt: three upgrade replies, zero tool updates/permissions. No further prompts sent. Existing archives cannot restore raw wire shapes. |
| 3. Documents-only diff; external prerequisite unresolved | Unresolved. No defensible product change or regression expectation is established. Live procedure remains open, not a completion waiver. |

### Current verification and handover

Focused adapter/material/miner/side-store/scan/history/restore tests passed with the pinned project
Node runtime and cache disabled. Both typechecks, lint, TypeScript-size and UI-hint checks exited 0.
Full suite was not run, as explicitly required for this queue worker; builds were not repeated
because no product implementation changed. No previous full-suite failure is claimed cleared.
No generator input changed, so there is no generated output to refresh. No independent acceptance
PASS is claimed. Another completion review cannot supply the missing provider events.

Report, exact command exits, log hashes, redacted archive/miner counts, inherited-evidence checks
and cleanup receipts are retained in
[round-4 evidence](2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round4-resume/).
Before these edits, all ten round-2 seal entries matched. The older current-run seal matched 20
of 22: only the two documents changed by round 2 differed, as confirmed by that later seal.
After writing the report, receipts and initial seal, remove only this worker's disposable
compile/tsx runtime; retain dependency installs and small evidence. Final cleanup is recorded in
`cleanup-receipt.json`. No provider process, database cluster, browser binary or copied tree was
created. This blocked handover is not a signal that the original investigation passed verification.

## Review round 2: resumption and remaining acceptance — 2026-11-03

The independent verifier's FAIL remains in force. This is **not ready for acceptance**:
one of five original items is complete, and the other four remain unchecked. The live-test
document is a continuation procedure, not a completion waiver. No completion rename is requested.

On resumption, `git log` showed coordinator checkpoint `6d13dee78` on the supplied queue branch.
The merge-base-to-HEAD diff contains only the two investigation Markdown documents, with no
product, test, dependency-manifest or generator changes. That checkpoint includes prior review
notes in worktree copies, while the designated root originals did not contain those notes.
This resumption edits only the root plan/live procedure as explicitly instructed; it neither
copies nor overwrites the coordinator's tracked worktree documents. Both root documents remain
untracked. No commit, stash, branch change or worktree creation was performed.

The preceding current-provider evidence was re-read rather than assumed from the handover.
All 22 hashes in its existing seal matched before editing this plan. The probe receipt records
three upgrade replies, zero tool updates and zero permission requests; archive/miner receipts
contain six text-only messages and no invocations or corrections. This confirms the recorded
limitation, not current tool access or failure preservation. No new provider prompt, login,
account change, billing action, permission override or browser operation occurred in this round.

| Round-2 finding | Actual disposition |
| --- | --- |
| 1. Four original items unchecked | Open. Preserve every acceptance item; passing local checks cannot answer the provider investigation. |
| 2. Genuine tool-failure/archive/miner evidence missing | Open. The three-prompt allowance is spent. Capture genuine events only after tool access on the existing authorized account is available and another bounded attempt is authorized. No production fix or regression is justified yet. |
| 3. External-access boundary cannot be closed by deferral | Open. No deferral closure or scope reduction is assumed. A text-only provider response does not establish why tools are unavailable or prescribe any purchase. James was asked whether access has been restored or the scope should change; no answer is inferred. |
| 4. Scratch-sweep timeout in the verifier's full run | The exact unchanged case passed in isolation with exit 0. No timeout, assertion or production code was changed. The full-run failure is attributed to the verifier; its cause remains unestablished and an isolated pass does not clear the full gate. |

Prior review history was also checked against the retained checkpoint report and JSON results.
Its final pinned-runtime full suite had a different failure: the Local AI Guard restart/routing
case timed out and then passed alone. The installed-runtime run recorded zero failed assertions
but exited nonzero on a source-map/runtime error. Neither is a green full suite, and neither
should be confused with the round-2 verifier's separate scratch-sweep timeout. The prior review
also prepared dependencies locally without changing the manifest or lockfile; those dependencies
are retained. No causal explanation based on machine load is established by these receipts.

Current checks, report, evidence recheck and seal are retained in
[round-2 resumption evidence](2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-round2-resume/).
The exact scratch-sweep case, seven focused adapter/outcome/miner/archive files, both typechecks,
lint, TypeScript-size and UI-hint checks are recorded separately in `check-receipts.json`, with
real exits and full local log paths. The full suite is expressly excluded for this worker and
belongs to the verifier. Builds were not repeated because no product code changed. No generator
input changed. No independent completion PASS or completed fix is claimed.

Remaining acceptance is unchanged: capture genuine provider tool failures, trace those same
outcomes through archive/reload and the executing miner, fix and verify only if an actual discarded
signal is established, and obtain passing canonical/independent gates. Provider access and any
fresh bounded prompt allowance remain prerequisites. This round created no disposable provider,
database, copied checkout, browser binary or compile cache; only small scripts, logs and evidence
remain, with dependencies kept in the supplied worktree.

## Previous worker findings — 2026-11-03 (supersedes the startup blocker below)

### Genuine current runtime result

The current queue checkout is `36d2dba55563858903d7910168f0b64add6dbb05`, with
`cursor-agent 2026.10.22-27dcf5f`. Two bounded status calls returned exit 0,
`isAuthenticated: true`, access/refresh-token presence and populated `userInfo`; only booleans
and field names were retained. The real `AcpCliAdapter` then successfully completed `initialize`,
`authenticate { methodId: 'cursor_login' }` and `session/new`, using the existing CLI account.
No credential lookup or login was necessary, and no browser was opened.

Exactly three prompts were sent: a native missing-file read, a harmless shell command whose
permission would be rejected, and an invalid-option shell command followed by its corrected form
only if execution was allowed. **All three returned exactly "Upgrade your plan to continue"**
(ignoring surrounding whitespace). There were zero tool updates and zero permission requests.
The installed provider's `7096.index.js` maps an `upgrade` action to this assistant text; the
specific subscription, model-entitlement or billing cause has not been established. Do not report
an expired login, exhausted quota, provider outage, or a requirement to purchase a particular plan.
Do not treat this access response as a tool failure. The three-prompt budget is exhausted.

This diagnostic used the actual adapter subprocess/stdio implementation and unmodified provider
messages. An observation wrapper inspected each inbound JSON-RPC line before forwarding it
unchanged. The only Electron stand-in supplies an isolated user-data path; native Claude history
auto-import was disabled. `NO_OPEN_BROWSER=1`, empty client capabilities, no injected MCP servers,
no force/trust/permission override, and reject-every-request handling were retained. The rejection
handler was never exercised because no permission request arrived.

New evidence, preserving the October receipts:
[2026-11-03-current/](2026-10-27-cursor-empty-completed-investigation_evidence/2026-11-03-current/).
`wire-shapes.json` retains initialization/auth/session envelope shapes and redacted normalized
turns. `probe-receipt.json` records the exact allowlisted upgrade response and command exit;
`login-status.json` records the redacted status call; `provider-upgrade-source.json` records the
installed handler excerpt and source checksum. Strings, account details and identifiers were
redacted while preserving empty strings, enum values, numbers, key names and mapped correlations.

### Source tracing, real archive and actual miner execution

The executing path was re-read on this checkout:

- Cursor construction: `src/main/cli/adapters/adapter-factory.ts:534`; normal startup:
  `src/main/cli/adapters/acp-cli-adapter.ts:541`, configured authentication at `:635`.
- Tool-use command input: `acp-cli-adapter.ts:1663`; terminal normalization at `:1720` passes actual
  `rawOutput` to the visible-result helper at `:1764` or hidden-outcome helper at `:1778`.
  `src/main/cli/adapters/acp-tool-call-material.ts:123` recognizes explicit failed status and
  nonzero numeric exit codes, with no inference from emptiness.
- Hidden-message diversion: `src/main/instance/instance-communication.ts:1173`; archive assembly:
  `src/main/history/history-manager.ts:475`; `archiveInstance` at `:168` clears the side store
  after assembly. `src/main/learning/learning-scan-service.ts:192` loads the archive before mining.
- `src/main/learning/correction-miner.ts:133` excludes invocations without command metadata;
  `:309` requires an actual error flag and classifiable result text for a correction pair.

The diagnostic wrote the real visible messages to `OutputStorageManager`, then called the real
`HistoryManager.archiveInstance` and `loadConversation`. The reloaded archive had six unique
messages (three prompts and three upgrade replies). `extractToolInvocations` and `mineCorrections`
both actually ran on it and returned empty arrays. `archive-and-miner.json` retains redacted
messages, the transcript digest, uniqueness and side-store checks. **There were no tool outcomes
to persist or mine.** An empty side store and no correction candidates on these text-only turns
do not verify hidden-outcome routing, failure preservation, cancellation or a shell correction.
The diagnostic manually routes hidden records; it does not prove the complete live
InstanceCommunication/renderer path. Those requirements stay open.

The historical receipt is still absent, the cited LT-711 entry is absent in both registers, and
there is no standalone linked spec. No reproduced-defect register entry, production change or
regression test is justified by the current access response. No completed background spec was edited.

### Checks, decisions and remaining boundary

- PASS: focused baseline, outcome material and correction miner, before the diagnostic.
- PASS: final focused adapter/outcome/miner/side-store/scan/history/restore checks, seven files.
- PASS: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`. Exact exits, full local-log paths and
  log checksums are in `2026-11-03-current/check-receipts.json`.
- Ruling: preserve production behavior because no genuine discarded tool-failure signal was
  captured. Inferring an error from an empty completed result would manufacture evidence.
- Ruling: stop after the bounded prompts. Do not change accounts, permissions, settings or billing
  to force a result. Resume only when the existing authorized Cursor account can execute tools;
  James must decide any account/billing change if that is how access will be restored. No specific
  purchase or technical repair is prescribed by this evidence.
- Full suite, both builds and independent gate were not run: the worker is explicitly restricted
  to focused tests and fast static checks, there is no product implementation to build, and the
  queue coordinator owns independent verification. No independent PASS or completed fix is claimed.
- The tracked worktree is unchanged. Only the root plan/live procedure, ignored small evidence,
  and ignored worktree-local diagnostic scripts/logs were written. No generator input or output
  changed. The evidence report, command receipts and seal record process and runtime cleanup;
  dependencies remain in the worktree. Do not close or rename this plan on these partial results.

Remaining work is precisely [live-test checks 2–4](2026-10-27-cursor-empty-completed-investigation_livetest.md):
capture genuine provider tool failures, trace those actual tool outcomes through archive/miner,
fix only if a discarded signal is established, then obtain the coordinator's completion gate.
The startup-only success and text-only archive/miner check do not satisfy those acceptance items.

## Previous worker findings — 2026-10-31 (historical, retained)

### Historical attribution and scope

The residual report at lines 363–374 attributes empty `completed` read/permission failures to the
2026-10-04 probe. Its `_scratch/lt-2026-10-04/c/AR-007-evidence.md` receipt is absent from the root
checkout. Its 2026-10-05 section retires the separate no-output `failed` fallback clause, not this
report. The assertion that the miner records those historical reads as successes is too broad:
the executing miner excludes non-command tools from invocation extraction. No current regression
or new reproduced-defect register entry is justified by that missing receipt alone.

### Bounded current runtime attempts

Current CLI: `cursor-agent 2026.10.22-27dcf5f`; source checkout:
`6d763d2a1b6d5289e510c077d2f4862d3123941a`. Actual `AcpCliAdapter` subprocess/stdio code was used,
with no status/output replacement. A disposable worktree-local workspace contained one benign
fixture. The planned probes were a native missing-file read, rejection of a harmless shell request,
and a shell invalid-option/correction pair. **None of those prompts was dispatched:**

1. Two initial starts initialized successfully but reached the diagnostic's 25-second
   `authenticate` timeout. These short attempts are preliminary setup evidence only, not production
   timeout evidence. The first CLI wrapper was interrupted after writing its failed-attempt receipt;
   early receipts did not retain the child PID, so their `pidGone` value is not independent PID proof.
2. A diagnostic omitting the optional authenticate call received a genuine `session/new`
   authentication rejection. The installed provider's `7096.index.js` explicitly requires a successful
   `authenticate()` call before `newSession()`. This diagnostic is not a supported alternative and
   does not establish anything about tool outcomes.
3. A final start restored `cursor_login` authentication and the production 60-second request budget,
   disabled automatic browser opening through `NO_OPEN_BROWSER`, and kept the compile cache inside
   the disposable runtime. The provider returned JSON-RPC error **-32602** during `authenticate`,
   before `session/new` or any tool turn. The inner free-form error was redacted. A subsequent
   classification-only attempt retained the boolean fact that its data message begins
   `Failed to open browser for login. Please visit:` without retaining the login URL. Thus the
   current provider enters its browser-login branch. The installed `open-browser.ts` implementation
   honors `NO_OPEN_BROWSER`, so this branch is safely rejected. Why existing credentials were not
   accepted is unresolved; neither expired credentials nor a provider outage is established.
4. `cursor-agent status --format json` exited 0 and reported saved access/refresh tokens and
   `isAuthenticated: true`, but **no user information and a fallback message**. The installed status
   implementation (`752.index.js`, `handleStatus`) returns this authenticated shape even when
   `getMe()` fails. Therefore this is evidence of local credential presence, not successful current
   authenticated provider access. No replacement account/token, global setting, or permission
   override was used. No project-local Cursor credential reference or Cursor-named shared
   credential mirror was found. The documented scratch Bitwarden route unlocked, synchronized and
   searched successfully; it returned no Cursor item, then locked and deleted its scratch copy.
   No secret values or item identifiers were printed or retained in evidence.
5. A plain unauthenticated HEAD to `https://api2.cursor.sh` returned HTTP 200. This does not verify
   authenticated RPCs. Browser Gateway preflight found no suitable Cursor tab on `windows-pc`;
   health reported that worker's extension running, fresh and able to receive commands. The worker
   was not reported offline, and no local browser fallback was used. After the login branch was
   established, the gateway opened `https://cursor.com/login` on that worker and reported a redirect
   to `/agents`. This suggests an existing web login, but neither its account identity nor a CLI
   OAuth consent was verified. No credential was filled or consent submitted. The task-opened tab
   was closed successfully. A fresh same-account CLI sign-in through the secure gateway remains
   unperformed; the existing web session alone cannot authorize or validate a CLI session.

Redacted receipts: [evidence directory](2026-10-27-cursor-empty-completed-investigation_evidence/).
`production-timeout/wire-shapes.json` retains the real initialization/error envelope shape;
`current-wire/wire-shapes.json` records the unsupported skip-auth diagnostic;
`attempt-2/wire-shapes.json` and `wire-shapes.json` preserve the preliminary attempts.
`login-classification/wire-shapes.json` retains the confirmed browser-login branch without OAuth
values; `credential-lookup.json` and `browser-preflight.json` record the safe credential/browser checks.
There are **zero captured tool updates**, not zero tool failures. No archived current-provider
transcript or live correction-miner result was produced. Startup errors cannot validate or retire
the reported tool-failure behavior.

### Executing source path traced; live archive/miner result still open

- `src/main/cli/adapters/adapter-factory.ts:534` creates `AcpCliAdapter` for Cursor with
  `cursor_login`, `cursor-agent acp`, and default empty client capabilities. The diagnostic's
  production-timeout attempt used that authentication/protocol shape without the app's unrelated
  MCP server injection or permission registry.
- `src/main/cli/adapters/acp-cli-adapter.ts:1663` emits command-bearing `tool_use` metadata via
  `buildAcpMinableInput`; non-command Read calls have no minable command. At `:1720`, terminal updates
  produce one visible result if renderable output exists, otherwise the hidden fallback. Actual
  `rawOutput` is passed into the outcome helpers at `:1764` and `:1778`.
- `src/main/cli/adapters/acp-tool-call-material.ts:81` builds hidden fallback outcomes only for
  completed/failed calls with no rendered result. At `:123`, explicit `failed` is an error; completed
  calls are errors only when numeric `exitCode`/`exit_code` is nonzero. Thus an empty completed call
  without another recognized signal currently produces `is_error: false`. That code fact alone
  neither proves the provider failed nor warrants inferring failure from emptiness.
- `src/main/instance/instance-communication.ts:1152` diverts `tool_outcome` into the side store for
  top-level sessions before visible buffer/publication. `src/main/history/history-manager.ts:475`
  merges those outcomes with stored/live messages, deduplicates IDs and sorts chronologically;
  `archiveInstance` at `:168` persists that assembled transcript.
- `src/main/learning/learning-scan-service.ts:192` loads archived messages and invokes
  `mineCorrections`. `src/main/learning/correction-miner.ts:133` extracts only command-bearing
  invocations, correlating both visible results and hidden outcomes. At `:309`, pairing requires an
  actual `isError === true` and then a classifiable error message. A native failed read is excluded
  before either outcome matters; an empty shell result alone cannot produce a correction proposal
  even if its error flag were changed. No failure text or outcome was manufactured to bypass this.

### Verification, decisions and remaining work

- PASS: initial focused baseline (outcome material, miner, hidden restore handling).
- PASS: final focused adapter/outcome/miner/scan/history/restore/context checks, 7 files, 208 tests;
  [command receipt](2026-10-27-cursor-empty-completed-investigation_evidence/focused-check-receipt.json).
- PASS: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`;
  [individual exit-code receipts](2026-10-27-cursor-empty-completed-investigation_evidence/static-check-receipts.json).
- No production, test, package, generator input, or tracked documentation changes. No generated
  output update is required. No fix/regression was added because no discarded genuine failure signal
  was established. That is a scope decision, not a claim that the historical behavior is correct.
- Full suite and independent gate were not run, as directed for this queue worker. Both builds were
  not run because there is no implementation change. The coordinator owns any subsequent canonical
  full verification and document closure. No fresh-eyes PASS is claimed.
- Pending external-service checks are in
  [the follow-up live procedure](2026-10-27-cursor-empty-completed-investigation_livetest.md).
  Source tracing and local checks do not close the live archive/miner requirement. The plan stays
  active with four unchecked top-level items; do not rename or accept this as an implemented fix.
- The tracked worktree remains unchanged. Only the authorized root planning document, live-test
  procedure and small redacted evidence artifacts were written. The disposable runtime was removed;
  the final instrumented provider PID was checked gone. Small ignored diagnostic scripts and logs
  remain in the worktree for the verifier; no checkout/dependency tree was copied. The evidence
  directory is intentionally ignored by the repository's `docs/plans/*evidence/` rule and remains
  locally beside this untracked plan. See `seal.json`
  in the evidence directory for hashes and cleanup evidence.

> Plan Queue parked work: `queue/2026-10-27-cursor-empty-comple-55a026` — 7 commit(s), reason: round-limit.
