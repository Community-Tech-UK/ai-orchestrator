# Session-linked sidechats — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section in a new or existing active follow-up plan. Do not extend the closed July
> remediation plan. Per-check evidence stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-02-session-sidechats_plan_completed.md](2026-10-02-session-sidechats_plan_completed.md)

**Prerequisites:**

- Rebuild and restart Harness from the branch carrying this work
  (`npm run build:main && npm run build:renderer`, then restart). The sidechat service, its IPC
  channels, the `latest_assistant_sequence` column upgrade and the new panel only load after that
  restart. Do not restart Harness while James has live sessions (build first, let James restart).
- Every check below needs **real provider turns** (paid model calls on James's accounts) or the
  **`windows-pc` worker**, which is why they could not run in-loop. Everything verifiable without
  them is already covered: main-process behaviour by `src/main/chats/side-chat-service.spec.ts`,
  `side-chat-runtime.spec.ts` (provider matrix) and siblings; renderer by
  `side-chat-panel.component.spec.ts`, `side-chat.store.spec.ts`, rail and session-row specs; and
  a no-model dev-app run on 2026-10-06 (see the plan's as-built notes).
- Use a disposable working directory (for example `/tmp/sidechat-live`) for any session that might
  edit files.

## Checks

### LT-SC-1 — Screenshot scenario with a real answer

1. Start a Codex session in `/tmp/sidechat-live` with a task such as "Write a three-step plan in
   PLAN.md, then implement step 1". Let it finish at least one step.
2. Open the sidechat panel (⌥⌘S). Confirm the header reads "Sidechats · <session name>".
3. Leave Claude selected in the picker and ask "How far through this are you? What's left to do?"

**Expected:** Claude's answer names the task from step 1 and the progress actually made, without
the Codex session receiving any message or interruption (its transcript is unchanged).

### LT-SC-2 — Hidden answer, badge, and exact reopen

1. Ask a sidechat a question that takes a while (for example "Write a 600-word summary of this
   session's work").
2. Close the panel immediately and select a different session.

**Expected:** while it runs, the rail sidechat button shows the pulsing dot and the parent's session
row shows a running badge. When it finishes, both show an unread count of 1. Clicking the session
row badge (or the rail's right-click list entry naming the session) opens that session with the
panel on that exact conversation, and the answer is present. The count clears only after scrolling
to the end of the answer with the window focused; while scrolled up, a "New answer ↓" button shows.

### LT-SC-3 — Unread survives an app restart

1. Repeat LT-SC-2 but do not open the answer.
2. Quit and restart Harness.

**Expected:** the unread badge is still shown on the session row and rail. No sidechat question is
re-sent on start-up (the provider receives nothing new).

### LT-SC-4 — Permission request answered in the panel

1. Start a Claude session with YOLO off in `/tmp/sidechat-live`.
2. In its sidechat (Claude), ask "Use Bash to run exactly printf SIDECHAT_APPROVAL_CHECK".

**Expected:** the session row badge and rail show "needs action". The panel shows the permission
prompt for the sidechat's own runtime; approving it there runs the command and displays its output. The parent session is
not asked anything.

**2026-10-27 acceptance clarification:** non-YOLO Claude deliberately uses `acceptEdits`, so ordinary
Write is auto-approved. The harmless Bash example tests the existing approval boundary; this does
not change application policy. Also send while the panel is closed, then reopen and approve there.

### LT-SC-5 — Restricted parent stays restricted

1. Start a session using the built-in **Plan** agent (writes blocked).
2. Open its sidechat panel and expand "Permissions: same as parent".

**Expected:** the inspector lists "Editing files: blocked"; the picker offers only Claude and Local
Models, and the "Not available for this session" list explains why Codex, Copilot and the others are
missing. Asking the Claude sidechat to edit a file is refused by the tool layer (the model reports
the edit tool is unavailable), and no file changes.

### LT-SC-6 — Busy provider switch is blocked; idle switch keeps history

1. Ask a sidechat a long question; while it is answering, open the provider picker.
2. After it finishes, switch it from Claude to Codex and ask "What did you tell me last time?"

**Expected:** during the answer the picker is disabled with "Stop the current answer before changing
provider or model". After switching, Codex answers using the earlier Claude reply (history rebuilt),
and the sidechat stays under the same parent.

### LT-SC-7 — Remote workspace routing

1. Start a session on the `windows-pc` worker (Browser Gateway / worker preflight first, per
   AGENTS.md routing rules).
2. Open its sidechat panel and ask a Claude sidechat "Which directory are you in?"

**Expected:** the sidechat runs on `windows-pc` in the parent's Windows path. With the worker
offline, sending shows an explicit "Forced worker node … is unavailable" error rather than running
locally.

### LT-SC-8 — Parent permission change between turns

1. Start a Claude session with YOLO on; ask its Claude sidechat one question.
2. Turn YOLO off on the parent session, then ask the sidechat to run exactly
   `printf AFTER_YOLO_OFF_APPROVAL` through Bash.

**Expected:** the second question runs in a fresh sidechat runtime that asks for permission before
the shell operation (the policy change took effect before dispatch). Ordinary Write remains
auto-approved under the established `acceptEdits` convention, as clarified for LT-SC-4.

## Evidence run — 2026-10-27 (resumed Plan Queue)

**Result: all eight checks have current evidence or an explicit residual; three pass, three fail,
and two remain partial. This document stays open. No product fix is claimed.**

| Check | Status | Result and residual |
| --- | --- | --- |
| LT-SC-1 | PASS | Real Codex task, correct Claude progress answer, matching panel header, parent transcript unchanged. |
| LT-SC-2 | PASS | Hidden running dot and row badge, unread count, exact badge reopen, scrolled-up unread retention and New answer button, focused bottom acknowledgement. |
| LT-SC-3 | FAIL, persistence half passes | Unread and identical ledger survive a normal restart with no runtime/resend; archived parent rows omit the badge. LT-734. |
| LT-SC-4 | FAIL, supported open-panel approval passes | Ordinary Write is auto-approved by current acceptEdits behaviour. A real Bash approval works in an open panel, but disappears if received while the panel is closed. LT-733. |
| LT-SC-5 | FAIL | Inspector/provider filtering is correct, but an adopted warm process successfully calls Write despite inherited write=deny. LT-732. |
| LT-SC-6 | PASS | Busy UI and main-process switch blocked; idle Claude→Codex switch keeps history and parent. A long pending Claude turn was explicitly stopped before the idle switch. |
| LT-SC-7 | PARTIAL, technical fixture prerequisite | Windows browser/worker healthy; isolated app has no paired nodes. Forced-node spawn explicitly refuses; actual Windows sidechat and its offline-send transition unverified. |
| LT-SC-8 | PARTIAL, acceptance mismatch | YOLO change replaces the sidechat runtime and applies false before dispatch, but Write still auto-approves under the existing acceptEdits convention. Approval-gated shell recheck remains open. |

### Environment, provenance and durable receipts

- Ran from the queue worktree on `queue/2026-10-02-session-sidechats-c9f650`, HEAD `80412201a`.
  `git diff main...HEAD` was empty before testing; this campaign changes documentation only.
  Read the plan's as-built/verification notes and the complete live-test runbook before launch.
- Built main and production renderer from this worktree; both exited 0. Also built a development
  renderer from the same source so Angular services could be inspected. Served its output only
  on loopback port 5699. The production build emitted its existing initial-bundle size warning.
- Electron profile `/tmp/aio-lt-queue-55c9f650`, debug port 9699; fixture workspace
  `/tmp/aio-lt-queue-55c9f650-workspace`. No shared Harness restart, branch operation, worker
  restart, production setting change, credential retrieval or login was performed.
- Launch investigation: the first process relaunched itself to add the 8 GiB heap flag and its
  detached child crashed. A supervised launch with the flag supplied captured repeated
  `sandbox initialization failed: Operation not permitted` and a fatal unusable-GPU exit.
  The disposable test launch then used `--no-sandbox --disable-gpu` plus the heap flag.
  This is a test-environment limitation: production Chromium sandboxing and macOS hardened
  execution were not validated. Provider permission enforcement was still exercised explicitly.
- Before renderer assertions the CDP helper enabled focus emulation. The additional
  setPageVisibilityOverride command failed (the helper did not retain its error details); its
  receipt records false, while actual `document.hidden` was false with normal Angular frame
  updates. No forced change detection.
- Durable evidence bundle: [report](../../.aio-review/2026-10-27-session-sidechats/report.md),
  [CDP command/result receipts](../../.aio-review/2026-10-27-session-sidechats/cdp-receipts.jsonl),
  [command receipts](../../.aio-review/2026-10-27-session-sidechats/commands.json),
  [restart comparison](../../.aio-review/2026-10-27-session-sidechats/restart-comparison.json),
  [log excerpts](../../.aio-review/2026-10-27-session-sidechats/runtime-excerpts.txt),
  and [SHA-256 seal](../../.aio-review/2026-10-27-session-sidechats/seal.json).
  The bundle is local and ignored; it contains evidence, not a copied checkout or dependencies.
  Each CDP receipt contains the evaluated expression, timestamp, focus setup and actual result.

### LT-SC-1 — real progress answer

Codex `gpt-5.6-luna` parent `x8d9i4zdt`, stable thread
`188f826f-6593-4162-9792-efd074a582ab`, created PLAN.md and progress.txt containing
STEP_ONE_COMPLETE, left next.txt absent and reported one of three steps complete. Older model
names gpt-5.4/gpt-5.5 were rejected by this account during setup; the current installed CLI's
model list supplied the working model. These setup refusals are not sidechat defects.

Claude Sonnet sidechat `36b98515-bc04-4903-879b-cb02bf3c89ce` answered that step 1 was complete,
named both created files, and said create next.txt and validate both files remained. Its header
read “Sidechats · PLAN.md and progress.txt step one”. Later before/after comparison of the
parent's full 17-message output buffer and lastActivity returned unchanged=true. The sidechat
used the parent workspace even when creation supplied a different fallback directory.

### LT-SC-2 — hidden answer, exact reopen and read visibility

With the panel closed and a different parent selected, running attention was 1 and unread 0;
after clearing unrelated fixture read state the actual rail rendered `.rail-activity-dot` and
the parent row exposed “1 sidechat running, open sidechats”. Claude conversation
`af5e7486-0881-43ff-84ea-f4284586f26a` eventually completed a 3,218-character answer ending
ORANGE_CEDAR_731. It was slow enough to trigger a stuck warning; it did finish, so no provider
outage or stalled-turn root cause is claimed. The parent showed one unread answer. Clicking
its row badge selected that exact conversation and displayed the answer and marker.

For the separate scroll condition, Codex conversation `90245b33-4a7f-4ab6-baaa-db9c2cd98cbd`
was already open and scrolled to top before a fresh answer. At completion: scrollTop=0,
scrollHeight=1864, clientHeight=192, unread=1, and the actual “New answer ↓” button was present.
Clicking it moved scrollTop to 1672 and cleared unread to 0 with the window focus-emulated.
An earlier reopen auto-rendered the answer's end before a programmatic scroll-up; that was
not used as evidence of a read-acknowledgement defect.

### LT-SC-3 — restart persistence and missing archived-row badge

Sent another Codex question, closed the panel and left its RESTART_UNREAD_982 answer unread.
Saved a six-message ledger baseline. Normal SIGTERM shutdown of test app pid 87665 exited 0 at
07:45:51 UTC; relaunched the same profile. Every message id, sequence, role and content matched
the baseline exactly. Attention still reported unread=1 and the same target chat; rail said
“Sidechats, 1 need a look”. The app listed zero live instances and chat.currentInstance was null:
startup did not spawn a runtime or resend the question. The new app was inspected before any
new live probe was created.

The standalone parent had moved to History. Both its project-history entry and History sidebar
entry were rendered without a sidechat badge. The only matching sidechat button was the rail.
This is the remaining failure, filed as **LT-734**; persistence/no-resend themselves passed.

### LT-SC-4 — approval routing, late mounting and current Write semantics

Claude parent `cradmz93u` started with YOLO false. Sidechat
`b6f85b45-a370-4a0c-9759-acb0175070ca` used Write to create permission/hello.txt with exactly
`hi` and no permission prompt. This matches the executing argv builder's intentional non-YOLO
`--permission-mode acceptEdits` (`src/main/cli/adapters/claude-cli-argv-builder.ts:186-208`).
The original Write-only expectation does not match the current application convention and is
not silently changed or described as passed.

Supplementary real approval probe: a fresh low-effort Claude runtime `ctbmo0hvo` requested Bash
for `printf PANEL_APPROVAL_CHECK` while closed. Parent/rail showed Needs action and runtime
was waiting_for_permission. Reopening its exact chat showed no approval card/buttons;
component pendingRequests and the queried pending-request lists were empty. Filed **LT-733**.

Control after restart: kept the panel mounted before sending a fresh harmless Bash request.
Runtime `cmeocyck4` displayed “Permission Required” for `printf OPEN_PANEL_APPROVAL`, including
“Allow once”. Clicking that button ran the command; the durable tool result was
OPEN_PANEL_APPROVAL, the sidechat became idle, the card cleared, and its parent `caou5phh6`
retained an identical output buffer. This verifies the working continuously mounted route,
without claiming the original Write example or closed-panel recovery passed.

### LT-SC-5 — inherited deny bypassed by warm reuse

Plan parent `c2xflc0xf` resolved write=deny, bash=ask. Its inspector actually rendered “Editing
files: blocked” and “Not available for this session”, with exclusion reasons for Codex,
Antigravity, Copilot, Cursor, Grok and OpenCode. IPC capability data allowed only Claude and
Local Models; Gemini remained an internal capability entry, not an offered installed provider.

Real sidechat `c02d60d5-4fb1-478b-aa2b-7961d5bd463b`, runtime `cp0gq0hg3`, successfully used
Write to create restricted/blocked.txt containing BLOCKED_WRITE_TEST. No approval was granted.
Its metadata still denied Write/Edit/NotebookEdit. The app logged warm-adapter adoption for
this exact runtime at 07:38:40.104 UTC. The warm admission path ignores the inherited tool/hook
configuration; its pre-started adapter has no such denials. Filed **LT-732**, with call-path
references and acceptance in the remediation register. Existing mocked provider tests passed
despite this live failure.

### LT-SC-6 — switching and history

During the first Claude answer, the actual disabled picker title was “Stop the current answer
before changing provider or model”; direct sideChatSetSelection returned SIDE_CHAT_BUSY.
A later long pending turn was explicitly interrupted, then the idle sidechat switched to
Codex gpt-5.6-luna. Codex answered the recall question using Claude's earlier completed answer:
step 1 complete, PLAN.md/progress.txt created, next.txt and validation remaining. Chat id,
ledger and stable parent key stayed unchanged, as did the parent's entire output buffer.
The idle switch was tested after an explicit stop, not natural completion of that long turn.

### LT-SC-7 — Windows preflight and safe residual

Browser Gateway health reported windows-pc's remote extension fresh, running, deliverable and
registered; targeted preflight succeeded as a tool call (there was no matching localhost tab).
The independent worker roster also reported windows-pc connected and supporting Claude.
The isolated dev app's remoteNodeList was empty. This is profile isolation, not a Windows outage.

Forced creation against that real node id in the unpaired dev profile initially returned a
pending record, then entered error with: `Forced worker node "bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be"
is unavailable (not found)`. No CLI was spawned for it. This checks the shared forced-node
refusal, not a successful Windows sidechat or sidechat-specific offline transition.

**Open technical prerequisite:** provide a disposable worker connection to the isolated dev app,
then run the actual parent/sidechat on the Windows workspace and disconnect only that disposable
connection for the offline-send assertion. The production worker was not disconnected, re-paired
or restarted. No James-only identity, credential or physical-device step has been established.

### LT-SC-8 — refreshed policy, remaining approval expectation

On the permission parent, toggled YOLO on and sent a harmless first sidechat turn. Its runtime
was `c18ia3hhh`. Toggled the parent off, then asked the sidechat to create after-toggle.txt.
The send replaced it with `cejsp2sds`, whose yoloMode was false before execution; it created the
file with OFF_POLICY via Write. The log independently records adoption of a non-YOLO warm
adapter at 07:40:03.127 UTC. Runtime replacement/policy refresh passed, but the requested
pre-Write prompt did not occur. Current acceptEdits semantics explain that specific result;
they do not validate the separate warm-process authority bug. Recheck approval-gated shell
behaviour across the toggle after LT-732, and reconcile the original Write expectation with
the established non-YOLO convention. This criterion remains open, not marked Needs James.

### Verification and handover

- Main build, production renderer build, development renderer build: exit 0.
- `tsc --noEmit`: exit 0. `npm run typecheck:spec`: exit 0 using the required 8 GiB wrapper.
- Focused sidechat service/runtime/store/panel tests: exit 0, 66 passing tests. Full output and
  command receipts are in the evidence bundle. No test or product source was modified.
- Full suite/lint were not rerun: this is a documentation/evidence campaign, and the observed
  real-runtime failures remain open. The queue coordinator owns independent verification.
- Defects: LT-732–LT-734 in the worktree register. Matching active implementation status is in
  the untracked root-checkout [follow-up plan](2026-10-27-session-sidechat-remediation_plan.md).
  The closed July plan was not extended, and the backlog file itself says not to add current
  status there; this owning document is the current status record.
- Cleanup completed: app/server stopped, all recorded app/CLI pids absent, both test ports closed,
  disposable profile/workspace/build output and helpers removed, no automations or pending
  approvals before shutdown. Dedicated provider transcripts for this fixture were removed too.
  No changes were staged and no branch/worktree operations were performed. Pre-existing
  dependency installs and their coordinator-created caches are preserved. The cleanup receipt
  and final evidence seal are in the bundle.

## Evidence run — 2026-10-27 (queue remediation round 2)

**Status: implementation and live regression checks for LT-732–LT-734 are in place. Seven of
eight live-test checks now have passing evidence; LT-SC-7 remains technically blocked. This
document remains active and is not renamed. Independent review and final command results are
recorded below when available. No whole-document completion is claimed.**

| Check | Current status | Evidence and remaining work |
| --- | --- | --- |
| LT-SC-1 | PASS retained | Earlier real Codex→Claude task/progress answer and parent isolation evidence remains applicable; no context assembly/provider switch implementation changed in round 2. |
| LT-SC-2 | PASS retained | Earlier hidden answer, exact reopen and scroll/focus checks remain applicable; new archived-route regression also exercises the same read acknowledgement. |
| LT-SC-3 | PASS rerun | Normal restart preserves 17 selected messages exactly; zero live/attached runtimes, both archived history badges, exact parent/panel reopen and unread acknowledgement. |
| LT-SC-4 | PASS rerun with clarified operation | Real hook-paused Bash request arrives with panel absent; survives late mounting and close/reopen; Allow once executes its marker and leaves parent output unchanged. Ordinary edits still use acceptEdits. |
| LT-SC-5 | PASS rerun | Plan policy still denies writing. With a matching high-effort workspace warm candidate ready, real Claude reports Write unavailable; neither requested file exists. |
| LT-SC-6 | PASS retained | Earlier busy refusal and idle Claude→Codex history rebuild remain applicable; selection/send architecture unchanged. |
| LT-SC-7 | OPEN, technical connection failure | Windows worker and Browser Gateway remain healthy. Separate worker fixture was created, but could not establish the isolated coordinator WebSocket. Direct and reverse connection probes failed. No real Windows sidechat turn or sidechat-specific offline-send transition is claimed. |
| LT-SC-8 | PASS rerun with clarified operation | Parent YOLO on→off replaces `cmafgxdp7` with `c2kovytrk` before dispatch; yoloMode=false and actual hook approval pauses shell execution until the sidechat's own Allow once. |

### As-built fixes and evidence ownership

- `InstanceSpawnPreflightChain.prepare` refuses warmed processes for allowedTools,
  disallowedTools or permissionHookPath. Three regression cases returned warm before the fix,
  then returned fresh with the original requested spawn options. Existing eligible warm
  reuse and provider-routing tests are retained.
- The startup-created renderer IPC event bus retains complete unresolved CLI requests above
  panel lifetime. It deduplicates delivery and removes only the owning request on resolution,
  cancellation, exit, removal and generation replacement. The panel projects that state and
  preserves runtime-scoped reply metadata. Secret values are not retained in this store.
- A shared archived-row badge renders attention in both existing history presentations using
  stable history identity. Archived badge requests now stay in SideChatPanel with the original
  parent rather than the main chat view, whose old path did not clear sidechat unread. Changing
  the workspace selection or closing the panel removes this archived override.
- The tracked remediation register now contains its own implementation status and acceptance.
  It no longer depends on the untracked root follow-up plan or a root-only evidence anchor to
  explain LT-732–LT-734. The coordinator still owns this document and the active follow-up at
  `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-session-sidechat-remediation_plan.md`.
- LT-SC-4/8 examples now use harmless Bash operations, matching the executing Claude
  `acceptEdits` convention. This corrects the test example, not product permissions.

Durable round-2 bundle: [report](../../.aio-review/2026-10-27-session-sidechats-round2/report.md),
[CDP receipts](../../.aio-review/2026-10-27-session-sidechats-round2/cdp-receipts.jsonl),
[command receipts](../../.aio-review/2026-10-27-session-sidechats-round2/commands.jsonl),
[restart comparison](../../.aio-review/2026-10-27-session-sidechats-round2/restart-comparison.json),
and [seal](../../.aio-review/2026-10-27-session-sidechats-round2/seal.json).
These are local ignored evidence artifacts, not copied source trees or dependencies.

### LT-SC-3 — real restart and archived badges

Before shutdown saved 17 messages from three sidechats, including IDs, sequences, roles and
contents. After normal SIGTERM shutdown and relaunch with the same isolated profile,
`restart-comparison.json` records identical=true, liveInstances=0 and attachedRuntimes=0.
The unopened toggle answer retained unread=1. Both project-history and sidebar rows rendered
“1 unread sidechat answer, open sidechats” for its original parent thread.

Clicking its real sidebar badge opened chat `832289e4-80a6-4a05-a15a-1b9a26b95738` under
parent `ce247a4e-4e5b-4ef5-b1d1-0e1fb2de3fcd`, header “Sidechats · Sidechat fixture toggle”,
with AFTER_YOLO_OFF_APPROVAL visible. Sidebar closed, selectedParentId=null and liveCount
remained 0. The focus-emulated transcript was at its actual bottom (scrollTop=178,
scrollHeight=494, clientHeight=316); unread became 0 without any send or runtime creation.
Before the dashboard follow-up fix, the new badges opened the main chat and unread remained 1.
That reproduced extension is recorded under LT-734 and is covered by the new dashboard tests.

### LT-SC-4 — closed-panel approval and parent isolation

With no panel mounted, runtime `csenln0jb` received deferred request
`20d6d912-7c06-43d2-bc6b-7fbde50f7933` for `printf LATE_PANEL_APPROVAL`, entered
waiting_for_permission and showed Needs action. Reopening rendered one Permission Required
card for that exact runtime. Closing and reopening again retained the same single card.
Clicking its actual Allow once button ran Bash and persisted the real LATE_PANEL_APPROVAL
tool result; the runtime settled idle. The parent output comparison returned unchanged=true.
Switching to the separate toggle parent's panel showed its own request only, without the old
card. Focused tests additionally cover closed-panel resolution, stale generations, duplicate
delivery/counts, sibling ID collisions, failed list fetches and existing secret-card handling.

### LT-SC-5 — matching warmed workspace and tool-layer refusal

Parent `cl44unb6v` used built-in Plan. Permissions retained read=allow, write=deny, bash=ask,
and only Claude/local-model were available. A second ordinary Claude create in that same
workspace established a default-high-effort warm candidate (08:19:38.159 UTC, durable app log).
The sidechat's selection was explicitly high too. Sending the follow-up created runtime
`cm9jt7owm` fresh instead of adopting the warm candidate. Claude reported Write absent from
both its loaded and deferred tool lists and created neither blocked.txt nor high-blocked.txt.
The earlier low-effort probe also refused Write, but is not used alone as evidence of the
matching-effort warm admission fix. Filesystem absence is recorded before fixture cleanup.

### LT-SC-8 — refreshed runtime actually pauses before a shell operation

The first YOLO-on turn used `cmafgxdp7` and answered BEFORE_POLICY_CHANGE. Toggling the parent
off and sending the approval-gated question replaced it with `c2kovytrk` before dispatch.
The new runtime had yoloMode=false and deferred request
`5980b3cf-bb7b-4568-877f-79751b18659f` for `printf AFTER_YOLO_OFF_APPROVAL`.
Its panel showed exactly that request; Allow once produced the actual shell marker and idle
completion. A separate approval from the parent did not appear in the sidechat's card list and
was not approved through it. Parent isolation for LT-SC-4 was checked against the other parent,
whose transcript had not been changed by a parent YOLO toggle.

### LT-SC-7 — attempted disposable Windows fixture, exact residual

Browser Gateway health and explicitly Windows-targeted preflight were successful; the production
roster showed windows-pc connected with Claude support. An additional worker was launched from
its existing installed worker runtime with its own UUID, namespace, scratch config, workspace,
disabled automation/self-update and no changes to the production worker connection.

The isolated coordinator listened on port 19799. Loopback WebSocket opened and HTTP returned
426 Upgrade Required. Windows reached its TCP port on both LAN and Tailscale addresses, but
WebSocket handshakes returned ECONNRESET/socket hang up. Independent local probes against those
same non-loopback addresses also returned empty HTTP replies/socket hang up, including a separate
minimal Node HTTP server; the local loopback control answered normally. This is not evidence of a
Windows worker outage, authentication rejection, failed provider or sidechat routing defect.
The cause of the host socket closure was not established, and no system network permission or
shared production setting was changed.

A disposable reverse TCP relay was also attempted with a separate Windows listener and a Mac
outbound connection. The outbound connection timed out and no fixture node registered. All
fixture processes, listeners, uploaded config/probe and the dedicated Windows directory were
then removed; the sanitized Windows cleanup receipt is retained. The production worker stayed
connected. No James-only fact, identity step or new authority requirement was established.

**Still open:** establish a working disposable worker connection, run the real sidechat in the
parent's Windows directory, then disconnect only that disposable connection and test the
sidechat send's explicit forced-node refusal. The earlier standalone forced-node refusal is
retained as partial evidence, not substituted for these missing checks.

### Verification, launch limitations and cleanup

- The app was built and launched from this exact queue worktree, profile
  `/tmp/aio-lt-queue-55c9f650`, debug port 9699 and renderer port 5699. The automated launcher hid
  its windows and did not take desktop focus. Chromium used the prior campaign's required
  `--no-sandbox --disable-gpu` workaround, so OS sandbox/hardened execution is not validated.
- Every DOM probe used CDP focus emulation first; document.hidden=false and document.hasFocus=true.
  The unsupported PageVisibilityOverride command's exact error is retained in every receipt;
  no forced Angular change detection was used for live assertions.
- An initial test bootstrap set app.getAppPath to its scratch directory, so hooks were absent
  and the first Bash probe auto-approved. That fixture mistake was corrected before the counted
  permission checks. Those earlier probes are not passed approval evidence.
- Canonical gate receipts, fresh review status and final cleanup receipt follow in the final
  handover addendum. No document completion rename, commit, stash or branch/worktree change.


## Evidence run — 2026-11-03 (remediation worker)

LT-732–LT-734 are implemented in `queue/2026-10-27-session-sidechat-re-022b2b` and ready for queue verification. This document remains active: the full suite/independent acceptance belong to the coordinator, and LT-SC-7 remains open in [the root-owned Windows follow-up](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-session-sidechat-remediation_livetest.md). The original completed spec and plan were not extended.

- **LT-SC-3: PASS rerun.** A settled restart preserved message IDs, sequences, roles and contents with no attached runtime or resend. The rail retained unread attention; both history presentations rendered their own stable-parent badges. Sidebar and project badges reopened the exact sidechat with zero parent runtimes, and the previously viewed answer stayed read. Only renderer fixture directory labels were mapped to a neutral project path for the project-row presentation, because the existing rail intentionally hides queue-worktree histories. Stored identities, messages, read marks and main-process records remained unchanged.
- **LT-SC-4: PASS rerun.** A real Bash request arrived with the panel closed, survived reopening twice as one card, and executed `LATE_PANEL_APPROVAL` from its own Allow once button. The durable ledger contains that exact tool result. The card disappeared and the parent transcript remained unchanged. Separate regression tests cover switching, request-ID collisions, cancellation, exit, replacement and resolution while closed.
- **LT-SC-5: PASS rerun.** A matching high-effort warm candidate was observed in the restricted parent's workspace; admission returned fresh with Write/Edit/NotebookEdit denied. Real Claude reported Write unavailable. The restricted project remained empty, including absent `blocked.txt` and `high-blocked.txt`.
- **LT-SC-8: PASS rerun.** YOLO-on to off replaced the sidechat runtime before dispatch, and the new runtime paused for approval before Bash. The saved tool result is `AFTER_YOLO_OFF_APPROVAL`. A separate ordinary Write with YOLO off created `allowed.txt` with exactly `ORDINARY_EDIT_ACCEPTED`, no approval requests, and an unchanged parent, confirming the established acceptEdits convention.
- **LT-SC-7: still open after an in-loop fixture attempt.** Windows-targeted Browser Gateway preflight passed and the production channel was fresh/deliverable. A separate worker was built and launched with its own identity, namespace, logs and workspace. Its isolated-coordinator connection closed before registration; loopback answered while Windows probes reset or returned empty replies. No network cause, successful Windows sidechat or sidechat-specific offline refusal is claimed. The fixture and credentials were removed, and the production worker remained connected without re-pairing. Current evidence and exact rerun steps are in [the root-owned Windows follow-up](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-session-sidechat-remediation_livetest.md).
- **LT-SC-1/2/6:** not rerun by this remediation worker. Earlier campaign evidence remains in the coordinator root copy; focused service/runtime/store/panel/rail regressions passed on this branch.

Worker verification: 19 focused files / 269 tests, both type checks, both linters, TypeScript size/UI-hint checks, IPC/alias generators and both production builds passed. The full suite was deliberately reserved for the queue verifier. Offscreen application tests showed no desktop window and used focus emulation; test-only no-sandbox/disabled-GPU flags mean OS sandbox/hardened execution was not validated. The first restart comparison caught an early test snapshot, not data loss; the fixture was corrected and the settled comparison passed.

Current report, live receipts, command receipts, screenshot evidence, cleanup receipt and source/evidence seal: [worker bundle](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-03-session-sidechat-remediation-022b2b/report.md). All disposable runtime/build/cache data created by this worker is removed after sealing; dependencies remain for verification. No completion rename, commit, stash, branch/worktree operation or deployment.

## Evidence run — 2026-11-04 (round 3 verifier repairs)

LT-SC-7 now passes both required in-loop checks. A connected disposable Windows parent exposed LT-735: sidechat policy read the supervision identifier instead of the execution node and tried to spawn locally in a Windows path. Correcting policy, context provenance and renderer parent references to use `executionLocation` fixed the running path.

At 01:24:26 UTC a real Claude sidechat answered with the parent's exact Windows workspace and a matching remote execution location; the parent transcript remained unchanged. At 01:27:18 UTC a subsequent send to that same sidechat, with its disposable worker unavailable, returned the explicit forced-worker-unavailable error and made zero adapter-factory calls. The normal retained error placeholder was recorded and is not a local CLI process. A later PID check confirmed the disposable worker and launcher had exited. The production worker was left untouched.

Detailed source mapping, exact receipts, transport limitations and cleanup: [root-owned Windows follow-up](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-27-session-sidechat-remediation_livetest.md). Current worker evidence: /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-session-sidechat-re-022b2b/.aio-review/2026-11-04-session-sidechat-round4/report.md. The earlier unverified Windows attempts remain historical. This active document was restored after an accidental checkpoint deletion and reconciled with the coordinator's existing historical evidence; no acceptance criteria were weakened. Canonical verification of LT-735 and independent queue acceptance remain distinct from these passed live checks. No completion rename or commit.

### Final verification — 2026-11-04

All canonical gates for the repaired source passed, including the full unfiltered suite (36492 passing tests,zero failures,nine pre-existing pending cases). A genuinely fresh `task-completion-gate` reviewer returned **VERDICT: PASS** with no unresolved actionable findings and confirmed source hashes and HEAD unchanged across its independent run. Report: /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-session-sidechat-re-022b2b/.aio-review/2026-11-04-session-sidechat-round4/independent-review.md. The reviewer used the authorised dirty snapshot and did not create a clean checkout or repeat the Windows provider turns. Earlier failed/superseded runs remain historical.

The restored document is reconciled with the coordinator source, including its longer campaign history. Its defect-recording header now points to active follow-up work rather than instructing edits to a closed July plan. Test fixtures, credentials, processes, generated runtime and caches were removed after retaining receipts and seals; dependencies remain in the worktree. The active filename is retained solely by instruction. No commit, staging, branch change or completion rename.

## Evidence run — 2026-11-07 (queue resume on `queue/2026-10-02-session-sidechats-c9f650`)

**Result on this branch.** LT-SC-2, LT-SC-3, LT-SC-4 and LT-SC-8 pass with live evidence from this run. LT-SC-5 and LT-SC-6 are partial. LT-SC-1 is blocked by a Codex usage limit that resets on 2026-11-08 at 12:21. LT-SC-7 is not verified. Main already reads `executionLocation` for sidechat parents (recorded as LT-735). After the 2026-11-07 merge with main, this branch carries main's code, so the live evidence above was taken on the pre-merge code and must be re-run on the merged build. This document stays open and is not renamed.

| Check | Status | Evidence and residual |
| --- | --- | --- |
| LT-SC-1 | BLOCKED (provider) | Codex parent `xhf32ax8a` refused the task with `usageLimitExceeded`. Not re-run; the 2026-10-27 evidence above is unchanged and not re-established here. |
| LT-SC-2 | PASS | With the panel closed, the sidechat showed running 1 and a rail dot; it finished as unread 1 ("1 need a look"). The row badge reopened the exact chat. Scrolled to the top, a new answer produced unread 1 and a `New answer` button; clicking it cleared unread. |
| LT-SC-3 | PASS | Unread 1 on chat `70b32294…` survived a normal SIGTERM shutdown and relaunch on the same profile. Zero live runtimes; no spawn or send from relaunch (20:20:36Z) to 20:22:16Z. The History sidebar and project-history rows of the terminated parent both showed the badge. The badge reopened the exact chat containing `RESTART_UNREAD_OK`, and unread cleared to 0. |
| LT-SC-4 | PASS | Sidechat runtime `co6pxphji` asked for Bash with the panel closed. Reopening showed one Permission Required card. `Allow once` ran the command (tool group `1 call · 25 characters`), and the runtime returned to Idle. The parent had no messages before the approval. |
| LT-SC-5 | PARTIAL | Plan parent `cide70ft6`: inspector shows "Editing files: blocked"; the picker offers Claude models and Local only. A sidechat set to `opus[1m]` with high effort spawned fresh (`cd20whylw`); Claude answered `WRITE_TOOL_UNAVAILABLE`, an answer the prompt offered for a missing tool, and no file was created. Its tool list was not inspected. **Not reproduced:** warm adoption. No warm candidate existed because the warm pre-spawn is skipped while the signal fence is off, and the fence cannot start in this nested sandbox. |
| LT-SC-6 | PARTIAL | While a Claude answer streams, the provider chip is disabled with "Stop the current answer before changing provider or model", and a same-provider IPC change returns `SIDE_CHAT_BUSY`. **Not run:** the idle switch to Codex (usage limit). |
| LT-SC-7 | OPEN | Not run live. The pre-merge branch routed parent node by `workerNodeId` (the supervising worker); main reads `executionLocation`, recorded as LT-735 in the register. Live check pending on the merged build. |
| LT-SC-8 | PASS | Parent YOLO on, then off. The sidechat was replaced by `c4y7vhxiu` (yoloMode false) before dispatch. Its Bash request (`printf AFTER_YOLO_OFF_APPROVAL2`) paused in the sidechat only; `Allow once` there ran it (`1 call · 24 characters`). An ordinary Write with YOLO off created `allowed.txt` with no approval card. |

### Residuals and exact next steps

- **LT-SC-1 and the Codex half of LT-SC-6:** need Codex quota. The limit resets at 2026-11-08 12:21, or James can add credits (his decision). Then: start a Codex parent in `/tmp/aio-lt-queue-55c9f650-workspace`, send the PLAN.md task, ask a Claude sidechat for progress, and for LT-SC-6 switch the idle sidechat to Codex and ask the recall question.
- **LT-SC-5 warm step:** rerun on a host where the signal fence can start (not inside a nested sandbox). Create a matching high-effort Claude workspace instance, wait for `Warm process ready`, then send the restricted Write within 300 s and check for `Using warm-start adapter`.
- **LT-SC-7:** on the merged build, connect a disposable worker to the isolated dev app, run a real sidechat in the parent's Windows directory, then disconnect only that worker and check the offline-send refusal. Earlier evidence for the same path is the sibling branch's 2026-11-04 section (LT-735), which is historical.
- **Observation for the coordinator (not a sidechat leak):** turning a parent's YOLO off delivered the `[System: YOLO mode disabled ...]` notice into the parent's transcript, and the parent's own turn then requested `ls -la` on the workspace. That card stayed in the parent and was not approved. Whether the notice should start a parent turn is a product question.

### Environment and provenance

- Gates before live work, all exit 0: `build:main`, `build:renderer`, `tsc --noEmit`, `typecheck:spec`. Focused specs for the fixed areas: 5 files, 84 tests passing. No product source changed in this run; the only tracked edit is the register.
- `node_modules` in the worktree was out of step with the lock (vitest 5.1.0 vs 4.1.12). Reconciled with `npm install --ignore-scripts`; the lockfile was not changed and no native module was rebuilt.
- Renderer served by `ng serve --port 5699 --prebundle=false`. Dev app launched on profile `/tmp/aio-lt-queue-55c9f650` with debug port 9699, using `--no-sandbox --disable-gpu`. These test flags mean OS sandboxing and hardened execution were not validated.
- In the isolated profile only, `providerSignalFenceEnabled` and `pauseOnVpnEnabled` were set to `false`. Two instances created before that change failed with exit 71 (nested `sandbox-exec`) and were terminated; they are not evidence.
- Focus emulation was enabled before each DOM assertion. Receipts are in the bundle.
- Evidence bundle, with report, receipts, log excerpts, screenshots and SHA-256 seal: [report.md](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-07-session-sidechats-queue/report.md) and [seal.json](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-07-session-sidechats-queue/seal.json).

- **Merge with main (2026-11-07).** Main had already landed equivalent fixes for all four sidechat defects. The merge kept main's code for every conflicted file, so this branch now differs from main only in the register. The branch's warm-admission lines were dropped: they refused warm reuse for every create that passes the default denylist, which main's guard deliberately allows (`instance-spawn-preflight-chain.ts`). Checks on the merged tree: `tsc --noEmit` and `typecheck:spec` pass; `build:main` and `build:renderer` pass; main's own specs pass (dashboard 22, history attention 10, user action 48, event bus 21, preflight 43 with the branch's regression cases added). The branch's own renderer specs pass where their test names match main's; the differing assertions are main's newer wording and call shapes.

## Evidence run — 2026-11-10 (queue resume on `queue/2026-10-02-session-sidechats-220367`)

**Result on current main (HEAD 543c2344f, no branch changes).** LT-SC-1, 2, 3, 4, 5, 6 and 8 pass with live evidence from this run. LT-SC-7 is partial: remote routing and the offline refusal pass against a disposable worker on this Mac, but nothing ran on `windows-pc`. This document stays open and is not renamed. Two new defects were reproduced and registered: LT-1122 and LT-1123. No product source was changed.

| Check | Status | Evidence and residual |
| --- | --- | --- |
| LT-SC-1 | PASS | Codex parent `xh4mmclbk` (YOLO, disposable folder) wrote PLAN.md and progress.txt (`STEP_ONE_COMPLETE`). Panel header read "Sidechats · Write a three-step plan in PLAN.md, then implement step 1..." (⌥⌘S). Claude sonnet sidechat `2a703f52` answered one of three steps done, steps 2 and 3 left, naming both files. Parent output buffer (20 messages) and lastActivity were byte-identical before and after. The Codex usage limit that blocked 2026-11-07 had reset. |
| LT-SC-2 | PASS | With the panel closed and another parent selected: row label "1 sidechat running, open sidechats" and `.rail-activity-dot`. On completion: row "1 unread sidechat answer, open sidechats", rail "Sidechats, 1 need a look". The row badge opened chat `2a703f52` with the marker `VIOLET_KITE_71` in the DOM. With the panel scrolled to the top, a new answer gave unread 1 plus the "New answer ↓" button; clicking it scrolled to the end (scrollTop 16239) and unread went to 0. |
| LT-SC-3 | PASS | Unread 1 on the Codex parent's chat (`RESTART_UNREAD_OK`), panel closed. Normal SIGTERM of the app (07:25:47, gone in about 8 s), relaunch on the same profile. Messages of all 5 sidechats across 3 parents (ids, sequences, roles, content) identical (`before-restart.json` vs `after-restart.json`); unread still 1 with the same target; `listInstances` returned 0; the relaunch log has zero "Spawning CLI" lines. The History row of the ended parent showed "1 unread sidechat answer"; clicking it opened the exact chat and unread cleared to 0 with no runtime created. |
| LT-SC-4 | PASS | Claude parent (YOLO off), sidechat `7340957b`, panel closed. Row "1 sidechat needs action", rail "1 need a look". Opening the panel showed one Permission Required card for `printf SIDECHAT_APPROVAL_CHECK` (Don't allow / Auto-approve / Allow this once). Close and reopen kept exactly one card. Allow this once ran it: tool result `SIDECHAT_APPROVAL_CHECK`, runtime idle, card gone. The parent's buffer was unchanged (empty). |
| LT-SC-5 | PASS | Plan parent (agent `plan`, Claude): inspector shows Reading allowed, Editing blocked, Shell asks first, Web allowed; "Not available for this session" lists Codex, Antigravity, Copilot, Cursor, Grok and OpenCode with reasons; the picker's providers were Claude and Local Models. The Claude sidechat asked to write `blocked.txt` got the tool-layer reply "No such tool available: Write. Write is disabled for this session, in subagents as well as here"; the folder stayed empty. **Warm step:** with the signal-fence setting on, a plain Claude create in the same folder logged `Warm process ready` at 07:22:10. A sidechat (opus[1m], high) sent at 07:22:34 logged `Spawning CLI process` (pid 33409, runtime `cw9ajrrmc`); the run has zero `Using warm-start adapter` or `Consumed warm process` lines. Its tool list had no Write, Edit or NotebookEdit; it fell back to a Bash redirect, which paused for approval in the panel and was refused ("You said no: Bash"); `high-blocked.txt` never existed. Caveat: the preflight chain has several reasons to refuse a warm process for this create (permission hook for non-YOLO Claude, extra tool restrictions), so this shows a fresh spawn and enforced denial, not which guard fired. |
| LT-SC-6 | PASS | During a long answer the picker chip had `aria-disabled` with reason "Stop the current answer before changing provider or model", and `sideChatSetSelection` returned `SIDE_CHAT_BUSY`. After a short answer finished normally, the idle sidechat was switched Claude to Codex; asked "What did you tell me last time? Quote the final word you ended with." Codex answered `TEAL_FALCON_204`, the marker from Claude's earlier reply. Chat id, ledger thread and parent key unchanged. (The element carrying the reason is the picker's own tooltip input; I read the reason from the component input, not from rendered tooltip text.) |
| LT-SC-7 | PARTIAL | Disposable worker (this Mac, own HOME, node `61da1d2a-6b06-4b0d-8478-9e2a94111611`, loopback port 4952). A forced remote parent and its Claude sidechat ran with remote execution location on that node in the parent's directory `/tmp/aio-lt-queue-c8220367-workerhome/work`; the answer named that path; the parent buffer was unchanged; the saved link carries the node id. With the worker stopped, sends never started a local process (zero adapter spawns, no local non-error runtime). About 18 s after stopping, every send returned `Forced worker node "…" is unavailable (not found)`. Before that the wording varied (LT-1123). A non-YOLO remote parent or sidechat could not be approved at all (LT-1122); the passing runs used a YOLO parent. **Not run:** a worker on `windows-pc` and a Windows path. See the deferred check below. |
| LT-SC-8 | PASS | Parent YOLO on; sidechat `08ebd50c` runtime `cik6759ml` (yoloMode true) answered `BEFORE_POLICY_CHANGE`. Parent YOLO off; the next send replaced the runtime (`c5a8uyfj2`, yoloMode false) before dispatch and paused in `waiting_for_permission` after 42 s. The card in the panel was for that exact chat; Allow this once ran `printf AFTER_YOLO_OFF_APPROVAL` (tool result present). The parent buffer was unchanged across the approval. The YOLO toggle itself put two system notices and two assistant replies into the parent's transcript; that is the earlier observation about the notice starting a parent turn, not a sidechat leak. |

### Defects reproduced

- **LT-1140 (P2):** Allow once on a Claude approval for a runtime on a worker fails with "No deferred tool use pending for instance …"; the runtime stays at waiting_for_permission. Same for a plain remote parent with no sidechat (control `printf REMOTE_CONTROL`). Traced to `input-required-respond.ts:49` sending every `deferred_permission` reply to the coordinator-side resume path, which a remote adapter does not have. Not fixed here.
- **LT-1141 (P3):** after the worker stops, sidechat sends return "recovering from interrupt", "Node not connected", then "inconsistent state (no adapter). Please restart the instance." for roughly 18 s before the correct forced-worker message. Nothing runs locally.

### Deferred check

#### LT-SC-7 — Windows worker sidechat on windows-pc

Steps: connect a disposable worker on `windows-pc` (own node id, namespace, scratch folder; never the production worker) to the isolated dev app. A direct LAN or Tailscale connection from Windows to the Mac's listener was reset in earlier campaigns, so use a loopback relay as in the 2026-11-04 section of the [Windows follow-up](2026-10-27-session-sidechat-remediation_livetest.md). Create a YOLO Claude parent forced onto that node in a Windows path (non-YOLO approvals fail until LT-1122 is fixed), create a Claude sidechat, send "Which directory are you in?", then stop only the disposable worker and send again.

Expected: the answer names the parent's exact Windows path and the runtime's execution location is that node; after the worker is gone the send returns the forced-worker-unavailable error with no local spawn.

Why deferred: needs a connection from the real Windows machine into the isolated coordinator. Not a James-only step. The same path was shown working on a Mac worker in this run and on Windows on a sibling branch on 2026-11-04 (LT-735).

### Environment, receipts and cleanup

- Gates run in the worktree: `build:main` and a development renderer build exit 0; `build:worker-agent` exit 0. No product source changed; the only tracked edit is the register (LT-1140, LT-1141; `next-lt-id` now returns LT-1020).
- The Seatbelt probe failed at startup (nested sandbox), so OS sandboxing and hardened execution were not validated. The signal-fence setting was off except for the warm step.
- The disposable worker used symlinks to this user's Claude login in its own HOME so Claude could run; no credentials were read or printed. Its pairing token was kept in a 0600 file and never echoed.
- Browser Gateway health was `ready` and `windows-pc` was connected with 2 active instances; no page was driven and the production worker was untouched.
- Evidence bundle: [report.md](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-10-session-sidechats-220367/report.md), [notes-raw.md](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-10-session-sidechats-220367/notes-raw.md), [seal.json](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-10-session-sidechats-220367/seal.json). Every CDP expression is saved under `cdp-scripts/`.
- Cleanup: app, renderer server and worker stopped (ports 9852, 5852, 4952 closed); disposable profile, workspaces, worker home and build output removed after sealing.



## Register renumbering after merging main (2026-11-14)

Main had already used LT-1018 and LT-1019 for two unrelated defects (priced cost events and the CLI update pill event). The two defects this document found were renumbered: remote Claude approvals is now LT-1140 and the inconsistent worker-loss send errors is now LT-1141. Register rows, detail sections and the references above use the new numbers.

### Defect numbers corrected (2026-11-14, round 2 verifier repair)

The sections above first recorded the sidechat defects under numbers that the register later gave to unrelated items. Every reference in this document now uses the registered numbers:

| Number used in earlier sections | Registered as | Defect |
| --- | --- | --- |
| LT-710 | LT-732 | Warm Claude process bypassed a sidechat's inherited tool denials (LT-SC-5). |
| LT-711 | LT-733 | Approval arriving while the sidechat panel is closed could not be answered on reopen (LT-SC-4). |
| LT-712 | LT-734 | Archived parent rows omitted the persisted unread sidechat badge (LT-SC-3). |
| LT-723 | LT-735 | Sidechat policy read the supervising worker instead of `executionLocation` (LT-SC-7). |

The register rows are at `docs/plans/livetest-remediation-register.md` (LT-732 to LT-735). The real LT-710 to LT-712 and LT-723 in the register are unrelated items. Wording inside the quoted round entries is otherwise unchanged.

### LT-SC-7 on windows-pc: still deferred (2026-11-14)

Not run in this round. The verifier correctly noted that only a Mac worker was exercised. Running it needs a disposable worker on `windows-pc` reaching the isolated dev coordinator through a loopback relay, with a Windows workspace; that is environment setup, not a code change or a James-only step, and was deliberately not improvised here. The steps and expected result are unchanged in the "Deferred check" section above. The other seven checks and the Mac-worker half of LT-SC-7 stay as recorded on 2026-11-10.

### Register numbers renumbered again after the 2026-11-16 merge with main

Main registered two unrelated defects as LT-1122 and LT-1123 (MiMo account switch and account chip) while this branch used the same numbers for the remote Claude approval and worker-loss send errors. The branch's two defects are now LT-1140 (remote Claude tool approvals cannot be answered) and LT-1141 (worker loss gives inconsistent sidechat send errors), reserved with `next-lt-id.mjs --reserve`. Register rows, detail sections and the references above use the new numbers; where an earlier line in this document says LT-1122 or LT-1123 for those defects, read LT-1140 and LT-1141.

## Evidence run — 2026-11-18 (queue resume on `queue/2026-10-02-session-sidechats-220367`)

**Result: the one open check, LT-SC-7 on `windows-pc`, passes both halves with live evidence. With the 2026-11-10 passes for LT-SC-1 to LT-SC-6 and LT-SC-8 (not re-run today; no sidechat product code changed on this branch), every check now has a pass. No product source changed. This document is not renamed; the coordinator owns that.**

| Check | Status | Evidence |
| --- | --- | --- |
| LT-SC-7, online dispatch | PASS | A disposable Windows worker (own node id `0e57757b…`, own home and workspace, connected, win32, Claude available) hosted a YOLO Claude parent `cm9cjc9vo` (remote on that node, processId -1) in `C:\Users\shutu\AppData\Local\Temp\aio-lt-sc7-c8220367\work`. Claude sonnet sidechat `d143db2a` answered "My current working directory is `C:\Users\shutu\AppData\Local\Temp\aio-lt-sc7-c8220367\work`". Its runtime `czp18pa9u` was remote on the same node and directory, processId -1. The parent's output buffer was empty before and after. The worker log shows the Windows `claude.exe` launches and "Provider turn completed". |
| LT-SC-7, worker gone | PASS | The disposable worker's processes were stopped at 14:01:19Z; 45 s later the roster showed it disconnected. Sends at 14:02:11Z and 14:02:16Z both failed with `SIDE_CHAT_SEND_FAILED: Node not connected: 0e57757b-…`. No new instance appeared and both instances stayed remote on the lost node (degraded, processId -1): no local spawn. |

Wording: the refusal said "Node not connected" (the node is still known to the app and the runtime is bound to it), not `Forced worker node "…" is unavailable (not found)`. That second wording needs the node removed from the roster and was not re-run. Same as the 2026-11-12 sibling run. The sends came 52 s after the stop, so LT-1141 (inconsistent messages for about 18 s after loss) was not exercised.

### How the fixture was built (existing controls only)

The unlanded capability repair (`capability-7d41221e…`, `worker-start`) is not on this branch or main and was not used. The check did not need it:

- `dev-app.js start --port 9852 --data /tmp/aio-lt-queue-c8220367` picked the Windows PC; the copy runs in its WSL space. I wrote `remoteNodesServerPort` 4979, host `127.0.0.1` and `remoteNodesEnabled` true, then closed the copy over CDP and ran `start --remote-only` again so the setting applied at launch.
- On the PC, through `dev-app.js shell`, a script copied the installed worker bundle (`dist\worker-agent`) into `%TEMP%\aio-lt-sc7-c8220367\app`, added a `.aio-worker-home` marker, a stub `electron` module and a config with a fresh node id, namespace `default`, three instances, auto-update off. The pairing token went from the app's CDP straight into a launcher file on the PC, never printed or passed as an argument. The worker started through `Win32_Process.Create` with `NODE_PATH` pointing read-only at the installed checkout's modules, and connected directly to `ws://127.0.0.1:4979` (Windows reaches the WSL loopback; no relay was needed, unlike the 2026-11-12 run on a Mac coordinator).
- The production worker was not stopped, re-paired or reconfigured; only processes whose command line held the fixture folder name were stopped.

### Receipts, gates and cleanup

- Bundle: [report.md](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-18-session-sidechats-220367/report.md), `receipts/` (CDP results, redacted worker-log excerpt, cleanup output), `scripts/` (every CDP expression and the fixture scripts) and [seal.json](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-18-session-sidechats-220367/seal.json).
- Gates: `npm run test:quiet` on the side-chat service and runtime specs (47 tests) and the side-chat store and panel specs (55 tests) passed on the PC. Nothing else was run: no code changed.
- Cleanup: worker stopped, Windows fixture folder removed, pairings revoked (0 left), node revoked, dev app stopped (`dev-app.js status` shows no copies; local port 9852 closed). **Left:** the copy's data folder `/tmp/aio-lt-queue-c8220367` in the PC's WSL space (`stop` leaves it and I had no SSH route to it afterwards); it holds only the isolated profile.
- Not tested: OS sandboxing and hardened execution; non-YOLO approvals on a remote runtime (LT-1140, still open in the register); a direct Windows to Mac LAN connection.

## Evidence run — 2026-11-19 (queue resume, parked repair set aside)

**Result: no check is open. The resume reason ("repair set aside, original check still open") is stale: LT-SC-7 passed on `windows-pc` on 2026-11-18 without the repair, and the other seven passed on 2026-11-10. No product source changed; the only tracked branch difference from main is still the register. This document is not renamed; the coordinator owns that.**

| Check | Status | Basis |
| --- | --- | --- |
| LT-SC-1 to LT-SC-6, LT-SC-8 | PASS (not re-run) | 2026-11-10 live evidence. No dev app was started today, so these are not re-established; the 2026-11-10 section stands. |
| LT-SC-7 | PASS (not re-run) | 2026-11-18: real Windows worker, answer named the parent's Windows path, and after the worker stopped both sends failed with `Node not connected` and spawned nothing locally. |

- **Evidence integrity:** every file in the 2026-11-18 bundle matches its SHA-256 in `seal.json` (0 mismatches). The bundle is at `.aio-review/2026-11-18-session-sidechats-220367/`.
- **Fresh gate on this branch (HEAD `838ff1f29`, clean tree):** `npm run test:quiet` on the side-chat service, runtime, store and panel specs: exit 0, 4 files, 102 tests passed (ran on the Windows PC).
- **Capability repair `capability-7d41221e…`:** not needed for this check and not used; it stays unlanded. It does not block LT-SC-7.
- **Residuals, unchanged and not acceptance failures:** the refusal wording on Windows was "Node not connected", not "Forced worker node … is unavailable (not found)" (that wording needs the node removed from the roster; it was seen on the Mac worker on 2026-11-10); LT-1141's roughly 18 s inconsistent-message window after worker loss was not exercised on Windows; LT-1140 (non-YOLO approvals on a remote runtime) remains open in the register.
- Not tested today: anything live (nothing started, so no app, port or fixture to clean up), OS sandboxing and hardened execution.

## Evidence run — 2026-11-21 (queue resume, repair now on main)

**Result: LT-SC-7 re-run live on `windows-pc` with the landed repair controls (`worker-start`, `worker-stop`); both halves pass again. No product source changed. This document is not renamed; the coordinator owns that.** The resume reason ("repair set aside, original check open") was stale: the repair is on main (`82cfc52b0`) and this run used it, on a fresh worker with its own node id. LT-SC-1 to LT-SC-6 and LT-SC-8 were not re-run (the 2026-11-10 evidence stands; no sidechat code changed on this branch, which differs from main only in the register).

| Check | Status | Evidence |
| --- | --- | --- |
| LT-SC-7, online dispatch | PASS | `dev-app.js start --pc --remote-only --port 9852` put the copy on the PC. `worker-start` (pairing token on stdin only) connected a disposable worker: node `5945e80c-6189-44f5-b35f-ac1b3f295a6a`, win32, max 4 instances, workspace `C:\Users\shutu\AppData\Local\Temp\aio-lt-winworker-9852\work`. YOLO Claude parent `cf4l1ap7v` was remote on that node (processId -1). Claude sonnet sidechat `a4ca65d7` answered "My current working directory is `C:\Users\shutu\AppData\Local\Temp\aio-lt-winworker-9852\work`". Its runtime `c719dibih` was remote on the same node and directory. The parent's output buffer was 0 before and after. |
| LT-SC-7, worker gone | PASS | `worker-stop` (11:20:39Z to 11:21:12Z) returned processGone, folderGone and nodeRevoked all true, and the roster was empty. Two sends then failed with `SIDE_CHAT_SEND_FAILED: Node not connected: 5945e80c-…`; no new instance appeared, and both stayed remote (degraded, processId -1). After a failed terminate of the bound runtime (`Node not connected`), a third send said "The remote session is still stopping". The app log has no `Spawning CLI process` or `Resolved execution location` after the worker stopped: nothing ran locally. |

- **Wording residual, now understood:** even with the node removed from the roster, a send to a runtime already bound to it says "Node not connected", not `Forced worker node "…" is unavailable (not found)`. The second wording comes from a fresh spawn with a forced node (seen on the Mac worker on 2026-11-10). I could not reach it on Windows because the bound runtime cannot be terminated once its node is gone. The refusal is explicit and nothing runs locally, which is the substance of the check.
- **Observation, not filed as a defect (outside this check):** a remote runtime whose node was revoked stays `degraded` and `terminateInstance` fails with `Node not connected`, so it cannot be cleared from the app until restart. Worth a ticket if James wants it handled.
- **My own fixture mistake:** the first parent (`csty03jte`) failed because my script lost the backslashes in the Windows path; it was terminated and is not evidence.
- **Gates:** none run; no code changed. The earlier 2026-11-19 run of the sidechat service, runtime, store and panel specs (102 tests, exit 0) stands for this unchanged branch.
- **Cleanup:** worker stopped and its Windows folder removed; copy stopped; its data folder `/tmp/aio-lt-queue-c8220367` removed on the PC (this time `shell` worked before `stop`, so the 2026-11-18 leftover is gone); local port 9852 closed. Other copies on the test Mac belong to other jobs and were not touched.
- **Not tested:** OS sandboxing and hardened execution; non-YOLO approvals on a remote runtime (LT-1140); a direct Windows to Mac connection; the `Forced worker node … (not found)` wording on Windows.
- Evidence bundle: [report.md](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-21-session-sidechats-220367/report.md), `receipts/` (CDP results, app-log excerpt) and `scripts/` (every CDP expression), sealed in [seal.json](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-21-session-sidechats-220367/seal.json).

## Evidence run — 2026-11-21 round 2 (verifier finding: forced-worker message)

**Result: LT-SC-7 now meets its offline-send requirement. The verifier was right that the 2026-11-21 run above did not: a bound remote sidechat returned "Node not connected" and "The remote session is still stopping", not `Forced worker node … is unavailable`. That was a product defect (LT-1141), not a wording residual, so I fixed it in the worktree and re-ran the check live on `windows-pc`. The statements above that call the "Node not connected" wording an understood, acceptable residual are superseded by this section. This document is not renamed; the coordinator owns that.**

| Check | Status | Evidence |
| --- | --- | --- |
| LT-SC-7, online dispatch | PASS | Fresh disposable Windows worker (node `52876feb-f223-4bf6-aaed-70063398d398`, win32). YOLO Claude parent `cw455l5a8` was remote on it; Claude sonnet sidechat `f61a6e6d` answered with the exact Windows workspace path `C:\Users\shutu\AppData\Local\Temp\aio-lt-winworker-9852\work`; its runtime was remote on the same node; the parent's buffer was 0 before and after. |
| LT-SC-7, worker offline | PASS | `worker-stop` ran while 24 sends went out 4 s apart. All 24 refused with `Forced worker node "52876feb-…" is unavailable (disconnected)` (8 sends, roster still `connected` but socket closed) or `(not found)` (16 sends after the node left the roster). None said "Node not connected", "recovering from interrupt", "no adapter", "restart the instance" or "still stopping". No new instance appeared; both stayed remote and degraded; the app log has no `Spawning CLI process` or `Resolved execution location` after the last online send. |

- **Root cause:** `SideChatService.preflight` never looked at the forced worker. A send to a runtime already bound to a lost node went straight to the remote adapter, whose raw transport and stopping errors came back unchanged as `send-failed` (`side-chat-send-coordinator.ts`). The right message only existed on the fresh-spawn path (`execution-location-resolver.ts`).
- **Fix (in the worktree, uncommitted):** `preflight` now refuses a send when the sidechat's forced worker is not `connected` or `degraded`, before the runtime is touched, using the same wording and a shared helper `forcedWorkerError` in `execution-location-resolver.ts`. `ChatService` supplies the status lookup (`sideChatWorkerNodeStatus`, default: the worker registry) and treats a closed worker socket as `disconnected`, because a first live run showed the roster says `connected` for about 30 s after the socket is gone (6 of 24 sends in that window still said "Node not connected" before the socket check was added; kept in `receipts/first-run-before-socket-check`). New spec: `side-chat-service.spec.ts`, "refuses a send with the forced-worker message once the worker is gone, without touching the runtime" (disconnected, connecting, removed; no new runtime, no new input; a degraded node still sends). LT-1141 in the register is updated to FIXED in this branch.
- **Gates (worktree):** `npm run checks` exit 0 (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer); `npm run test:quiet`: 3958 files, 51,583 tests passed (ran on the Windows PC). The first `checks` run failed `check:ts-max-loc` (side-chat-service.ts at 708 of 700 lines); I shortened the change and it passes.
- **Environment:** `dev-app.js start --pc --remote-only --port 9852` on the Windows PC. I used data folder `/tmp/aio-lt-queue-c8220367b` because `/tmp/aio-lt-queue-c8220367` is still on the PC without the runner's ownership marker (a leftover of the 2026-11-18 run), and `start` refused it. Worker made with `worker-start` (pairing token on stdin only) and removed with `worker-stop` (processGone, folderGone, nodeRevoked all true). Remote nodes settings written, app restarted before the worker connected.
- **Cleanup:** worker and its Windows folder gone, dev app stopped, port 9852 closed. **Left:** both data folders (`…c8220367` and `…c8220367b`) in the PC's WSL space. I closed the app before running `shell`, so I could not remove them; they hold only isolated profiles.
- **Not tested:** OS sandboxing and hardened execution; non-YOLO approvals on a remote runtime (LT-1140, still open); a direct Windows to Mac connection; LT-SC-1 to LT-SC-6 and LT-SC-8 were not re-run (the 2026-11-10 evidence stands; the full suite above covers the shared sidechat code).
- Evidence bundle: [report.md](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-21-session-sidechats-220367-round2/report.md), `receipts/` (CDP results, worker start/stop receipts, app-log excerpt, source diff), `scripts/` (every CDP expression) and [seal.json](/Users/suas/work/orchestrat0r/ai-orchestrator/.aio-review/2026-11-21-session-sidechats-220367-round2/seal.json).
