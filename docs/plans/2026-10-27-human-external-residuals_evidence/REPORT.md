# Human/external live checks: review correction evidence

27 October 2026. Prepared for the queue coordinator's independent verification. The worker has
not committed, renamed the owner, or claimed that untested residual checks passed.

## Review findings

1. **Conflicting identifiers corrected.** Copilot's double payload wrapper is **LT-780**;
   settings stdout truncation is **LT-781**. The root owner, branch register, index/detail anchors
   and follow-up agree. Every registered checkout was scanned. A first replacement, LT-712/713,
   was concurrently allocated by the compaction campaign, which then added LT-714; the final
   pair deliberately avoids that changing allocation range. See
   [allocation receipt](review-round1/id-allocation.receipt.json) and final validation receipt.
   The historical `run1/SEAL.json` and `run1/REPORT.md` retain their original LT-710/711 labels;
   those refer to this campaign's now-renumbered findings, not other campaigns' defects.
2. **The known launch method was exercised successfully.** Main build passes. The worktree's
   Electron binary with `--no-sandbox --disable-gpu --js-flags=--max-old-space-size=8192`
   started the isolated profile and debug port 9554. The initial helper's IPv4-only readiness
   URL was corrected to IPv6 localhost. The known worktree prebundle/linker failure was resolved
   with the documented `ng serve --prebundle=false` flag. Actual Angular rendering, visible
   document state, an animation frame and the Copilot warning UI were observed after focus
   emulation. No app source, sandbox setting, compiler injection or CSP was changed.
3. **Evidence is retained in this repository directory.** `run1/` contains all 45 original
   files, checked against their original seal. Historical log names map to `.log.txt` names;
   their bytes and hashes are unchanged. The preservation receipt maps each original name to
   its archive name. New evidence is under `review-round1/`. All retained files are checked for
   Git visibility. There is no dependency on a manual copy from ignored `_scratch/` at harvest.
4. **The root owner is bound to the branch evidence without copying it.** The explicit queue
   contract keeps the owner in the root checkout. The
   [harvest receipt](review-round1/harvest.receipt.json) names that file, its current hash,
   this branch/HEAD, the coordinator's candidate path and an equal content hash. The actual
   compiled `prepareClosedDocuments` ran only in memory and returned the updated root evidence.
   Its caller passes that content through `landItemBranch` into `buildLandingCommit`; source
   paths/lines are recorded in the owner. No landing, commit, document write or rename was
   invoked. Review the root owner together with the branch diff and this seal. A review using
   only the stale branch copy of the owner omits a required input. This contract does not
   authorize closing unpassed checks.

## Fresh live coverage

- RES-016: real dev IPC refuses PR creation at its capability opt-in before any external action.
  Native Cancel and unauthenticated execution both sit beyond the native approval dialog.
- RES-017: the isolated adjudication flag was enabled, read back and restored. Actual generation
  returns blocked local fallback with no auxiliary model. The production worker remains healthy
  through the packaged app, while this isolated profile is unpaired and direct worker HTTP is
  inaccessible from this source. There is no fabricated model verdict, loop result or outage.
- RES-018: the real production-advertised target configuration was validated in the isolated app;
  it fails at worker reachability, before model/inference, and creates no target. Real isolated
  enrolment/duplicate refusal still needs a reachable compatible model path. Production rerouting
  additionally retains its genuine authority boundary.
- RES-020: the authenticated Copilot ACP tool call and visible pending-tool warning were reached.
  The exact timed outcome is recorded in the root owner and final timing receipt.
- RES-021: the real default-profile Copilot path works; two-account attribution and worker-bound
  assertions remain open. The broken CLI still reproduces independently.
- RES-029: the existing secondary Claude profile authenticates by subscription and completes a
  clean one-turn JSON `ok` response with no prompt or stderr. Its CLI-reported equivalent cost
  is not billed-input evidence. No production pool or account setting was changed.

All other per-group dispositions and exact remaining actions stay in the root owner. Runtime
availability is no longer used as their blocker. Human authority, identity, native-dialog,
physical-device, original-page and judgment requirements remain explicit, without invented passes.

## Verification and preservation

Fresh main build, main/spec typechecks, lint and the uncached focused Copilot/settings/document-
preparation tests passed. Both defects reproduce again; no production code/tests were changed.
No full suite or production renderer AOT build was run for this documentation/evidence correction.

The final seal binds the root owner, changed branch documents and every retained receipt/log.
Original run-one seals retain their historical absolute locations; the current seal uses durable
repository-relative paths for the actual archives. Cleanup is recorded separately after sealing;
its receipt refers back to the pre-cleanup seal. Pre-existing dependency symlinks belong to the
queue coordinator and are preserved. No runtime, checkout or dependency tree is archived here.

Canonical owner, deliberately not copied into the worktree:
`/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-09-27-livetest-human-external-residuals_livetest.md`.

The active remediation follow-up was already tracked/committed by the previous queue checkpoint,
despite its historical "untracked" wording. This worker leaves its corrections unstaged and does
not authorize committing an active plan. The coordinator must preserve newer root reconciliation
records when integrating the appended register sections; neither shared file should be replaced
wholesale from this older base.

## Resumed worker handoff, 27 October 2026

The current report is [resume2/REPORT.md](resume2/REPORT.md), with its own final seal and cleanup
receipt. New model/enrolment/CAPTCHA partial evidence and LT-890 are recorded in the root owner.
Earlier source/runtime blockers are superseded only as that dated section states; 27 groups still
contain untested requirements, and the worker has not closed or renamed the owner.

The queue coordinator's third checkpoint removed the active shared remediation follow-up from
this branch. Its newer root copy still exists and must be preserved during integration. The old
seal's hash for that historical branch file is not a current validation claim. LT-890 uses its
own untracked root remediation plan rather than recreating the deleted active branch document.
