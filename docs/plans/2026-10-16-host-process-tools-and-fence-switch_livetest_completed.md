# Host process tools and signal-fence off switch — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-16-host-process-tools-and-fence-switch_plan_completed.md](2026-10-16-host-process-tools-and-fence-switch_plan_completed.md)

> **Read before checking evidence or defect numbers (added 2026-11-11, verifier repair).**
> 1. Every `evidence/...` folder named below lives in the **root checkout**
>    (`/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/evidence/`). `.gitignore:110`
>    (`docs/plans/*evidence/`) keeps them out of git, so they never appear in a queue worktree; a look
>    in the worktree's `docs/plans/evidence/` finds only unrelated folders. Their seals were re-checked on
>    2026-11-11 (see the repair section at the end).
> 2. The defect numbers **LT-723, LT-732 and LT-791** used in the older sections below were branch-local
>    and were never kept in the register (LT-723 and LT-732 belong to unrelated defects on main). The two
>    defects are now filed as **LT-1040** (Settings route exception, same failure as LT-790) and
>    **LT-1041** (`process` search misses the host tools). Older sections keep the old numbers as history.

**Prerequisites:**

- Rebuild the packaged app from this checkout (`npm run build`, which includes
  `build:aio-mcp-dist` for the MCP forwarder) and have James restart Harness when no live sessions
  need it. Never restart Harness with live sessions on an agent's own initiative.
- Why these are deferred: every Harness session runs inside the Seatbelt signal fence, so `ps`
  and `top` cannot run there, and a dev app launched from a session inherits the fence. The real
  `ps` output, a real signal, and a real unfenced spawn can only be seen from the restarted app.
  All parsing, refusal rules, spawn arguments and UI wiring are covered by unit tests.
- Use `kill -0 <pid>` to test signal permission. It sends no signal; exit 0 means "allowed",
  "Operation not permitted" means the fence blocked it.

## Checks

### LT-A1 — CPU listing works from a session

1. In a normal (fenced) Claude session, ask the agent to search the orchestrator tools for
   "process" and call `list_host_processes` with `limit: 10`.
2. Expected: 10 rows sorted by CPU, able to include programs owned by other users (with
   `nameFilter: "WindowServer"` a row with `ownedByYou: false` appears), real non-zero
   `cpuPercent` on at least one row, `summary.cpuCount` equal to the Mac's core count, and no
   `notes` entry (the environment table was readable).
3. Expected: no row shows a full command line, file path with arguments, or any `=` assignment.

Status: passed — 2026-11-07 native search and listing from a fenced Claude session; see the
2026-11-07 run at the end of this document.

### LT-A2 — A session can stop its own leftover

1. In a fenced session, run `nohup node -e "setInterval(() => {}, 1e6)" >/dev/null 2>&1 &` then
   `disown`, and note the pid. Let the shell that started it exit (end the command), so the
   program is re-parented to launchd. `pgrep -P 1 -f "setInterval"` should show it.
2. Call `list_host_processes` with `nameFilter: "node"`.
3. Expected: the row has `parentPid: 1`, `leftover: true`, `stoppable: true`.
4. Call `stop_leftover_processes` with that pid.
5. Expected: outcome `stopped`; `pgrep -f "setInterval"` no longer finds it.

Status: passed — 2026-10-27; see both dated evidence runs below.

### LT-A3 — A leftover from another live session is refused

1. Repeat LT-A2 step 1 in session A and keep session A open.
2. From session B, call `stop_leftover_processes` with that pid.
3. Expected: outcome `refused`, reason "belongs to another session that is still running". The
   program is still running. Clean it up from session A.

Status: passed — 2026-10-27 retry, then repeated on the installed app on 2026-11-11 (two separate
fenced sessions; see the 2026-11-11 section).

### LT-A4 — Programs Harness did not start are refused

1. From any session, call `stop_leftover_processes` with the pid of Finder
   (`pgrep -x Finder`).
