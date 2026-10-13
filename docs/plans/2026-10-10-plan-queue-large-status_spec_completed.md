# Plan Queue complete large status specification

Status: ACTIVE, untracked. James explicitly authorised repairing and verifying Plan Queue in the separate orchestration project on 10 October 2026.

Current worker status (13 October 2026): existing source reverified; installed
disk now contains the streaming reader. Actual loaded Queue acceptance remains
open in [the live-test checklist](2026-10-10-plan-queue-large-status_livetest.md).
Independent verification and closure remain coordinator-owned.

Implementation plan: [plan](2026-10-10-plan-queue-large-status_plan_completed.md).

## Problem and result

The Community Tech checkout produces more than10MiB of successful Git status output. The original buffered reader in worktree-integration.ts rejected it with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and reported unable to inspect root checkout status. Preserve the original raw Git success and buffered failure evidence in the Community Tech scratch diagnosis. Fix both root status inspection paths through one complete streaming NUL porcelain reader.

## Acceptance

- Read the entire status stream successfully without a fixed total output ceiling; use bounded pending per-record storage and retain actual process-close success before acceptance.
- Preserve dirtyPolicy block-any and block-overlap, nested-worktree exclusions, managed paths, branch/ancestry and index/working-byte protections; do not filter unrelated/untracked output, increase a fixed buffer, edit ignore rules, or override ownership.
- Interpret renamed/copied source and destination in either status column, Unicode split across chunks, spaces/newlines and NUL framing. Malformed/truncated records, invalid encoding, subprocess failure, signal or timeout must fail closed. Hermetic Git environment and original timeout protection remain.
- Meaningful regressions demonstrate output over10MiB and a conflict at the end still blocks integration, unrelated large status remains protected, normal safety cases remain intact, and failure never becomes success.
- Reproduce the original error, then verify the production fixed read-only reader on the real large Community Tech checkout BEFORE durable regression additions. Do not invoke promotion or mutate that checkout for this check.
- Run focused quiet tests, all canonical applicable gates, and a genuinely fresh task-completion-gate reviewer with full skill/runbook. Fix actionable findings and repeat fresh review until PASS.
- Distinguish corrected source/built code from currently loaded running app. Qualify supported delivery and verify the actual Queue path before claiming live repair or resuming parked work. Source changes alone cannot supply this acceptance.

## Boundaries

Use the existing orchestration checkout/main; no manual branch/worktree. Preserve unrelated dirty source, documents and app sessions. No commit/push/deployment or external action is authorised by this narrow repair. No local Mac browser/desktop or Harness control. Browser work, if needed, explicitly targets windows-pc after Gateway preflight. No Queue metadata, stale-candidate repair or ownership bypass. The earlier native acceptance failures remain independently unresolved and require their own supported prospective review.

## Current as-built status, 10 October 2026, 15:27 UTC

Source and compiled behavior are independently exercised: both inspections use a complete streaming reader, meaningful focused safety/landing checks pass, and actual read-only large-checkout results equal raw Git without changing HEAD/index. Initial production verification preceded durable regressions; the subsequently hardened final helper was separately reverified. See the active plan for the exact qualified chronology and retained receipts.

Acceptance remains incomplete. Fresh task-completion-gate found no actionable owned-source defect but formally returns FAIL: full suite fails in concurrently edited foreign account code; clean INSTALL was not safely performed; installed app archive remains old and loaded Queue behavior is unverified. No package/install/restart, Queue action or document closure occurred. A temporary isolated verification-copy request is pending James's explicit permission; it grants nothing until answered. Existing checkout constraints remain in force. Full green verification, a new genuinely fresh PASS and supported loaded-runtime acceptance remain required.

## Authorised isolated verification, 10 October 2026, 15:44 UTC

James has now explicitly allowed the temporary verification worktree and its later removal. This narrow exception supersedes the preceding pending-permission state and no-manual-worktree boundary only for the identified verification copy in the plan. Root created a detached committed-baseline-plus-three-file projection without a new branch. Private normal npm ci passed with separate dependencies and contained Git/global-ignore lifecycle writes; shared Git config remained unchanged. Focused repair tests passed. Full canonical checks and a genuinely new independent review remain in progress. No app delivery, loaded Queue operation, whole dirty-checkout acceptance or document closure is inferred. All original acceptance criteria remain in force.

## Verification environment correction, 10 October 2026, 16:09 UTC

The first isolated full run failed ten unchanged native-registration assertions because its checkout lived beneath the operating system temporary directory and the existing native-home guard rejected that ancestry. Both Root and the new reviewer traced the executing guard and original tests. Supported Git move relocated the same authorised temporary worktree under the project's ignored scratch directory; no source, tests, guard, dependencies or second worktree were changed or created. Complete source/config custody stayed unchanged. Moved-copy focused93 and six canonical non-test gates passed; full tests and independent execution remain pending. Preserve the original actual failure and raw-log qualification in the linked plan. No acceptance criterion, full gate, live Queue requirement or cleanup obligation is waived.

## Root source verification, 10 October 2026, 16:24 UTC

