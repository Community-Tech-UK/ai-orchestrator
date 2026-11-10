## Snapshot of 2026-10-27-plan-queue-startup-remediation_history.md

# Plan Queue startup remediation: round history

## Resume round, 10 November 2026

Worktree `.worktrees/queue/2026-10-27-plan-queue-startup-2efa06`, clean, no diff against its merge-base with main (the WAL repair, commit `60a6da38d`, is already in the base).

Checks run in the worktree:
- `npm run test:quiet -- src/main/persistence/rlm/rlm-wal.spec.ts src/main/persistence/rlm/rlm-wal-native.spec.ts`: exit 0, 2 files, 10 tests passed.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0 ("All files pass linting").

Not run, by instruction: full suite (queue verifier owns it). Not run, deferred: the two desktop startup checks in the livetest doc (need a rebuilt desktop app; Mac desktop not authorised for this task).

Change this round: plan's opening status paragraph rewritten as a `## Status` block. No code change. Generators not rerun because no source changed.


**Native runtime proof.** Current compiled facade and actual context-worker entrypoint started
concurrently on an empty owned profile, then on the reused profile. Both exited normally; the
worker emitted ready and answered stats/shutdown. All 75 migrations were present once with
expected checksums; integrity was `ok`; reused history, checksums and timestamps were identical.
This is the real compiled SQLite/worker path using child-process IPC and Electron as Node. No
browser/window, model generation, production profile or installed app was opened. Full-desktop
and production utility-process launch remain explicit live checks, not inferred successes.

**Worker verification.** Focused six-file run passed 31 tests. Both TypeScript checks, lint,
TypeScript size/UI-hint guards, alias/IPC generators and IPC verification, normal main build
(including protocol refresh, asset sync and preload bundle), and renderer production build
passed. Generators left no source diff. Renderer retains the existing 1.65 MB bundle warning.
The final scoped review and any further verification are recorded below. The full/slow suites
are deliberately not worker claims: the current queue instruction reserves them to the verifier.

**Evidence.** Worktree-local `docs/plans/evidence/2026-11-03-plan-queue-startup/` retains the report,
per-command receipts/full logs, pre-fix RED output, native compiled startup results, review and
cleanup/seal. The existing ignore policy excludes this evidence directory from Git; coordinator
harvest must preserve it. Executable investigation helpers stay inside the worker checkout.
Dated supporting evidence was appended to the tracked owning queue livetest in the worktree.

**Register reconciliation ruling.** Searches of the actual assigned-base register found no
LT-708 definition or index entry. The newer root register also lacks that entry and explicitly
reserves LT-708 for a separate benchmark-numbering reconciliation. Its LT-709 note confirms that
reservation. Do not overwrite that unrelated record, invent a number or silently treat a missing
anchor as a verified register update. This plan and the owning queue livetest retain the historical
campaign label plus this scoped status; coordinator integration must reconcile the original
campaign record. The original retry observations and all other queue checks remain unchanged.

**Live-test deferral.** Full desktop startup requires a supported desktop session and the real
Harness launch transport. Current routing forbids opening a Mac desktop without task-specific
permission, and Harness is hard-denied for Computer Use. No Windows outage or credential
blocker is asserted. All agent-runnable SQLite/compiled-worker checks ran here. The linked live
doc gives exact isolated-profile steps, expected logs/results and cleanup.

**Final worker review and handover.** Two genuinely fresh scoped reviewers returned PASS;
the final pass inspected the latest native failure capture and both corrected live-check
wording issues. Independent uncached focused/native tests, main typecheck, changed-file lint,
diff check and secrets scans passed. Current final six-file worker run passed 31 tests uncached;
normal lint and the heap-safe spec typecheck were repeated after the final test-only change and
passed. The native test now retains the full failure object so an uncoded exception cannot
masquerade as success. Final review: worktree evidence `fresh-review-final.md`. The full-suite,
clean-state final queue gate and desktop live checks remain unchecked above.

**Cleanup.** Report, seal and command receipts were written before deleting owned runtime/build
output. Native probes already deleted their temporary databases/profiles and awaited child
exit. Only this task's generated build output and owned compile caches are removed; pre-supplied
dependencies and shared cache links remain for the verifier. The final cleanup record and seal
state the actual result. No database cluster, browser install, copied checkout, dependency copy
outside this worktree, staged change or completed-name rename was created.


