# Agent runtime permission remediation: rebuilt-app acceptance

Status: all six checks pass with live evidence. The acceptance run is the round 3 rerun of 2026-11-14
([round 3 rerun](#round-3-rerun--2026-11-14-hidden-app-windows-preflight-retained-first)): the Windows browser
health and preflight were taken and saved first, then the whole campaign ran again from its start with every app window
forced hidden. Rounds 1 and 2 stay as history; the round 2 receipt gap is closed by round 3, not by the later repair
note. The first run found LT-1099 (explicit deny rules not matched on the legacy path), fixed in this item and rechecked.
It was filed as LT-1030 and renumbered LT-1099 on 14 November 2026 when merging `main`, which had used LT-1030 for a
different defect.

Prerequisites: a rebuilt/restarted isolated development app using the reviewed queue
checkout, an authenticated Claude CLI supporting deferred permission hooks, a disposable
workspace and the permitted Windows browser route (or a genuinely headless automated
application test). Never use the installed Harness UI or an unapproved visible Mac window.

Plan: [implementation plan](2026-10-27-agent-runtime-permission-remediation_plan_completed.md).
Owning contract: [AR-006, permission step 5](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-006--enhancements-backlog-rebuilt-app-closure-campaign).

Remediation flow: read [the campaign runbook](livetest-campaign-runbook.md) first.
Record a reproduced new defect in [the remediation register](livetest-remediation-register.md)
with a matching status section in the active remediation follow-up. Do not add new scope
to a completed plan. Keep per-check evidence here; rename this document only after every
check passes. The permission defect is called LT-708 in the owning report; that number
also appears in a separate benchmark record, so identify this defect by its plan title.

## What is already checked

The implementation worker's current tests cover cold/warm-available preflight selection,
preservation of the permission hook, stream parsing into both approval request classes,
YOLO/error-output protection, central permission-rule denial, deferred decision handling,
decision files, real hook subprocesses and the rendered approval card's scopes and copy.
Those are automated component/integration checks, not a current authenticated-provider
or rebuilt-window acceptance campaign. Historical 27 October receipts referenced by the
owning report were absent at the recorded evidence location on 31 October and are not
substituted for current proof.

## Pending external-provider and rebuilt-window check

- [x] (PASS 2026-11-14, round 3) Launch one isolated current app, using the queue checkout's build and a fresh
  disposable workspace. Build with `npm run build:main` and `npm run build:renderer`.
  Record source fingerprints and the installed Claude version. Use
  `AIO_DEV_USER_DATA_PATH` for profile isolation. Disable automatic approval/adjudication
  in that isolated profile, leave YOLO off, keep normal authentication enabled and keep
  bare mode off. Record and restore changed settings. Use the production spawn builder
  and normal instance creation, not an injected approval card. For browser work, check
  `browser.health` and preflight the target with `computer: "windows-pc"` first.
- [x] (PASS 2026-11-14, round 3) Cold path: clear only this fixture's warm slot, create a Claude session, and ask
  it to run the harmless `pwd` command. Expect a fresh adapter carrying a real
  `permissionHookPath`, a genuine `deferred_permission` event, and a visible card with
  **Remember this decision**, **Once / This session / Always**, and the duration tooltip.
  Inspect the Always consequence without submitting approval; it describes the Harness
  command rule, not a Claude global settings write. Restore Once, reject through the
  normal card, and observe the session resume and settle without running the denied tool.
- [x] (PASS 2026-11-14, round 3) Warm-available path: prewarm the same provider/workspace with the ordinary
  `WarmStartManager`, confirm a warm adapter really exists, then repeat the same create,
  prompt and rejection. Expect fresh configured spawn rather than warm adoption and the
  same genuine deferred event/card/resume behavior. Retain redacted cold/warm comparison.
- [x] (PASS 2026-11-14, round 3) Legacy path: in this isolated fixture only, use an ordinary authenticated Claude
  adapter without the permission hook and with YOLO off; ask for the same harmless Bash
  call. Add no explicit deny rule. If the provider returns the genuine error
  `This command requires approval`, require one actionable `permission_denial` event/card
  with the original Bash context and the visible action
  **Always allow (adds a rule to ~/.claude/settings.json and restarts)**. Reject and confirm
  no global rule write or restart. Do not submit Always approval. If no genuine request
  can be obtained, preserve the actual wire shape and leave this check open for capability
  review; a missing request, authentication failure or quota failure is not proof that the
  request class is obsolete.
- [x] (PASS 2026-11-14, round 3, after the LT-1099 fix; the first run failed the legacy path) Confirm an existing explicit permission deny remains a deny, without an override
  offer. Do not alter James's authored rules. Use an isolated fixture rule if needed,
  with a disposable target, then remove only that fixture rule. Confirm a failed executed
  command containing permission-like text does not produce a grant/restart card.
- [x] (PASS 2026-11-14, round 3) Terminate only fixture processes, restore settings and verify restoration. Retain
  redacted command/wire/UI receipts plus a source/build seal, then remove the isolated
  profile, workspace and build/cache runtime created for this campaign.

Why pending: this check needs a restarted isolated application and genuine authenticated
Claude service responses; synthetic NDJSON and component tests cannot prove those
observations. This worker ran all local code/static/build checks and did not launch a GUI
or submit provider approvals. Browser health reported the Windows worker ready, so this
is not a Windows availability diagnosis. No credential failure or need for James to log
in has been inferred. A later live-test worker can run this campaign within the same scope.

Actual global Always persistence is outside AR-006's wording acceptance and is not an
additional required check. No rule write or user-authored deny override is authorized by
this document.

## Evidence run — 2026-11-12 (queue worker)

Receipts: [`2026-10-27-agent-runtime-permission-remediation_evidence/2026-11-12-queue-worker/`](2026-10-27-agent-runtime-permission-remediation_evidence/2026-11-12-queue-worker/)
(`instance-receipts.json`, `renderer-state.json`, `gate-probe.json`, `card-deny2-bash.json`, `main-log-excerpts.txt`,
`source-seal.json`, `cleanup-*.json`, build logs, and the probe scripts under `probes/`). Home paths are redacted.

### Setup (check 1: PASS)

- Source: branch `queue/2026-10-27-agent-runtime-permi-67f006` at `dba478375`, clean tree apart from this worker's register
  edit. The permission fix is already in this base (`instance-spawn-preflight-chain.ts` `permissionHookRequired`;
  anchored `This command requires approval` match in `claude-cli-permission-details.ts`). File hashes: `source-seal.json`.
- Claude CLI `2.1.322`, Node 24.22.1, Electron 42 dev app (main pid 16338, read back from the inspector with this
  worktree as its working folder and `/tmp/aio-lt-queue-bb67f006` as its profile). `npm run build:main` exit 0,
  `npm run build:renderer` exit 0. A development renderer (`ng build --configuration development`, exit 0) was served
  by `http-server` on 4836 so `window.ng` existed; CDP 9836, main inspector 9837.
- Every renderer evaluation enabled `Emulation.setFocusEmulationEnabled` and `Page.setWebLifecycleState` first; each state
  read recorded `hidden:false`, `visibility:visible`.
- Settings read, none changed apart from one: `approvalAdjudicationEnabled` false, `defaultYoloMode` false, no bare mode on
  any instance (`bare:false` in every preflight record), normal authentication (real CLI login, no override). The first-run
  role card had to be chosen to reach the dashboard, which set `workerMode` from `unset` to `coordinator`; it was restored
  to `unset` and read back equal (`cleanup-renderer.json`) before the profile was deleted.
- Production spawn builder and ordinary `createInstance` were used. The only instrumentation was a read-only wrapper on
  `InstanceSpawnPreflightChain.prepare` that logged `warmBefore`, hook, YOLO, bare and the result kind.
- No browser was used: no `browser.*`/`computer.*` tools, no everyday browser, and no installed Harness. The campaign
  drove its own isolated dev app over CDP as the queue task directs, so there was no Windows browser preflight to run.
  The dev app's window opened on this Mac but was not visible (focus emulation was needed, as the runbook describes).

### Check 2 — cold path: PASS

Session `cimegi7ce`, workspace `cold-warm` (fresh, empty), prompt "Use Bash to run only rtk proxy pwd".

- Preflight at 01:57:14: `warmBefore:false, hook:true, yolo:false, bare:false, result:fresh`. The adapter's
  `permissionHookPath` was a real file (`src/main/cli/hooks/rtk-defer-hook.mjs`, exists).
- Genuine `deferred_permission` event at 01:57:19.850Z; status `waiting_for_permission`.
- Card: "Permission required: Claude wants to run Bash: `rtk proxy pwd`", label **Remember this decision**, choices
  **Once / This session / Always**, hover tooltip "Once: this command once. This session: this exact command until the
  session closes. Always: this exact command in every session."
- Always selected without approving: button **Always allow this command**, hint "Saved in Harness
  (~/.orchestrator/permissions.json) for this exact command, in every session." (the first hint in the card belongs to the
  separate Auto-approve control). That describes the Harness rule, not a Claude global settings write. Selection restored
  to Once (button "Allow this once").
- Rejected by clicking **Don't allow** on the card. The session returned to `idle` and the model said the command "never
  ran"; the transcript shows `tool_use` then "You said no: Bash", with no tool result.

### Check 3 — warm-available path: PASS

After session 1 the ordinary `WarmStartManager` pre-spawned a spare (`Warm process ready`, log line 01:57:14.690Z; the
spare had no hook). Session `cz7o9vgwf` in the same provider/workspace:

- Preflight at 01:58:30: `warmBefore:true, hook:true, yolo:false, bare:false, result:fresh`; the spare stayed in the slot
  (`hook:false` afterwards) and the log shows no `Consumed warm process` for this workspace. So the configured create refused the
  hookless spare and spawned fresh.
- Genuine `deferred_permission` at 01:58:34.862Z, the same card, tooltip and Always wording as the cold path, rejected on the card,
  settled `idle`, denied tool never ran ("You said no: Bash").
- Cold/warm comparison (redacted): both `hook:true`, both `fresh`, both deferred event within about 5 seconds of create,
  `warmBefore` false versus true. This is the opposite of the defect, where the warm create adopted the hookless spare.

### Check 4 — legacy path: PASS (with a note on card text)

Fixture: for this single create only, a one-shot wrapper dropped `permissionHookPath` from the spawn options for the
`cold-warm` workspace, so the real hookless spare was adopted (`warmBefore:true, hook:false, result:warm`). No CLI output, permission
event or renderer request was injected; YOLO off, bare off, no deny rule in play.

- Session `c77o03743`: the CLI returned the genuine tool error `This command requires approval` (tool output recorded in
  the transcript). One `permission_denial` event at 01:59:44.506Z; status `idle` waiting for a decision; one card.
- Card: "Claude wants to bash command (13 chars). Choose Always to add a Claude allow rule and restart the session, or reject to
  continue with this action denied." Visible action **Always allow (adds a rule to ~/.claude/settings.json and restarts)** and
  "The session restarts, so ask Claude to try again once it reconnects." The original Bash context (tool `Bash`, input
  `rtk proxy pwd`) is in the transcript; the card shows a masked label because non-path tool input is deliberately shortened
  (`claude-cli-permission-details.ts:213`). I treat that as the existing design, not a finding, but it is the cause of LT-1099.
- Rejected on the card (**Don't allow**). Before and after the click `~/.claude/settings.json` and
  `~/.orchestrator/permissions.json` had identical SHA-256 prefixes (`538337dbda30…`, `4fdd27319350…`), `restartCount` stayed 0,
  the adapter generation stayed 1, and no restart line appears in the log. Always was never submitted.

### Check 5 — explicit deny and executed failure: OPEN (LT-1099)

Fixtures were project rules in disposable workspaces (`<workspace>/.orchestrator/permissions.json`); James's own rule files were
not touched (hashes above unchanged).

- **Hooked path: PASS.** Workspace `deny`, rule `bash_execute` literal `bash:rtk proxy pwd` deny. Session `c55dxlqq9`
  (`hook:true`, fresh): no card and no input event. Transcript: "Permission auto-denied for Bash: Matched rule: LT fixture deny pwd";
  the model said Harness's rules blocked it and "Nobody was asked to approve it". No override offered.
- **Legacy path: FAIL.** Same rule, hookless session `chgj6g075`: genuine `This command requires approval`, then a
  `permission_denial` card offering **Always allow (adds a rule to ~/.claude/settings.json and restarts)**. Workspace `deny2` with a
  rule in the scope the legacy branch uses (`tool_use`, literal `bash:rtk proxy pwd`, deny), session `cl0ktszav`: same card.
  Pending request resource, read from the live permission flow: `scope:tool_use, resource:"bash:command (13 chars)"`.
  `gate-probe.json`: the live gate returns **deny** (`Matched rule: LT fixture deny tool_use pwd`) for `bash:rtk proxy pwd` and
  **ask** (`No matching rule`) for `bash:command (13 chars)`. So the rule works; the legacy branch feeds it the masked label.
  A read of a file outside the folder (session `cthzmn533`) showed a second oddity: resource `<folder>/from /tmp/.../data.txt`
  (the CLI wording "read from <path>" leaves a `from ` prefix). It was refused by the filesystem policy, not by the fixture
  rule, so it shows no override but does not prove the file rule works. Both cards were rejected normally; no setting changed.
  Filed as [LT-1099](livetest-remediation-register.md#lt-1099). Not fixed here: this is a live-test run, and the fix changes
  production code that needs its own plan.
- **Executed failure with permission-like text: PASS.** Workspace `readfail` holds `secret.txt` with mode 000; hookless session
  `c61e7563v` ran `cat secret.txt`. The tool output was `Exit code 1` / `cat: secret.txt: Permission denied` (it executed and
  failed). No `permission_denial` event, no card, `restartCount` 0, no pending request for that session.

### Check 6 — cleanup: PASS

All eight fixture sessions terminated through IPC (`remaining:0`); the warm spare killed; both wrapper patches restored;
`workerMode` restored and read back equal; the dev app quit via `Browser.close` and its CDP/inspector ports (9836, 9837) stopped
listening; the `http-server` on 4836 stopped; `/tmp/aio-lt-queue-bb67f006`, `/tmp/aio-lt-queue-bb67f006-ws` (including the mode-000 file)
and the development renderer build were removed. Receipts and the source seal were kept. Other workers' `/tmp/aio-lt-queue-*`
folders were left alone. A build side effect that changed the generated Codex protocol version line was reverted.

### What this run did not do

It did not submit an Always approval or any approval of the harmless command (by scope), did not test YOLO sessions, did not repeat the
cold/warm checks on a remote worker, and did not run the full test suite or any code change (none was made; the one tracked-file
edit is the register entry for LT-1099). The authenticated Claude account reported it is close to its weekly allowance during the
run; calls still succeeded.

### Follow-up — 2026-11-12, after the LT-1099 fix

The independent verifier failed round 1 on the open LT-1099 finding. Fix, in this worktree: the `permission_denial` branch of
`instance-permission-request-flow.ts` now judges the real target (`full_path`; a Bash denial as `bash_execute` /
`bash:<command>` with gate tool input `{ command }`, the same as the hooked path), and clears the pending entry when it
auto-denies; `claude-cli-permission-details.ts` drops the `from ` wording from "read from <path>". Specs added: the flow spec
group "permission_denial is judged by the real target" (three of four cases fail with the fix reverted, one is a control that
passes either way) and "extractPermissionDetails targets". Checks: the 8 related permission/preflight spec files, 184 tests
passed; `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer) exit 0, run
on the Windows PC from a snapshot of this tree. Receipts: `…_evidence/2026-11-12-queue-worker/after-fix/`.

Rebuilt-app recheck (fresh isolated profile `/tmp/aio-lt-queue-bb67f006`, main pid 60814, same CDP/inspector method, compiled
`dist/main` contained the new code), all sessions non-YOLO and hookless by the same one-shot fixture:

- Workspace `deny`, project rule `bash_execute` literal `bash:rtk proxy pwd` deny, session `cmltay7bd`: the CLI returned
  `This command requires approval`; **no input-required event and no card**; the transcript shows `Permission auto-denied for Bash:
  Matched rule: LT fixture deny pwd` and the model reports the command never ran. (The adapter's informational chat line
  "Permission required: … Choose Always …" still appears before the denial note; it is not a card and pre-dates this work.)
- Workspace `deny2`, read of `/tmp/…/protected/data.txt`, session `csttx5t05`: no card; reason now names the exact path
  (`Filesystem policy denied read access to /tmp/…/protected/data.txt`, no `deny2/from` prefix). The filesystem policy answers
  before the fixture file rule, so the file rule itself is covered by the unit spec, not by this live run.
- Control, workspace `cold-warm`, no rule, session `cubpxkfrz`: one `permission_denial` event and the card with **Always allow (adds a
  rule to ~/.claude/settings.json and restarts)**; rejected on the card; `~/.claude/settings.json` and `~/.orchestrator/permissions.json`
  hashes identical before and after (`538337dbda30…`, `4fdd27319350…`).
- Cleanup repeated: three sessions terminated, `workerMode` restored to `unset` and read back equal, patches restored, app quit, 4836/9836/9837
  closed, profile, workspaces and the development renderer build removed, generated Codex file side effect reverted.

Not repeated in this follow-up: the hooked-path deny, the cold/warm checks and the executed-failure check, because the changed code
is only the legacy `permission_denial` branch and the detail parser; their 2026-11-12 results above stand.

## Round 2 rerun — 2026-11-12 (hidden app, post-fix build) — superseded by round 3

Why: the independent verifier (round 2) said the first run's live PASS claims did not satisfy the document's rule to check
`browser.health` and preflight `windows-pc`, and that the dev-app window had opened on the Mac. The verifier then failed it because the Windows
health/preflight outputs were not retained, so [round 3](#round-3-rerun--2026-11-14-hidden-app-windows-preflight-retained-first) supersedes it. Receipts:
[`round2-hidden-app/`](2026-10-27-agent-runtime-permission-remediation_evidence/2026-11-12-queue-worker/round2-hidden-app/).

- **Windows route first.** `browser.health` at 03:09Z: status ready; `windows-pc` remote extension `channelState: fresh`,
  `commandsDeliverable: true`, `registration: ok`, contact age 7.6 s (`ct-test-mac` also fresh). `browser.preflight_target` for
  `http://127.0.0.1:4836/` with `computer: "windows-pc"` returned `allowed / succeeded`, no usable tab (expected: that address is
  this worker's own renderer server, which a browser on another computer cannot reach). So the Windows route was available and
  not blocked, but no check here is a page in a browser: every check drives the real Electron main process and the provider CLI,
  which exist only on this machine. The rerun is therefore done as a windowless application run instead.
  **Receipt gap and repair (2026-11-14).** The 2026-11-12 raw outputs of those two calls were not saved to the evidence folder (the
  figures above are from the worker's notes, not a retained file). On resume the same two calls were run again and saved, redacted
  (the raw output lists the user's other open tabs), in
  [`windows-browser-health-preflight-2026-11-14.json`](2026-10-27-agent-runtime-permission-remediation_evidence/2026-11-12-queue-worker/round2-hidden-app/windows-browser-health-preflight-2026-11-14.json):
  `browser.health` at 05:31Z on 2026-11-14 (audit id `764cac91-…`): status `ready`, 2 of 2 remote extensions ready, `windows-pc`
  `channelState: fresh`, `commandsDeliverable: true`, `registration: ok`, contact age 3.3 s, no warnings.
  `browser.preflight_target` for `http://127.0.0.1:4836/` with `computer: "windows-pc"` (audit id `d5a3376f-…`): `allowed / succeeded`,
  `selected: null`; the 30 windows-pc tabs were rejected as 17 `different_origin` and 13 `not_available`, none usable, as expected for
  an address that exists only on this Mac. This proves the Windows route was ready on 2026-11-14 and that the preflight answers as
  described; it is a fresh reading, not a replay of the 2026-11-12 one, and the app run itself was not repeated.
- **No window.** The dev app was launched with `NODE_OPTIONS="--require <hide-windows-preload.cjs>"` (kept in the receipts folder),
  which wraps `BrowserWindow` so every window is created with `show:false` and `show()`/`focus()`/`showInactive()` are no-ops, and
  hides the Dock icon. Read back from the main inspector (`window-visibility.json`): one window, `visible:false`, `focused:false`. No `browser.*` page
  tool, `computer.*` tool, everyday browser or installed Harness was used. Focus emulation was still enabled for every renderer
  read (`hidden:false`, `visibility:visible`).
- **Build under test.** `dba478375` plus the LT-1099 fix (uncommitted at run time; source and spec files listed in the follow-up
  section above), `npm run build:main` exit 0 and a development renderer build exit 0; compiled `dist/main` contained the fix.
  Profile `/tmp/aio-lt-queue-bb67f006`, main pid 24732, CDP 9836, inspector 9837, renderer on 4836. Same settings as before (adjudication
  off, YOLO off, bare off, normal authentication); `workerMode` changed to reach the dashboard and restored to `unset`.
- **Check 2, cold (PASS).** Session `caim1zqpo`, workspace `cold-warm`: preflight `warmBefore:false, hook:true, result:fresh`; hook file
  exists; status `waiting_for_permission`; card with **Remember this decision**, **Once / This session / Always**, tooltip "Once: this
  command once. This session: this exact command until the session closes. Always: this exact command in every session."; Always shows
  **Always allow this command** and "Saved in Harness (~/.orchestrator/permissions.json) for this exact command, in every session."; restored to Once;
  rejected with **Don't allow** on the card; idle; transcript "You said no: Bash", tool never ran. (This run's event subscription started a
  few seconds late, so its `deferred_permission` event is evidenced by the waiting status, the card and the approval-trace lines
  in `main-log-excerpts.txt`, not by a captured event row.)
- **Check 3, warm-available (PASS).** Session `cppwt5vid`: a real hookless spare existed (`Warm process ready` 03:13:36Z); preflight
  `warmBefore:true, hook:true, result:fresh`; `deferred_permission` at 03:14:56.313Z; same card; rejected on the card; idle. The spare was
  not consumed by this create (the only `Consumed warm process` lines are 03:15:57 and 03:17:26, the two deliberately hookless fixture creates).
- **Check 4, legacy (PASS).** One-shot fixture dropped only the hook for the next `cold-warm` create; session `c6b70x33y`: preflight
  `warmBefore:true, hook:false, result:warm`; tool output `This command requires approval`; one `permission_denial` at 03:15:58.991Z; card with
  **Always allow (adds a rule to ~/.claude/settings.json and restarts)**; rejected on the card; `restartCount` 0; `~/.claude/settings.json`
  and `~/.orchestrator/permissions.json` hashes identical before and after (`538337dbda30…`, `4fdd27319350…`). Always not submitted.
- **Check 5, explicit deny and executed failure (PASS).** Hooked, workspace `deny` with a project rule `bash_execute` literal
  `bash:rtk proxy pwd` deny, session `c7q9mzoie`: no card; "Permission auto-denied for Bash: Matched rule: LT fixture deny pwd". Legacy, same
  workspace, session `clx1zoelz` (hook dropped, spare adopted): the CLI said `This command requires approval`, but no card and no new event;
  "Permission auto-denied for Bash: Matched rule: LT fixture deny pwd" (this is the LT-1099 fix on the live path). Legacy read of
  `/tmp/…/protected/data.txt`, session `cftfgep0r`: no card; "Filesystem policy denied read access to /tmp/…/protected/data.txt" (exact path; the policy
  answers before the fixture file rule, which is covered by the unit spec). Executed failure, workspace `readfail` (mode-000 file), session `cl43s4fjv`: tool output
  `Exit code 1 / cat: secret.txt: Permission denied`; no event, no card.
- **Check 6, cleanup (PASS).** Seven sessions terminated (`remaining:0`), spare killed, patches restored, `workerMode` read back equal to `unset`, app quit and
  4836/9836/9837 closed, profile, workspaces (mode-000 file included) and the development renderer build removed, generated Codex file reverted.

## Round 3 rerun — 2026-11-14 (hidden app, Windows preflight retained first)

Why: the round 2 verifier finding was that the 2026-11-12 `browser.health` / `windows-pc` preflight were not retained, so
"Windows route first" could not be shown for the acceptance run. This rerun starts from the beginning: the Windows
health and preflight were the first actions, and their output was saved before anything was built or launched. Receipts:
[`round3-hidden-app/`](2026-10-27-agent-runtime-permission-remediation_evidence/2026-11-12-queue-worker/round3-hidden-app/)
(raw per-check outputs in its `raw/` folder).

- **Windows route first (saved before the run).** `browser.health` at 06:11:46Z: status `ready`, 2 of 2 remote extensions ready;
  `windows-pc` `channelState: fresh`, `commandsDeliverable: true`, `registration: ok`, contact age 3.0 s (`ct-test-mac` also fresh).
  `browser.preflight_target` for `http://127.0.0.1:9836/` with `computer: "windows-pc"`: `allowed / succeeded`, `selected: null`, tabs
  rejected as `different_origin` (17) and `not_available` (13) on the PC, the rest on other computers. That is the expected answer:
  the app under test is this worker's own Electron main process and the provider CLI on this machine, which a browser on another
  computer cannot reach, and no check is a page in a browser. So the Windows route was ready and not blocked, and the campaign ran as a
  windowless application run. Redacted receipt (audit ids `b1e1b08b-…` for the preflight): [`windows-browser-health-preflight-before-run.json`](2026-10-27-agent-runtime-permission-remediation_evidence/2026-11-12-queue-worker/round3-hidden-app/windows-browser-health-preflight-before-run.json).
  The raw output lists the user's other open tabs, so only the fields this check needs were kept.
- **Why this Mac and not `dev-app.js` on the test Mac.** The runbook now sends interactive dev apps to the test Mac, but its launcher
  tunnels only the page-debugging port. The legacy-path fixture needs the Electron main-process debugger (it drops the permission hook
  for one create), so this campaign needs a copy on this Mac. No window was ever shown: the app was started with the
  hide-windows preload (`hide-windows-preload.cjs` in the receipts), and the read-back from the main process was `allWindows: 0`, the one
  web contents `visible: false, focused: false` (`window-visibility.json`). No `browser.*` page tool other than the two Windows calls
  above, no `computer.*` tool, no everyday browser and no installed Harness was used. Focus emulation was enabled for every renderer read.
- **Build under test.** HEAD `8b0ed477e` (the LT-1099 fix is committed on the branch; working tree clean), `npm run build:main` exit 0, development renderer
  build exit 0 (written outside the worktree), compiled `dist/main` contains the fix. Claude CLI 2.1.325. Isolated profile
  `/tmp/aio-lt-queue-bb67f006`, CDP 9836, inspector 9837, renderer on 4836. Launch needed `--no-sandbox --disable-gpu` (an earlier launch
  without them quit at once inside the session fence). Settings: approval adjudication off, YOLO off, bare off, normal authentication;
  `workerMode` changed to reach the dashboard and `pauseOnVpnEnabled` switched off in the throwaway profile only; `workerMode` restored and read
  back equal. Source seal and hashes: `source-seal.json`.
- **Check 1, launch (PASS).** Isolated app up with the settings above; the preflight wrapper only records (it does not change the spawn).
- **Check 2, cold (PASS).** Session `cy422evt5`, workspace `cold-warm`: preflight `warmBefore:false, hook:true, yolo:false, bare:false, result:fresh`;
  the adapter's `permissionHookPath` is a real file (`rtk-defer-hook.mjs`). This time the event subscription was live: `deferred_permission`
  at 06:16:25.360Z, status `waiting_for_permission`. Card: "Permission required: Claude wants to run Bash: `rtk proxy pwd`", label **Remember this decision**,
  **Once / This session / Always**, tooltip "Once: this command once. This session: this exact command until the session closes. Always: this exact command in every session."
  Always selected without approving: button **Always allow this command**, hint "Saved in Harness (~/.orchestrator/permissions.json) for this exact command, in every
  session." (the first hint belongs to the separate Auto-approve control): the Harness rule, not a Claude global settings write. Restored to Once, rejected with
  **Don't allow**; status `idle`; transcript `tool_use` then "You said no: Bash" with no tool result, and the model said the command never ran.
- **Check 3, warm-available (PASS).** The cold session left a real hookless spare (`Warm process ready` 06:16:42Z). Session `cz22o8ngv`: preflight
  `warmBefore:true, hook:true, result:fresh`; the spare stayed in the slot (`hook:false` afterwards); `deferred_permission` at 06:17:24.632Z; same card, tooltip and Always
  wording; rejected on the card; `idle`; "You said no: Bash". The app log has no `Consumed warm process` for this create (the only two lines, 06:18:29 and 06:19:46, are the deliberately hookless fixture creates below).
- **Check 4, legacy (PASS).** One-shot fixture dropped only the hook for the next `cold-warm` create; session `c6m6wvg8s`: preflight `warmBefore:true, hook:false, result:warm`;
  genuine tool output `This command requires approval`; one `permission_denial` at 06:18:31.538Z (tool `Bash`, input `rtk proxy pwd`); card "Claude wants to bash command (13 chars). Choose Always
  to add a Claude allow rule and restart the session, or reject to continue with this action denied." with **Always allow (adds a rule to ~/.claude/settings.json and restarts)**;
  rejected on the card ("You said no: Bash"); `restartCount` 0, adapter generation 1; `~/.claude/settings.json` and `~/.orchestrator/permissions.json` hashes identical before and after
  (`258736ed2984…`, `d7bb03b7504c…`; these differ from the 12 November values because James's files changed in between, and are identical across this run). Always never submitted.
- **Check 5, explicit deny and executed failure (PASS).** Hooked, workspace `deny` (project rule `bash_execute` literal `bash:rtk proxy pwd` deny), session `cj4p5l8nx`: no card and no input event;
  "Permission auto-denied for Bash: Matched rule: LT fixture deny pwd", the model says nobody was asked. Legacy, same workspace, hook dropped from a real adopted spare, session `cuc9du2b3`:
  the CLI returned `This command requires approval`, but no card and no new event (the last event in the run is still check 4's); "Permission auto-denied for Bash: Matched rule: LT fixture deny pwd"
  (the LT-1099 fix on the live path; the adapter's informational "Permission required … Choose Always" chat line appears first, as before, and is not a card). Legacy read of
  `/tmp/…/protected/data.txt`, workspace `deny2`, session `czg24dsiw` (hookless fresh spawn): no card; "Filesystem policy denied read access to /tmp/…/protected/data.txt" with the exact path
  (the filesystem policy answers before the fixture file rule, which is covered by the unit spec, not this live run). Executed failure, workspace `readfail` (mode-000 file), hookless fresh
  spawn, session `ceq5v3s8m`: tool output `Exit code 1 / cat: secret.txt: Permission denied`; no event, no card, no pending request, `restartCount` 0.
  Note for accuracy: in `deny2` and `readfail` no spare existed, so the one-shot fixture produced a fresh hookless spawn rather than adopting a spare; the legacy `deny` create did adopt one.
- **Check 6, cleanup (PASS).** Seven sessions terminated (`remaining:0`), spare killed, patches restored, `workerMode` read back equal to `unset`, settings hashes identical before and after,
  app quit through `Browser.close`, 4836/9836/9837 no longer listening and no leftover process, then the profile, workspaces (mode-000 file included), the development renderer build and
  the probe scripts' temp folder removed. No tracked file was changed by the run (`git status` clean).

Gates on the current HEAD (after `main` was merged), run on the Windows PC on 2026-11-14: `npm run checks` exit 0 (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer); the permission specs (6 files, 73 tests) exit 0. The full suite was last run on 2026-11-12 (see below) and is left to the verifier gate for this merged HEAD.

What this run did not do: no Always approval or any approval of the command (by scope); no YOLO sessions; no remote-worker cold/warm repeat; the legacy deny rule with a file target is covered only by the unit spec.

### Full test suite

First full run (`npm run test:quiet`, ran on this Mac in 16m52s, overlapping with my own builds and two app runs, load average up to 59 earlier that hour):
exit 1, 6 of 46,746 failed, all in files this change does not touch or import (`worker-node-exec-policy.spec.ts`, `worker-rpc-dispatcher.node-ops.spec.ts`,
`rlm-process-ownership.spec.ts`, `plan-queue-pause-control.spec.ts`: descendant-process fixtures and 5-second timeouts). The verifier's earlier
red run named a different mix of the same spec families. The same four files re-run alone: 247 tests passed, exit 0. A second full run with nothing else
of mine running, on the Windows PC: **3687 files, 46,735 tests passed, exit 0** (6m 24s). The branch diff is only
`instance-permission-request-flow.ts`, `claude-cli-permission-details.ts` and their two specs, so the earlier failures are load-dependent
flakes, not regressions; no merge-base full run was needed once the full run passed on the tree under test.