The moved-copy normal run now completed with actual exit0: focused checks and all seven canonical gates passed, full JSON has no failures, and complete source/config custody stayed unchanged. This certifies only committed04b6 plus the three pinned repair files. Root handed the resource to the genuinely new reviewer for independent normal install/checks and compiled production-reader smoke. Independent acceptance and loaded Queue behavior remain open. Static delivery comparison also identifies four existing committed history/recovery updates that a whole app package would include; installed-only/instrumentation provenance and process memory remain qualified rather than declared safe. Plan/spec stay active, untracked and uncommitted, with the temporary-copy cleanup obligation intact.

## Independent source acceptance, 10 October 2026, 16:42 UTC

A genuinely fresh task-completion-gate reviewer now returns Source-projection PASS: independent normal install, focused checks, all canonical gates and the full suite actually passed, with complete source/config custody intact and no unresolved actionable owned-source findings. Root reread its complete primary report and independently reconciled exits, raw assertion populations and artifact/source pins. The same report explicitly returns Whole-repair FAIL because supported loaded delivery and actual Queue reader operation remain unverified. No source PASS closes that criterion. The linked plan retains exact results and evidence locations.

Bounded normal build, signed ZIP preparation and static nonlaunch verification are proceeding in the same authorised private copy; no package or installation-readiness result is inferred yet. Existing committed history/recovery differences and unattributed installed-only modules remain qualified. No installed-app control, restart, security change, Queue mutation or external delivery is authorised. All acceptance criteria and temporary-copy cleanup remain required; both documents remain active/untracked/uncommitted.

## Concrete local package, 10 October 2026, 16:55 UTC

Normal full build and signed ZIP packaging actually passed after correcting only a private temporary socket path length; original failure and separating diagnostic remain preserved. Required normal generators, native/helper/SEA builds, hardening and real local signing stayed enabled. The resulting339,343,103-byte ZIP and staged app reside outside the disposable checkout. Worker nonlaunch archive, fuse, signature, native ABI/resource and complete extraction checks passed; Root independently reconciled all actual receipt/log and sealed artifact pins. A genuinely new independent artifact reviewer is executing rechecks, so no independent artifact verdict is inferred yet.

This is a concrete local candidate, not installed generation or loaded Queue acceptance. No notarization, publication, installed-app replacement/restart or Queue operation occurred. Existing installed-provenance limits and the mandatory runtime criterion remain open. The linked plan contains exact artifact/evidence paths and retained limits. Temporary-copy cleanup and a later fresh whole-acceptance review remain required before closure.

## Independent artifact acceptance and cleanup, 10 October 2026, 17:09 UTC

A genuinely fresh task-completion-gate reviewer returns bounded artifact PASS with no unresolved actionable package findings, while explicitly retaining Whole-repair FAIL for mandatory supported delivery and actual loaded Queue operation. Root reread the primary report, reconciled all sealed review files/actual command logs and the current whole-byte ZIP pin. The app bundle backup matches installed bytes/modes/symlinks; it does not back up live user data or certify runtime rollback.

The sole authorised temporary verification worktree and its owned auxiliary containers are now removed. Supported worktree removal actually exited0 without force; every other worktree and branch record is preserved and the repair/package/evidence remain outside the deleted copy. The linked plan retains the exact receipt and the manifest-order/process-list qualifications. No source, assertion, dependency or policy was changed for cleanup.

Acceptance remains incomplete: source and package preparation passed; installed delivery, loaded Queue behavior and final whole review remain open. The linked plan contains a concrete pending human installation/restart decision with known committed updates, installed-provenance limits and active-agent interruption implications. The current temporary-copy grant supplies no app replacement/restart authority. Both documents remain ACTIVE/untracked/uncommitted; no acceptance criterion is waived or completed-document rename permitted.

## Queue worker evidence, 13 October 2026

The supplied Queue worktree already contains the committed streaming repair. No
source/test changes were required. Current focused quiet tests passed 65/65; both
typechecks, lint, LOC, main/renderer builds, alias/IPC generators and IPC/export
verification exited 0 with full retained evidence. Generators left no tracked diff.
The full suite and next fresh completion gate are assigned to the coordinator's
verifier by the current worker instruction; no current full-suite PASS is claimed.

Current compiled helper output equals raw Git across 44,462,226 bytes and 169,479
ordered path/status pairs in the real Community Tech checkout, with unchanged
HEAD/index/helper pins. This separately revalidates read-only source behavior.
The installed archive now contains the streaming calls and a reader byte-identical
to that compiled helper. It supersedes the historical need to install the 10 October
ZIP, without establishing loaded generation or granting installation/restart
authority. The process query returned `Operation not permitted`; supported
read-only Queue status supplies no loaded-module identity or live large-reader
acceptance. No live criterion is treated as passed from those limited observations.

Remaining runtime qualification and actual Queue checks are recorded in
[the active live-test document](2026-10-10-plan-queue-large-status_livetest.md).
It distinguishes James's protected-app restart boundary, if a restart is needed,
from technical prerequisites owned by the authorised Community Tech parent.
The plan gives the exact ignored root evidence-packet path and as-built limits;
receipt/log bytes were preserved outside the managed worktree for later cleanup.
Six of eight original plan items remain satisfied. Whole acceptance and document
closure stay open for the coordinator and its fresh verifier; no document is renamed,
committed, staged or copied into the worktree by this worker.