2. Expected: `refused` with a plain reason ("still has a parent program" or "was not started by a
   Harness session"). Finder keeps running.

Status: passed — 2026-10-27; repeated in the retry below.

### LT-B1 — Per-session Fence OFF lifts the fence for that session only

1. In the new-session composer, confirm a "Fence ON" button next to "Hardened". Click it so it
   reads "Fence OFF" and start a Claude session.
2. In that session run `kill -0 $(pgrep -x Finder)`. Expected: exit 0.
3. In an ordinary session started with Fence ON, run the same command. Expected: "Operation not
   permitted".
4. Start another new session without touching the button. Expected: the button reads "Fence ON"
   again (the choice is not remembered).

Status: passed — 2026-11-18, copy outside the fence on the test Mac: Fence OFF Claude session
`kill -0` exit 0, Fence ON session "operation not permitted", next draft back to Fence ON (see the
2026-11-18 section). Earlier partial result: 2026-11-11 dev app (steps 1 and 4 only, fenced worker).

### LT-B2 — Settings switch lifts the fence for new sessions

1. Settings > Advanced > Security > "Session process fence": turn "Stop sessions from closing each
   other's programs" off.
2. Start a new session. In it, `kill -0 $(pgrep -x Finder)`. Expected: exit 0. The composer's
   Fence button reads "Fence OFF" and is disabled.
3. Ask an agent to run `$AIO_MCP settings set providerSignalFenceEnabled true`. Expected: refused
   as operator-only.
4. Turn the switch back on and start a new session. Expected: `kill -0` is blocked again.

Status: passed — 2026-11-18, copy outside the fence on the test Mac: switch off gave `kill -0`
exit 0 in a new session with a disabled `Fence: off` composer button; switch back on gave "operation
not permitted"; operator-only CLI refusal repeated (see the 2026-11-18 section). Earlier partial
result: 2026-11-11 dev app. Note the group is titled "Programs a session may stop" in the current
build, not "Session process fence".

### LT-B3 — Codex app-server session honours Fence OFF

1. Start a Codex session with Fence OFF (app-server mode, the default).
2. In it run `kill -0 $(pgrep -x Finder)`. Expected: exit 0.

Status: passed — 2026-11-18, copy outside the fence on the test Mac: a Codex app-server session
with Fence OFF and Auto-approve on returned `exit=0`; the same session with Fence ON returned
"operation not permitted". Needs Auto-approve on, because Codex's own read-only command sandbox
blocks `pgrep` with the fence off too (see the 2026-11-18 section).

## Evidence run — 2026-10-27

**Result: all seven checks assessed; two fully passed, five remain open or partial.**
No Fence OFF session was created and the global fence remained enabled. This is evidence for
the queue verifier, not permission to close or rename this document.

Evidence directory (root checkout):
[`evidence/2026-10-27-host-process-tools/`](evidence/2026-10-27-host-process-tools/).
Structured results, command receipts and `SHA256SUMS` are retained there. Times below are UTC
(also local London time on this date).

### Environment and safe test choices

- Read the campaign runbook and the linked completed implementation plan. The packaged app
  was already serving both deferred process tools: tool discovery and authenticated calls
  succeeded. The old blanket prerequisite that every process-tool check requires a packaged
  restart is therefore superseded for those already-working paths; no packaged restart ran.
- Built main and preload code from the assigned queue worktree. The forwarder build first
  failed under Homebrew Node 26 because that binary lacks the SEA fuse. Re-running with the
  repository-pinned NVM Node 24.22.1 passed; no dependency install or native-module rebuild.
- Built and served this worktree's renderer on private port 4630. Launched Electron with
  `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-6a6e4f78` and debug port 9630. Passed the app's
  existing heap flag at launch to avoid its bootstrap relaunch escaping the test supervisor.
- The normal nested Chromium sandbox launch failed (`sandbox initialization failed:
  Operation not permitted`, then fatal GPU initialisation). Used the **test-only**
  `--no-sandbox` launch documented in `docs/testing.md:34`; this does not remove the enclosing
  Seatbelt signal fence or change the provider fence setting. Both failed-attempt and final
  runtime receipts/logs are retained.
- The default dev server rendered an empty `<app-root>` with the partially compiled
  `_PlatformLocation`/missing JIT-compiler error captured in `renderer-errors.json`.
  Restarting that same worktree server with `--prebundle=false` restored the UI without any
  source edit or dependency replacement. This was a test-environment configuration issue.
- Every DOM assertion followed `Emulation.setFocusEmulationEnabled({enabled:true})`.
  Chromium did not support `Emulation.setPageVisibilityOverride`; receipts record that exact
  response, `document.hidden:false`, visible state and a successful animation frame. No
  forced Angular change detection was used. Selected the main-computer role only inside the
  disposable first-run profile. No authenticated browser, production UI or unrelated session
  was driven.

### Per-check evidence and remaining work

| Check | Current result | Dated evidence and exact residual |
| --- | --- | --- |
| LT-A1 | **PARTIAL; process-tool behaviour passed from this fenced Codex worker** | `process-checks.json`, 16:27:51: real authenticated parent-Harness RPC returned exactly ten CPU-descending rows; at least one CPU value was nonzero (highest 122.5); `summary.cpuCount:18` matched `sysctl -n hw.logicalcpu`; no `notes`. The WindowServer filter returned `ownedByYou:false`. Every returned label was a short name with no path separator, argument string or `=`. `fence-runtime.log` confirms this worker's own `ps` spawn and Finder signal-0 probe fail with `EPERM`. **Still open:** the specified fresh Claude-session repetition; this run used the existing fenced Codex worker, so it does not claim Claude-specific forwarder discovery. |
| LT-A2 | **PASS** | `process-checks.json`: bounded Node fixture PID 73525 was naturally marked by this session, became a launchd child (`parentPid:1`), and listed `leftover:true, stoppable:true`. Authenticated `stop_leftover_processes` returned `stopped`; exact-name Node PID enumeration no longer contained it. Its launcher exited, but the originating controller command stayed open throughout and owned cleanup. The fixture also had a 90-second self-exit deadline and a stop-file cleanup channel; no unattended `nohup`/`disown` recipe was used. Controller completed with the fixture absent. |
| LT-A3 | **PARTIAL; sibling-owner refusal remains untested** | `parent-refusal.json`, 16:34:47: an additional disposable, still-parented Node child was refused with `still has a parent program, so it is not a leftover`; signal-0 confirmed it remained running before the controller cleaned up its own child. This is **not** the required other-live-session branch. That branch's existing unit tests passed, but no two-session live result is claimed. **Technical prerequisite:** two disposable authenticated sessions in the same unsandboxed Harness runtime. This worker's dev app inherits its outer fence: `dev-host-read.log` records the freshly compiled real host-inspector call failing `Could not read the process list: spawn EPERM`, and the dev app's own leftover sweeper logs the same limitation. A second dev session cannot make that main process unsandboxed. No identities/capabilities were borrowed and no unrelated session's program was targeted. This is a runtime prerequisite, not a request for James to make a routine technical choice. |
| LT-A4 | **PASS** | `process-checks.json`: Finder PID 872 listed `stoppable:false`; stopping that exact PID returned `refused`, reason `was not started by a Harness session`. A subsequent listing retained the same Finder PID. No signal was sent to Finder by this refusal test. |
| LT-B1 | **PARTIAL; safe ON observations passed** | `fence-ui.json`, 16:36:32: the actual new-draft composer showed enabled `Fence ON` beside `Hardened OFF`, with Claude selected and the global setting still true. The existing fenced worker's read-only Finder permission probe returned `EPERM`. **Still open:** deliberately creating Fence OFF and Fence ON Claude sessions, comparing their signal permission, and proving the next-draft reset after creation. Current run authority keeps the fence enabled; disabling it requires James's explicit authority for that drill. No production Harness UI access is implied. |
| LT-B2 | **PARTIAL; UI presence and operator-only CLI rejection passed** | `settings-security.json` and `settings-checkbox-state.json`, 16:38:10–16:38:38: Advanced → Security contained “Session process fence”; the actual checkbox property was `checked:true`, `disabled:false`, labelled “Stop sessions from closing each other's programs (macOS)”. `$AIO_MCP settings get providerSignalFenceEnabled --json` reported true, read-only and not CLI-writable. The exact requested `settings set providerSignalFenceEnabled true --json` exited 1 with `Setting is operator-only and cannot be changed by agents`; a second get remained true. **Still open:** operator turning the global switch off/on, new-session signal probes and the disabled composer's OFF state. Only James may change that global operator-only switch; this evidence run did not do so. |
| LT-B3 | **OPEN; no Fence OFF spawn attempted** | The setting and current worker fence remained enabled. **Still open:** an explicitly authorised Codex app-server Fence OFF session and its Finder signal-0 result. No fenced-session result or unit test is substituted for the requested unfenced live behaviour. |

The human-authority residuals above concern disabling the signal fence, not credential lookup,
ordinary UI interaction, fixtures or a product-design decision. No credential or identity step
was required. The recorded automatic “keep-fence-enabled” recommendation supplied no new
authority to weaken the fence.

### Reproduced defect

**LT-723: entering Settings throws during route-snapshot lookup.** The first dashboard →
Settings navigation emitted `Cannot read properties of undefined (reading 'data')` from
`ControlSurfaceShellComponent.findActiveSurfaceId`. Repeated dashboard → Settings navigation
with a cleared capture buffer produced a fresh exception (`settings-route-repro.json`,
16:37:48). Settings subsequently rendered and the real fence checkbox remained checked;
this does not establish a failure of the process tools or fence setting.

Added an index row and full observed/root-cause/required-behaviour/acceptance entry in the
**worktree** remediation register. Implementation is not started. The matching status entry
is in the new untracked **root-checkout** plan
[`2026-10-27-control-surface-route-snapshot-remediation_plan.md`](2026-10-27-control-surface-route-snapshot-remediation_plan.md).
The runbook's old instruction to append new work to the completed July remediation plan
conflicts with the current “never add scope to completed files” rule; the new active follow-up
follows that rule and the register's existing follow-up-plan convention. The historical
`livetest-backlog.md` explicitly says not to add current status, so this owner document is the
current report; that historical index was left unchanged.

### Verification and cleanup

- `build:main`: exit 0, including preload bundling and dist asset sync.
- `build:aio-mcp-dist`: initial environment failure retained; pinned-Node retry exit 0.
- Focused quiet process inspector, instance hooks, tool-definition and settings-policy tests:
  exit 0 (55 tests across four files). These support the live evidence; they do not close the
  open live clauses above.
- `npx tsc --noEmit`: exit 0. This run changes documentation only; production source and tests
  are untouched. Full suite, lint, spec typecheck and production renderer build were not run
  for documentation-only changes; the actual dev renderer compiled and its UI was exercised.
- Cleanup and final document/diff review are recorded in `cleanup.json` and `SHA256SUMS` in
  the evidence directory. No commit, stash, branch/worktree creation, switch or document
  rename. The queue coordinator retains independent verification and closure authority.

### Coordinator reconciliation note — 27 October 2026

The identifier LT-723 above is branch-local and conflicts with the migration-race entry
already present on `queue/2026-10-15-codex-exec-progress-050f9d`. That branch's standing
register names LT-723 "concurrent migration discovery can crash the fresh-profile context
worker"; this branch uses it for the Settings route exception. Preserve both observations
and reconcile their identifiers and links before integration; neither entry supersedes the
other merely because its number matches.

The existing active [control-page route snapshot follow-up](2026-10-27-control-surface-route-snapshot_plan.md)
also records the constructor subscription reaching an absent `current.snapshot.data`, under
LT-790, from the Local AI parity campaign. Compare that report with this Settings reproduction
before creating separate implementation work. The new
[Settings follow-up](2026-10-27-control-surface-route-snapshot-remediation_plan.md) remains
untracked and active. No defect has been renumbered, merged or marked fixed by this note.

The coordinator rechecked all 44 evidence-file hashes in `SHA256SUMS`: all match. This note
does not alter those receipts or constitute an independent completion verdict. The seven
live-check results remain two passed and five partial or open.

## Evidence run — 2026-10-27 retry after verifier round 1

**Current result: three of seven checks fully passed; four remain partial or open.**
The fresh Claude repetition and the exact other-live-session refusal were exercised. A discovery
defect was found and fixed in this worktree, but the installed forwarder still fails the singular
`process` search. No Fence OFF session was created and the global switch remained enabled.
This document must remain open; the queue coordinator retains rename and closure authority.

Retry receipts and seal: [`evidence/2026-10-27-host-process-tools-retry/`](evidence/2026-10-27-host-process-tools-retry/).
All times are UTC. Earlier evidence and its original hash manifest remain unchanged.

### What the verifier findings changed

1. The earlier completion concern is accepted: partial evidence does not close this document.
   The current per-check status is explicit below. No outstanding check is represented as passed.
2. Created real disposable **Claude** sessions through one-time Harness automations, rather
   than substituting this Codex worker or an unregistered identity. `provider-runs.json` reads
   only those runs from the live app's database, records their provider and dates, and hashes
   session identities. The final owner's hash matches `claude-a1.json` and `owner-ready.json`.
   Automation `succeeded` means the turn finished, not that its probe passed: the first three
   helper attempts exited 1 and the corrected final attempt exited 0. Those receipts are retained.
3. Replaced the still-parented refusal with a real launchd child owned by a different live
   session. `provenance-check.json` cross-checks the exact PID, different identity hashes,
   owner run dates and fresh observer timestamp. The observer receipt postdates owner readiness;
   it is not a stale file, despite the final Claude summary speculating that the short run
   might have reused one. The child was present after refusal and its owner then stopped it.
4. The prior documentation-only verification statement remains an accurate historical record.
   This retry also changes two tool descriptions and adds regression coverage, so it runs the
   canonical code gates. No existing test was weakened, deleted, skipped or reconfigured.

### Per-check evidence and exact residuals

| Check | Current status | Evidence and what remains |
| --- | --- | --- |
| LT-A1 | **PARTIAL: fresh Claude listing passed; rebuilt discovery passed; installed discovery still fails** | Final `claude-a1.json` records ten CPU-descending rows, nonzero CPU, 18 cores matching `sysctl`, no `notes`, a non-owned WindowServer row, and labels without paths, arguments or assignments. Finder signal-0 returned `EPERM`, confirming the Claude session was fenced. `owner-discovery.json` records `process` discovering both tools through the newly built forwarder under that same session's own authentication. `claude-native-discovery.json` and the first three provider summaries separately record the installed/native route: singular `process` finds only settings/git tools; exact-name loading and both listing calls work. **Still open:** rerun singular discovery through the installed session integration after the corrected forwarder is installed by the normal release path. Do not treat the rebuilt helper result as an installed-app pass. This is a technical installation prerequisite, not a request to disable protection. |
| LT-A2 | **PASS, repeated from fresh Claude** | `owner-ready.json`: disposable PID 80285, `parentPid:1`, `leftover:true`, `stoppable:true` for its owner. `owner-stopped.json`: owner-authenticated outcome `stopped`. `owner-cleanup.json`: PID absent while the originating controller command was still alive. `claude-owner-final` command receipt exits 0. The child had a 90-second self-exit and stop-file channel; no unattended nohup/disown recipe was used. |
| LT-A3 | **PASS: exact live sibling branch** | `observer-finished.json`, 17:02:02: from this different live worker, PID 80285 was a launchd child, leftover, not stoppable; the stop call returned `refused`, reason **`belongs to another session that is still running`**. A second listing retained that same PID and parent. `provenance-check.json`: owner ready 17:01:59.495; observer result 17:02:02.204; owner Claude run remained running until 17:02:09.629. Its owner then stopped it at 17:02:02.458 and confirmed absence. |
| LT-A4 | **PASS, repeated** | `finder-refusal.json`: the exact Finder PID was refused as not started by a Harness session, with the same PID present afterward. The tool never sent a stop signal to Finder. The separate permission-only signal-0 probe returned `EPERM`. |
| LT-B1 | **PARTIAL: ON observations repeated; OFF drill unrun** | `dev-safe.json`: live dev composer showed enabled `Fence ON` beside `Hardened OFF`, global setting true, `document.hidden:false`, and a successful animation frame. The fresh Claude Finder signal-0 probe was blocked. **Still open:** explicit authority to create a Fence OFF Claude session, compare with Fence ON and verify next-draft reset. The current recorded choice is to keep protection enabled; the automatic readiness decision is not authority to weaken it. |
| LT-B2 | **PARTIAL: operator-only rejection repeated; global OFF drill unrun** | `fence-before.log` and `fence-after.log`: true, read-only, not CLI-writable. The exact requested `settings set providerSignalFenceEnabled true --json` exited 1 with `Setting is operator-only and cannot be changed by agents` (`fence-refused.log`). Earlier live settings checkbox observations remain valid; no global write occurred in either run. **Still open:** James operating the global switch off/on and the resulting new-session signal/composer checks. Agents may not operate this protected global switch. |
| LT-B3 | **OPEN** | No Codex app-server Fence OFF session was attempted. **Still open:** explicit authority for that unfenced spawn and its Finder signal-0 probe. Existing fenced results and unit tests are not substitutes. |

No login, credential retrieval, device, identity or product-choice step was needed. B1–B3 have
actual protection/authority boundaries. The missing installed discovery result for A1 is an
installation prerequisite, not a human design question. No production Harness UI was driven.

### Newly reproduced defect and change

**LT-791: `process` search omits both host-process tools.** The live installed forwarder and a
fresh worktree build both returned only `set_setting` and `git_batch_pull`. The descriptions
used `programs`, and the names contain plural `processes`; the existing whole-word ranker
does not stem these to singular `process`. Finding tools by exact name still worked.

The minimal fix adds singular `process` naturally to both shared descriptions. Search semantics,
schemas, caller authentication, ownership checks and fence settings are unchanged. The real
rebuilt forwarder now discovers both tools (`fixed-diagnostic-discovery.json`); added regressions
exercise the complete catalog and default search limit on deferred and stable tool surfaces.
This corrects an observed behaviour, rather than changing an assertion to accept a failure.

The initial hypothesis that the installed binary was stale was not proven and is withdrawn:
the same omission reproduced from current source before this wording fix. Preserve the native
agent's original speculative wording as history, not an independently verified diagnosis.

The worktree register has an LT-791 index row and full defect section. Matching implementation
status is in the untracked root-checkout
[`2026-10-27-host-process-discovery-remediation_plan.md`](2026-10-27-host-process-discovery-remediation_plan.md).
No new scope was appended to a completed plan. The previous LT-723 route exception and its
identifier-reconciliation note remain open and unchanged.

### Environment, verification and cleanup

- Built main/preload and the command-line forwarder from this queue checkout with Node 24.
  The dev renderer compiled on private port 4630 with `--prebundle=false`. The first readiness
  probe used IPv4 while the renderer listened on localhost/IPv6; that harness failure and its
  successful cleanup are retained (`dev-error.json`, `dev-runtime-first-receipt.json`). The
  corrected localhost probe then launched the actual dev app on port 9630 with the required
  `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-6a6e4f78`. The nested-sandbox `--no-sandbox` flag is
  confined to this dev launch; the enclosing provider signal fence remained in force.
- Focus emulation preceded every DOM assertion. Chromium again reported no
  `Emulation.setPageVisibilityOverride` method, while the actual page was visible and animation
  frames fired. `dev-probe.json`/`dev-safe.json` contain those observations. Only the disposable
  dev profile's first-run role choice and new-draft button were operated.
- Initial focused suites passed before edits. Main and spec type checks, lint, size and UI-hint
  checks, main/preload build, forwarder build and production renderer build passed after the
  change. Expanded focused process/policy/discovery suites passed. All exits and full command
  logs are in `command-receipts.jsonl`. Full-suite and independent-review outcomes are pending
  at this draft stage; the final receipt/seal will state their actual result.
- The first full suite **failed**, with 35,668 passed assertions and zero failed assertions:
  `scripts/__tests__/sea-build-repeatability.spec.ts` could not execute and Vitest reported an
  unhandled `convert-source-map` JSON parsing error. The same suite failed alone, so load is not
  claimed as its cause. A later runtime check found bare `node` resolving Homebrew Node 26 rather
  than `.nvmrc`'s 24.22.1. `node-runtime-comparison.json` confirms that the Homebrew binary lacks
  the single-executable fuse and the pinned binary contains it. With the explicit pinned binary
  and child PATH, both isolated packaging tests passed (`sea-isolated-pinned.log`). The failed
  full output/summary and failed isolated receipt remain available. The independent verifier is
  now re-running the full suite with the runtime explicitly pinned; the first full run is never
  represented as green. No packaging source or existing test was changed to obtain this result.
- The isolated dev app and renderer exited after SIGTERM and their recorded PIDs are absent
  (`dev-runtime-receipt.json`). All fixture processes were confirmed gone in their originating
  controller commands. Four one-time automations were deleted after their turns finished;
  `automation-deletions.json` reports no detached in-flight run.
- Four disposable Claude sessions remain idle in the packaged app: **Disposable host-process
  Claude live check**, **Disposable host-process Claude retry**, **Disposable Claude rebuilt
  process-tool check**, and **Disposable Claude ownership final check**. The app keeps their
  CLI processes after a completed turn (`provider-cleanup-inspection.json`). The available
  process tools refuse tracked live sessions and another session's children; production Harness
  UI is hard-denied. **Remaining human cleanup:** James can close precisely these four test
  sessions in Harness. No unrelated session may be stopped. Deleting their automation does
  not claim to terminate them.
- Runtime directory removal, final status/diff checks and evidence sealing are pending at this
  draft stage. No commit, stash, branch/worktree creation/switch or `_completed` rename occurred.


## Discovery follow-up — 2026-11-03 queue worker

This checkout implements the active
[host process discovery follow-up](2026-10-27-host-process-discovery-remediation_plan.md).
That untracked plan and its follow-up live check are maintained in the root checkout,
not copied into this worktree. No check above is closed by this worker report.

- Reproduced the singular `process` query against both the freshly rebuilt executable and
  the installed executable: both returned only `set_setting` and `git_batch_pull`. The
  whole-word ranker does not match plural `processes` in the tool names to singular `process`.
- Added singular `process` naturally to the two shared descriptions. Two new full-catalog
  regressions first failed on the real omission, then passed. The deferred case checks
  discovery and visibility through the MCP server; the stable case checks returned schemas
  and invocation instructions. No existing assertions or search semantics changed.
- The corrected executable finds both host-process tools with query `process` and no
  explicit result limit on both surfaces. Authenticated listing through this fenced Codex
  worker's own parent connection returned ten CPU-descending rows, nonzero CPU, the real
  core count, no `notes`, short labels without paths or assignments, and a non-owned
  WindowServer row. This is rebuilt-executable evidence, not a fresh Claude-session pass.
- A final installed-executable probe still omits both tools. The installed Claude discovery
  and fresh installed-session LT-A3 repetition remain open in
  [the deferred live check](2026-10-27-host-process-discovery-remediation_livetest.md).
  They require the corrected installation and a safe app/session restart; neither occurred.
- Re-read the October 27 root-checkout owner-ready, observer-finished, provenance, owner-stop,
  owner-cleanup and Claude listing receipts. Their exact sibling refusal, presence afterwards,
  owner cleanup and session timing cross-checks pass. Source hashes are retained in the current
  `historical-check.json`. These remain historical evidence; no new two-session run is claimed.
- Both production type checks, spec typecheck, renderer and main lint, size/UI-hint checks,
  alias/IPC generators and contract/export checks, main/preload build, renderer build and
  forwarder build passed under Node 24.22.1. Expanded focused tests passed (12 files, 209 tests).
  Existing warnings in unchanged files and the renderer bundle-budget warning remain in logs.
  The full suite and independent completion gate are reserved for the queue verifier.
- The process inspector, ownership/refusal rules, caller schemas and signal-fence protection
  have no diff. This worker did not stop any process, weaken the fence, create provider sessions
  or automations, use a browser, install/restart Harness, commit, or rename a planning document.
- Earlier root-checkout notes refer to LT-791 on a parked live-test branch; this worktree's
  register lacks that entry. The coordinator must reconcile those existing records during
  integration. This worker has not changed unrelated register entries or completed documents.

Current report, command receipts, full focused-test logs and SHA-256 seal are in the root checkout:
[`evidence/2026-11-03-host-process-discovery-worker/`](evidence/2026-11-03-host-process-discovery-worker/).
The report records final cleanup. Dependencies remain in the worktree for the verifier.

## Resume run — 2026-11-07

**Result: LT-A1 passes. LT-A2 and LT-A4 stand from earlier runs. LT-A3's installed repetition and
LT-B1, LT-B2 and LT-B3 remain open.** This run created no Fence OFF session, did not touch the
global fence switch, and created no provider session, automation or fixture.

Evidence: [evidence/2026-11-07-host-process-tools-resume/](evidence/2026-11-07-host-process-tools-resume/).
Times are UTC.

| Check | Status | Evidence and what remains |
| --- | --- | --- |
| LT-A1 | **PASS** | `lt-a1-native-claude.json`. A fenced Claude Code session hosted by Harness (model claude-haiku-5-5) ran orchestrator tool search for `process` with the default limit, before any exact-name load. Both `list_host_processes` and `stop_leftover_processes` were returned. `list_host_processes` with `limit: 10` returned 10 rows, CPU-descending, all nonzero (highest 210.9), `summary.cpuCount` 18 equal to `sysctl -n hw.logicalcpu`, no `notes`, short labels with no paths, arguments or assignments. `nameFilter: "WindowServer"` returned a row with `ownedByYou: false`. The Finder signal-0 probe returned "Operation not permitted" at 19:44:26Z, so the fence was active in this session. |
| LT-A2 | PASS (unchanged) | 2026-10-27 retry, repeated from fresh Claude. Not rerun today. |
| LT-A3 | **OPEN for the installed repetition** | The 2026-10-27 retry result stands: exact other-live-session refusal, same PID afterwards, owner cleanup. Not rerun today. A repetition needs two more live provider sessions. No tool available to this worker can close an interactive session (the terminate tool covers only `run_on_node` instances), so those sessions would stay idle for James to close in Harness. The ownership and refusal code has had no diff since that retry. This is a judgment call; if James wants the repetition anyway, it can go ahead. |
| LT-A4 | PASS (unchanged) | 2026-10-27 retry. Not rerun today. |
| LT-B1 | OPEN | Not run today. The fence-ON composer observations are in the 2026-10-27 retry (`dev-safe.json`). A Fence OFF session and the next-draft reset check need James's explicit authority under the recorded readiness decision. |
| LT-B2 | OPEN | Not run today. The operator-only CLI rejection was repeated on 2026-10-27. Changing the global switch is James's decision. |
| LT-B3 | OPEN | Not run today. Needs a Codex app-server Fence OFF session; same authority boundary as LT-B1. |

**Installed discovery: the 3 November failure is superseded.** `installed-discovery-2026-11-07.json`
ran the installed forwarder from `$AIO_MCP`, with query `process` and no limit, on both the deferred
and stable surfaces. Both host tools were found on both surfaces. The 3 November probe found only the
settings and Git tools. The installed binary's modification time is 7 November 09:10 local. I did not
verify which commit produced it beyond that. The JSON's `expectation` field is "missing", carried over
from the 3 November script, so its `expectedDiscovery: false` reflects that label, not a failure. Its
`caller` string is also a hard-coded 3 November label and is wrong for this run; the probe ran from a
shell inside this Claude session.

**Defects:** none reproduced in this run. LT-791 in the register now records installed discovery as
verified on 7 November, with independent verification still pending.

**Verification:** this run changed no code. The edits are the register row and LT-791 acceptance
line, this section, the follow-up live check and its plan. No code gates were rerun. The gates from
the 3 November and 27 October runs remain historical receipts.

**Cleanup:** no dev app was launched and no runtime was created. A temporary probe folder in `/tmp`
was removed. No automation, session or fixture was created.

**Still needed from James:** explicit authority for a Fence OFF drill (LT-B1 and LT-B3) and for
operating the global switch (LT-B2). For LT-A3, a decision on whether to run the installed repetition
now, knowing it leaves two extra idle sessions to close in Harness.

## Queue worker run — 2026-11-07 (merge with main, then LT-A3 attempt)

**Result: no check moved to passed in this run. LT-A1, LT-A2 and LT-A4 stand from earlier runs.
LT-A3 remains open because the installed repetition could not be started. LT-B1, LT-B2 and LT-B3
remain open because they need Fence OFF or global-switch authority that has not been given.**
Times are UTC.

### Merge resolution (branch merge with main, not committed)

- `src/main/mcp/orchestrator-host-process-tools.ts`: both sides reworded the list-tool description.
  Kept main's wording, which still contains the singular word `process` that the LT-791 search fix
  needs. The stop-tool wording is identical on both sides.
- `docs/plans/livetest-remediation-register.md`: kept both sides' rows and sections. The branch's
  Settings-route defect was also numbered `LT-723`, which main uses for a different, fixed Plan Queue
  defect. This is the collision the 27 October coordinator note asked to be reconciled. The branch's
  defect is renumbered **LT-732**, the next identifier free in the root register when rechecked with
  `node scripts/next-lt-id.mjs <root register>`. Its index row, heading, link anchor and
  implementation-status paragraph were updated. The status is now "fix in main, not yet verified"
  rather than "open", because the combined fix with LT-790 is in main (see the root-checkout
  `2026-10-27-control-surface-route-snapshot-remediation_plan_completed.md`). The old 27 October
  evidence keeps its `LT-723` references as history.
- The register parses in full (worktree next free identifier is LT-792, so LT-791 is the highest
  in this branch). Against main it has 92 added lines and no removed lines.
- Both files are staged. No conflict markers remain. Nothing was committed, and the merge is left
  in progress for the coordinator.

### Verification of the merge resolution

- `npm run test:quiet` on the four specs covering tool search and host-process tools
  (`orchestrator-host-process-tools`, `mcp-tool-search`, `tool-search-ranker`,
  `tool-discovery-budget`): exit 0, 4 files, 23 tests passed. Then
  `orchestrator-mcp-deferral.spec.ts` and `orchestrator-mcp-stable-tools.spec.ts`, which hold the
  LT-791 full-catalogue regressions for the deferred and stable surfaces: exit 0, 2 files, 21 tests
  passed.
- `npx tsc --noEmit`: exit 0.
- Not run in this pass: full suite, lint, `build:main` and `build:renderer`. The change is one
  string in a description plus documentation, and the coordinator's gates cover the rest.

### Per-check status

| Check | Status this run | Evidence and what remains |
| --- | --- | --- |
| LT-A1 | PASS (unchanged) | 7 November resume run, `lt-a1-native-claude.json`. Not rerun. |
| LT-A2 | PASS (unchanged) | 27 October retry. Not rerun. |
| LT-A3 | **OPEN, installed repetition not started** | I tried to create the second, owner, session through a one-time Harness automation. `create_automation` refused it: *"Cannot raise scheduled job model (the effective model tier is unknown or higher) above the calling session."* That refusal is a guard on this session's model tier, so I did not rename the job or change its settings to get around it. No automation was created, and no owner process or fixture was started. This session is a live separate session, so the observer side is ready. Remaining action: someone must create the owner through the Automations form (or from a session at this tier), using the same steps as the 27 October retry. |
| LT-A4 | PASS (unchanged) | 27 October retry. Not rerun. |
| LT-B1 | OPEN | Not run. Needs a Fence OFF session, which the recorded readiness decision keeps pending. The Fence ON composer evidence stands from `dev-safe.json`. |
| LT-B2 | OPEN | Not run. Needs James to operate the operator-only global switch. The CLI rejection stands from 27 October. |
| LT-B3 | OPEN | Not run. Needs a Codex app-server Fence OFF session, with the same authority boundary as LT-B1. |

### Defects

No new defect was reproduced in this run. The LT-723 to LT-732 change is a record correction from
the merge, not a new defect.

### Environment and cleanup

- The dev app was not launched. No check in this run needed it: LT-A3 needs packaged-app sessions,
  and the B checks are blocked on authority. A dev app would also inherit the outer fence, which
  blocks host process listing (27 October evidence).
- No provider session, automation, fixture or child process was created or left running. The
  disposable folder `/tmp/aio-lt-queue-a3` and the merge scratch folders were removed.

### What James needs to decide

1. **LT-B1 and LT-B3:** explicit authority for one Fence OFF session. The readiness decision keeps
   the fence on until you give it.
2. **LT-B2:** whether you will switch the global "Session process fence" setting off and on yourself.
   Agents may not change it.
3. **LT-A3:** create the owner session in the Automations form, or tell me to run it from a session
   at the right tier. That leaves one idle session to close in Harness afterwards.


## Queue worker run — 2026-11-11 (LT-A3 installed repetition)

**LT-A3 now PASSES on the installed app.** Two separate fenced sessions in the same Harness app: owner A (one-off automation session) listed its fixture PID 21388 as `parentPid:1, leftover:true, stoppable:true`; observer B (a queue worker) got `refused` / `belongs to another session that is still running`, saw the same PID afterwards, and A then stopped it (`stopped`, PID absent, controller still alive). Details and receipts: [the follow-up live check](2026-10-27-host-process-discovery-remediation_livetest.md) and `evidence/2026-11-11-host-process-discovery-worker/`. LT-B1, LT-B2 and LT-B3 are unchanged and still need James's Fence OFF / global-switch authority.

## Queue worker run — 2026-11-11 (fence UI and wiring in the dev app)

**Result: LT-A1, A2, A3 and A4 stand as passed. LT-B1, B2 and B3 are still partial: everything the dev
app can show now has evidence, and the one thing it cannot show (a real `kill -0` exit 0 from a Fence
OFF session) is the open residual.** Times are UTC. Evidence:
[evidence/2026-11-11-host-process-fence-ui-worker/](evidence/2026-11-11-host-process-fence-ui-worker/)
(`results.json`, `command-receipts.jsonl`, the scripts used, `SHA256SUMS`).

**Why the signal comparison cannot pass from here.** This worker is inside the Seatbelt fence (its own
Finder `kill -0` gave "operation not permitted" and `ps` is refused). A dev app launched from here
inherits that fence, and so does every provider process it starts, whatever the per-session flag says.
I proved this rather than assuming it: a Claude session created with Fence OFF still got `kill 980
failed: operation not permitted`, and a Codex session created with Fence OFF got
`sandbox-exec: sandbox_apply: Operation not permitted` from its own sandbox. Neither is a product result.
I did not try to start the app outside the fence (for example through launchd): that would be
sidestepping the protection this feature exists to provide.

Setup: worktree built with `npm run build:main` (exit 0); renderer served with
`ng serve --port 4639 --prebundle=false`; Electron with `--no-sandbox --disable-gpu`, `PORT=4639`,
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-7e1d9302`, debug port 9639. Focus emulation was on before
every DOM read (`document.hidden:false`). Only the disposable profile was driven (first-run role
choice, composer, its own Settings page). The switch changes below were in that profile, not James's.

| Check | Status | Evidence and what remains |
| --- | --- | --- |
| LT-A1 | PASS (unchanged) | 7 November native Claude run. Not rerun. |
| LT-A2 | PASS (unchanged) | 27 October retry. Not rerun. |
| LT-A3 | PASS (unchanged) | 11 November installed-app repetition (section above). Status line corrected from "partial". |
| LT-A4 | PASS (unchanged) | 27 October retry. Not rerun. |
| LT-B1 | **PARTIAL** | Step 1 passed: the composer showed `Fence ON` beside `Hardened: off`; clicking toggled `Fence ON` → `Fence OFF` (class gains `active`) → back → `OFF`. A Claude session created from the OFF draft is listed with `signalFence:false` (`results.json`, instance `i1ieqbw07`). Step 4 passed: after creating it, a new draft read `Fence ON`, with a different folder and with the same folder. Steps 2 and 3 (Finder `kill -0` exit 0 against "Operation not permitted") are **open**: they need a Harness not running inside a fence. |
| LT-B2 | **PARTIAL** | In the dev profile, Advanced → Security → "Stop sessions from closing each other's programs (macOS)" was checked and enabled; turning it off stored `providerSignalFenceEnabled:false`. The composer then read `Fence OFF` with `aria-disabled="true"`, opacity 0.5, and clicking it changed nothing. Turning it back on stored `true` and the composer read `Fence ON` again. Step 3 repeated: `$AIO_MCP settings set providerSignalFenceEnabled true --json` exited 1, "Setting is operator-only and cannot be changed by agents"; value still true, `cliWritable:false`. That CLI talks to the packaged app, not the dev app. **Open:** the `kill -0` results in steps 2 and 4. |
| LT-B3 | **PARTIAL** | A Codex session created from a Fence OFF draft is listed with `signalFence:false`; its process (pid 8671) ran as `codex -c tool_output_token_limit=6000 app-server`, so the default app-server mode. The probe could not run (see above). **Open:** `kill -0` exit 0 from that session on an unfenced Harness. |

**Wording differences found in this document (not product defects).** The group is titled "Programs a
session may stop" in the current build; "Session process fence" was the old name. The disabled composer
button uses `aria-disabled` and a reduced-opacity style, not the HTML `disabled` property.

**Observation, not filed as a defect.** The Fence choice is held per draft, and drafts are keyed by
working folder: toggling Fence OFF and then choosing a different folder returned the button to `Fence ON`.
It fails safe (the fence comes back on) and matches the plan's "held for the open draft only", so no
register entry. Worth knowing if someone sets Fence OFF first and picks the folder afterwards.

**What remains, and why only a person can do it.** Run B1 steps 2–3, B2 steps 2 and 4 and B3 step 2 on
a Harness that is not inside a fence: the packaged app started from Terminal or Finder. Agents cannot
drive that app (Computer Use on Harness is hard-denied) and no automation or MCP route can create a
Fence OFF session (no `signalFence` option exists there). B2 also needs the operator-only global switch
operated in that app's own Settings. Steps are unchanged from the checks above.

**Defects:** none reproduced.

**Verification:** no code changed (worktree clean). `npm run build:main` exit 0. Focused quiet suites for
signal-fence, fence scoping, the Codex app-server spawn policy, the new-session draft and settings
control policy: exit 0, 25 files, 150 tests (output was not retained at the time; superseded by the
retained round-3 receipt in the repair section below). Full suite, lint and renderer build were not run
because nothing in the repository changed.

**Cleanup:** both dev-app sessions and one extra Claude session (started by my mistake, terminated at
once) ended with `terminateInstance`; the dev app closed through CDP and its pid and port are gone; the
renderer server pids and port 4639 are gone; `/tmp/aio-lt-queue-7e1d9302*` and my scratch scripts were
removed (copies of the scripts are in the evidence folder). No automation was created and no setting in
James's real profile was changed.

## Verifier repair — 2026-11-11 (rounds 1 and 2)

Two independent verifier rounds failed this document for three reasons. Each is answered here. No
check changed status: A1 to A4 stay passed on their own dated evidence, B1 to B3 stay partial.

1. **"Cited evidence folders are absent."** They are present, in the root checkout, and are ignored by
   git on purpose (`.gitignore:110`), so a verifier reading the worktree sees none of them. I re-ran
   `shasum -a 256 -c SHA256SUMS` on 2026-11-11 (receipt `round3-receipts.txt`): `2026-10-27-host-process-tools`
   44 entries, `2026-10-31-host-process-discovery-worker` 39, `2026-11-03-host-process-discovery-round3` 23,
   `2026-11-03-host-process-discovery-worker` 83, `2026-11-11-host-process-discovery-worker` 15, and
   `2026-11-11-host-process-fence-ui-worker`: all 0 not OK. `2026-10-27-host-process-tools-retry` has 95 files
   sealed by `pre-seal-integrity.json`; `2026-11-07-host-process-tools-resume` has 2 unsealed JSON files.
   Absolute path to open: `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/evidence/<folder>`.
   Evidence cannot be committed from a worktree without overriding the ignore rule, so I did not copy it.
2. **"The defects are not in the register."** Correct: the numbers used in older sections were never
   retained. The register had no row for either defect, and LT-790 (the Local AI report of the same route
   failure) has no row either. I filed them in the worktree register as **LT-1040** (Settings route
   exception, fixed on main by walking `route.snapshot`, `control-surface-shell.component.ts:179-193`) and
   **LT-1041** (`process` search, fixed on main by the description wording, `orchestrator-host-process-tools.ts:15`),
   each with observed behaviour, root cause, required behaviour and acceptance. Numbers through LT-1036
   were already used across other documents, so I took 1040 and 1041; `node scripts/next-lt-id.mjs` now
   reports LT-1042 for the worktree register (it does not reserve numbers, so recheck before landing).
   The root plans `2026-10-27-control-surface-route-snapshot-remediation_plan_completed.md` and
   `2026-10-27-host-process-discovery-remediation_plan.md` still say LT-723/LT-790/LT-791; I did not edit
   them (a completed plan takes no new content) and this note is the cross-reference.
3. **"Focused test pass has no usable receipt."** Re-ran in this worktree, foreground, exit code captured:
   `npm run test:quiet -- <10 spec prefixes>` (signal-fence, fence scoping, Codex app-server spawn policy,
   new-session draft, settings-control policy, orchestrator MCP deferral and stable-tool specs including the
   `process` discovery regressions, host-process tools and inspector, control-surface shell): **exit 0,
   24 files, 245 tests passed in 7.4 s**. The log and summary are retained as `round3-focused-tests.log`
   and `round3-focused-tests-summary.log` in the 2026-11-11 fence-ui evidence folder, with the folder's
   `SHA256SUMS` regenerated (0 not OK). The earlier "25 files, 150 tests" line described a different, narrower
   spec set and is superseded by this run.

Not run this round: full suite, lint, typecheck and builds. Only the register and this document changed
(`git diff --stat`: the register, 34 added lines), so source gates have nothing new to cover. No dev app
or other runtime was started; the earlier one was already removed.

## Queue worker run — 2026-11-16 (resume after provider usage wait; unfenced copy never got a computer)

**Result: no check changed. LT-A1 to LT-A4 stand as passed. LT-B1, LT-B2 and LT-B3 stay partial because
the one route that could finish them did not get a computer.** Times are local London time.
Evidence: [evidence/2026-11-16-host-process-fence-remote-wait/](evidence/2026-11-16-host-process-fence-remote-wait/)
(`results.json`, `dev-app-start-wait.log`, `SHA256SUMS`).

**New route tried.** The 11 November run could not finish B1 to B3 because every dev app it started was
launched from this fenced worker and inherited the fence. `dev-app.js` (added 13 November) now starts the
copy on the test Mac over SSH instead, so the copy and the sessions it spawns would not sit inside this
worker's fence. That is the first route that could show a real `kill -0` exit 0 from a Fence OFF session
and a blocked one from a Fence ON session, in a throwaway profile, with no change to James's real settings.
This worker is still fenced (`kill -0` on Finder at 16:17: "operation not permitted").
I ran `dev-app.js start --port 9640 --data /tmp/aio-lt-queue-7e1d9302 --mac --remote-only`. `--mac` because B1
and B3 need Claude signed in, which only the test Mac has; `--remote-only` so it could not fall back to this
Mac, where a fence check proves nothing.

**What happened.** The runner waited from 16:17 to about 20:03 (about 3 hours 45 minutes) and never started
a copy. The test Mac's 5-minute load stayed above the limit of 15 on its 10 processors the whole time:
the log holds 103 readings from 21 to 215. A direct read at 17:40 (`ssh ct-test-mac uptime`) showed load
averages 176.65 / 159.00 / 150.27, and its busiest processes were `remote-checks` Node 24 workers (other
queue items' test runs, not this item's). `dev-app.js status` showed no Harness copies on the test Mac, so
nothing of mine was adding to it. The Windows PC could not be reached, and is Linux, where the Finder
`kill -0` steps do not apply. I did not start a copy on this Mac: it would inherit the fence, as proved on
11 November. I did not stop or touch the other work on the test Mac. The runner process was no longer alive when I went to stop
it at about 20:04; I did not establish why. `pgrep` found no runner, `status` showed no copies, and nothing was created on any computer.

This is a shortage of free computer time, not a missing capability, so I filed no capability gap.

| Check | Status | What remains |
| --- | --- | --- |
| LT-A1 | PASS (unchanged) | 7 November native Claude run. Not rerun. |
| LT-A2 | PASS (unchanged) | 27 October retry. Not rerun. |
| LT-A3 | PASS (unchanged) | 11 November installed-app repetition. Not rerun. |
| LT-A4 | PASS (unchanged) | 27 October retry. Not rerun. |
| LT-B1 | **PARTIAL (unchanged)** | Steps 1 and 4 and the session's flag verified 11 November. Steps 2 and 3 (`kill -0` exit 0 against "Operation not permitted") need a copy outside the fence. Rerun `dev-app.js start ... --mac --remote-only` when the test Mac load is under 15; then in the copy's Fence OFF Claude session run `kill -0 $(pgrep -x Finder)` (expect exit 0) and in a Fence ON session the same (expect "Operation not permitted"). |
| LT-B2 | **PARTIAL (unchanged)** | Same copy: switch off in that copy's own Settings, new session `kill -0` exit 0, composer button `Fence OFF` and `aria-disabled`, then switch on and `kill -0` blocked. Step 3 (operator-only CLI refusal) stands from 11 November. |
| LT-B3 | **PARTIAL (unchanged)** | Same copy: a Codex app-server session with Fence OFF. The test Mac has no Codex sign-in (13 November measurement), so the turn may not run. If it cannot, the Fence OFF spawn flag and the `codex ... app-server` command line stand as the evidence, and the exit 0 needs a computer with Codex signed in and no fence (the packaged app started from Terminal or Finder). |

**Defects:** none reproduced; no register change. **Code:** none changed (worktree clean apart from the existing
register rows). No code gates rerun; the 11 November round-3 focused run (24 files, 245 tests, exit 0) is the latest receipt.
**Cleanup:** no dev app, session, automation, data folder or setting was created or changed. `/tmp/aio-lt-evid` is a scratch
folder holding only the wait log (copied to the evidence folder) and is removed.

**Why this is not a human step.** Nothing here needs James's authority: the Fence OFF drill runs in a
throwaway copy on another computer and touches no real profile. It only needs the test Mac to be free.

## Queue worker run — 2026-11-18 (unfenced copy on the test Mac: LT-B1, B2 and B3 pass)

**Result: LT-B1, LT-B2 and LT-B3 now pass. LT-A1 to LT-A4 stand as passed.** Times are local London time.
Evidence: [evidence/2026-11-18-host-process-fence-unfenced-copy/](evidence/2026-11-18-host-process-fence-unfenced-copy/)
(`results.json`, `dev-app-start.log`, the CDP scripts, `SHA256SUMS`). No code changed; no defect reproduced.

**How the blocker cleared.** I reran `dev-app.js start --port 9640 --data /tmp/aio-lt-queue-7e1d9302 --mac
--remote-only` at 13:58. It waited for the test Mac (load 19 to 30 against a limit of 15, other items'
test runs) until about 15:36, then built and started the copy there. This worker was still fenced
(`kill -0` on Finder: "operation not permitted"). The test Mac itself is not: over SSH, `kill -0 1351`
(Finder) returned 0. Claude and Codex both reported ready in the copy's startup checks. Focus emulation
was on for every CDP call. Only the copy's disposable profile was driven. Each Claude probe command
(`kill -0 $(pgrep -x Finder); echo exit=$?`, which sends no signal) was approved once through the copy's
own permission prompt.

| Check | Status | Evidence |
| --- | --- | --- |
| LT-A1 to LT-A4 | PASS (unchanged) | Earlier dated runs. Not rerun. |
| LT-B1 | **PASS** | Step 1: composer `Fence: on` beside `Hardened: off`; click gave `Fence: off`. Step 2: that Claude session (`c2hpjhact`, listed `signalFence:false`) reported "Exit code: 0". Step 3: an ordinary Fence ON Claude session (`cnvcq0g5g`), same machine and command, reported exit 1, `kill 1351 failed: operation not permitted`. Step 4: a new draft after creating the OFF session read `Fence: on`. |
| LT-B2 | **PASS** | Step 1: Advanced > Security checkbox (`providerSignalFenceEnabled`, group "Programs a session may stop") went checked to unchecked and the stored value became `false`. Step 2: the composer read `Fence: off`, `aria-disabled="true"`, opacity 0.5, and a click changed nothing; a new Claude session (`ci7t8j07g`) reported exit code 0. Step 3: `$AIO_MCP settings set providerSignalFenceEnabled true --json` exited 1, "Setting is operator-only and cannot be changed by agents" (that CLI reaches the packaged app, not the copy; `get` shows `writable:false`, `cliWritable:false`). Step 4: switch back on stored `true`, the composer read `Fence: on` and was enabled, and a new Claude session (`c0p7uelmo`) reported exit 1, "operation not permitted". |
| LT-B3 | **PASS, with one condition** | A Codex session with Fence OFF (`signalFence:false`), default app-server mode (processes ran as `codex -c tool_output_token_limit=6000 app-server`). With Auto-approve on (`x1wgvdesr`) the tool result was `exit=0`. The control, Fence ON with Auto-approve on (`x1sc0xq14`), returned `exit=1`, `kill 1351 failed: operation not permitted`. **Condition:** with Auto-approve off (`xjsh99cxh`, Fence OFF) Codex's own read-only command sandbox stopped `pgrep` (`sysmond service not found`, `kill: not enough arguments`). That is Codex's own sandbox, not Harness's fence, so it is neither a pass nor a fail for this check; the check's expected exit 0 only appears once that sandbox is out of the way. |

**Reading the results.** Each B check has a matched pair on one machine (OFF gives exit 0, ON gives
"operation not permitted"), so the difference comes from the fence flag and not from the machine. The
Claude exit codes come from the assistant's own report of its Bash result; the Codex ones are the raw
tool results. The Fence ON Claude and Codex sessions record no `signalFence` field (default on); only OFF
sessions record `false`.

**Wording differences from the check text (not product defects).** The composer button reads
`Fence: on` / `Fence: off` (text says "Fence ON"). The settings group is "Programs a session may stop"
under Advanced > Security. The disabled composer button uses `aria-disabled`, not the HTML property.

**Defects:** none reproduced. **Code:** none changed; no code gates rerun (the 11 November round-3
focused run, 24 files, 245 tests, exit 0, is the latest receipt).

**Cleanup.** All seven sessions in the copy were ended with `terminateInstance` (none remained). The copy
was stopped (`dev-app.js stop --port 9640`; port 9640 no longer answers); `status` now shows only
another item's copy. `/tmp/aio-lt-queue-7e1d9302` and its `-w1` to `-w7` folders were removed on the test Mac;
no Codex app-server process of mine remains. No automation was created and no setting in James's real
profile changed (the switch changes were in the copy's disposable profile).

> Plan Queue parked work: `queue/2026-10-16-host-process-tools-6e4f78` — 4 commit(s), reason: land-blocked.
