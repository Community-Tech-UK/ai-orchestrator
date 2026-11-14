# Host process discovery installed-session follow-up

> **Found a defect?** Record it in `docs/plans/livetest-remediation-register.md` with an index
> row and observed behaviour, root cause, required behaviour and acceptance. Record matching
> implementation status in a new active follow-up plan; never extend a completed plan.
> Per-check evidence stays in the owning live-test document. Read
> `docs/plans/livetest-campaign-runbook.md` before continuing. Its older Mac-browser fallback
> and completed-plan editing advice are superseded by the current agent instructions.

Plan: [host process discovery remediation](2026-10-27-host-process-discovery-remediation_plan.md).
Owner: [host process tools and fence live test](2026-10-16-host-process-tools-and-fence-switch_livetest.md).

Status: all checks run; LT-A1 passed 2026-11-07 and LT-A3 passed 2026-11-11 (see the evidence section at the end). The worker has not closed or renamed either document; the coordinator's verifier decides.

## Prerequisites and reason for deferral

- Use a Harness installation containing the verified change from this queue checkout, installed
  through the normal build/release path. Any required app restart must wait until James can
  safely restart it without disrupting live sessions. No restart or installation occurred here.
- Keep the global signal fence enabled. Create an ordinary fresh fenced Claude session through
  Harness; do not borrow another session's identity or capability.
- On November 3 the installed executable again returned only settings and Git tools on both
  tool surfaces. This was a direct installed-binary probe from the fenced Codex queue worker,
  not a new Claude-session run. Unit tests, the CLI and the dev app can prove the
  rebuilt path; they cannot prove that a new Claude session uses the corrected installed binary.
  This installation/reconnection check therefore genuinely needs the updated running app.
- Current root-checkout receipts: `evidence/2026-11-03-host-process-discovery-worker/`.
  October 31 receipts remain in `evidence/2026-10-31-host-process-discovery-worker/`. Earlier exact
  sibling refusal and owner cleanup remain in `evidence/2026-10-27-host-process-tools-retry/`.
  Neither historical evidence nor a rebuilt-helper call counts as installed-session discovery.

## Deferred check: LT-A1 installed Claude discovery

- [x] (Passed 2026-11-07, see the owner document's resume run.) In that fresh fenced Claude session, use its native orchestrator tool search for the exact
  query `process`, omitting `limit` (the default is five). Both `list_host_processes` and
  `stop_leftover_processes` must appear. Record the actual names and session provenance safely,
  without printing private connection values. Do not load by exact name before this assertion.
- [x] (Passed 2026-11-07.) Invoke the discovered listing tool with `{ "limit": 10 }`. Expect ten rows ordered by
  descending CPU, at least one nonzero CPU value, the actual Mac core count, no `notes`, and
  short labels without command arguments, paths or assignments. With
  `{ "nameFilter": "WindowServer" }`, expect a row with `ownedByYou: false`.
- [x] (Recorded 2026-11-07.) Record the installed build and fenced-session evidence in the owning live-test document. The installed build's identity is known only from its modification time (7 November 09:10 local), not from a commit.
  A rebuilt CLI probe alone does not pass this check. Close this follow-up only after every
  assertion passes and the coordinator's independent verifier accepts the result.

## Deferred check: LT-A3 fresh installed-session repetition

The required two-live-session repetition already has October 27 receipts: owner-ready,
observer-finished, provenance-check, owner-stopped and owner-cleanup. They show the exact
other-live-session refusal, the same PID remaining present, and owner-authenticated cleanup.
The worker re-read and cross-checked these receipts on November 3; no fresh two-session run is
claimed. The historical source hashes and checks are in the current evidence directory's
`historical-check.json`. The repetition against the corrected installation remains open:

- [x] (Passed 2026-11-11, round 2.) Two fenced sessions in the same installed Harness app: A (owner) and B (observer, this worker). A ran one bounded self-expiring fixture (PID 21388) under a controller that stayed alive throughout, with a stop-file channel and a 240-second self-exit.
- [x] (Passed 2026-11-11.) A listed PID 21388: `parentPid: 1`, `leftover: true`, `stoppable: true`. B listed the same PID, then `stop_leftover_processes` for only that PID returned `refused`, reason `belongs to another session that is still running`.
- [x] (Passed 2026-11-11.) B listed it again: same PID present, parent 1. A then stopped only its own fixture (`stopped`) and the PID was absent before the controller exited. The observer finished at 06:46:22Z while A's controller ran until 06:46:25.7Z.
- [x] (Recorded 2026-11-11.) Cleanup: both one-off automations deleted; both owner runs had already ended (`detachedInstanceIds: []`); no fixture process remained. Session B is this queue worker, closed by the coordinator.

This checks the installed integration after the actual fix is installed. The rebuilt CLI and
unchanged-refusal unit tests do not substitute for that installed-session repetition.

Fence-OFF tests B1–B3 are not part of this discovery fix. They remain open in the owner document.
Only James may operate the protected global switch. No automatic readiness result authorizes
weakening the fence, and no credential or login action is required for this discovery check.

## Evidence run — 2026-11-11 (LT-A3, installed two-session repetition)

**Result: LT-A3 passes. LT-A1 passed 2026-11-07. Nothing in this document remains open.** Times UTC.
Receipts, report and SHA-256 seal: `docs/plans/evidence/2026-11-11-host-process-discovery-worker/` (`REPORT.md`, `SHA256SUMS`, `round1/`, `round2/`).

- **How session A was created.** A one-off hidden automation (`create_automation`). The 7 November model-tier refusal did not recur this time (same model tier, no model override). Each owner run was its own Harness session; no identity or capability was borrowed. B is this fenced Claude queue worker (claude-sonnet-5-5). The installed app's build is identified only by its 7 November 09:10 modification time, not a commit.
- **Round 1 (PID 74234, 06:40).** B saw `parentPid:1`, `leftover:true`, `stoppable:false`; the stop call returned `refused` with the exact reason; A then stopped it (`stopped`) and it was absent. A's own listing recorded no row because my prompt filtered by the label `node` while the fixture's label is `fixture`. That was a prompt fault, so I re-ran rather than count it.
- **Round 2 (PID 21388, 06:46), the result of record.** A's listing (`round2/a-listed.json`, 06:46:15): `parentPid:1, leftover:true, stoppable:true`. B (06:46:2x): `stoppable:false`, `refused`, `belongs to another session that is still running`; re-list showed the same PID. `observer-finished.json` 06:46:22; A's `stopped` result, `controller-done.json` (fixture absent, 06:46:25.7) and `a-cleanup.json` (gone) followed.
- **Safety.** Only PIDs 74234 and 21388 were ever passed to the stop tool. No unrelated process was targeted, the fence stayed on, no dev app was launched (A3 is an installed-app check), and no code changed.
- **Defects:** none reproduced. No register entry added.
- **Cleanup:** both automations deleted; `/tmp/aio-lt-queue-380e3101` removed; no dev app or background command left running.

## Evidence run — 2026-11-11 (corrections after verifier round 1)

Two verifier findings, both addressed:

1. **Missing register entry for the discovery defect (LT-791).** Confirmed: the entry had been written
   on the parked branch `queue/2026-10-16-host-process-tools-6e4f78` (commit `b7fed11ba`) and never
   reached this register. Recreated in `docs/plans/livetest-remediation-register.md` (index row plus
   `## LT-791` section: observed behaviour, root cause, required behaviour, acceptance). Status is
   "fixed on main, verified live, independent verification pending". The 7 Nov owner-document note that
   "this worktree's register lacks that entry" is now historical. Targeted checks re-run today:
   `npm run test:quiet` on `orchestrator-host-process-tools`, `orchestrator-mcp-deferral`,
   `orchestrator-mcp-stable-tools` and `tool-search-ranker` specs: exit 0, 4 files, 37 tests passed.
2. **LT-A1 receipt not findable.** The receipt exists, but in the root checkout at
   `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/evidence/2026-11-07-host-process-tools-resume/`
   (not `<repo>/evidence/`). `.gitignore:110` (`docs/plans/*evidence/`) keeps that folder out of Git, so
   it is absent from any worktree and from repository-wide searches. Both files there are listed below with
   their SHA-256, and `lt-a1-native-claude.json` is quoted in full so the pass can be checked without that folder.
   The 11 Nov receipts were moved from `<repo>/evidence/` to `docs/plans/evidence/2026-11-11-host-process-discovery-worker/`
   to sit with all the other host-process receipts.

SHA-256: `lt-a1-native-claude.json` c3e29d1c7d75c5a0bad6515c9125e99919c0a8ffa6f09e26183ff9c84ba0478c;
`installed-discovery-2026-11-07.json` 72bba3586e1db215c6973adbfe392694b3b1152bb823c61f5140a6e76a35bd22.

`lt-a1-native-claude.json` (verbatim):

```json
{
  "check": "LT-A1 native discovery and listing from a fenced Harness Claude session",
  "date": "2026-11-07",
  "caller": "Claude Code session on claude-haiku-5-5, hosted by Harness; fence enabled (see fence probe)",
  "discovery": {
    "tool": "orchestrator_tool_search",
    "query": "process",
    "limitOmitted": true,
    "orderOfOperations": "discovery ran before any exact-name load",
    "matchedNames": ["set_setting", "git_batch_pull", "stop_leftover_processes", "list_host_processes"],
    "bothHostToolsFound": true
  },
  "listing": {
    "tool": "list_host_processes",
    "args": { "limit": 10 },
    "rowCount": 10,
    "cpuDescending": true,
    "highestCpuPercent": 210.9,
    "nonzeroCpuRows": 10,
    "summaryCpuCount": 18,
    "macLogicalCpuCount": 18,
    "notesPresent": false,
    "labelsShortNoPathsArgsOrAssignments": true,
    "labels": ["tsc", "vitest", "Microsoft", "spotlightknowledged", "Application", "claude", "signpost_reporter", "socketfilterfw", "mds", "node"]
  },
  "ownershipFilter": {
    "tool": "list_host_processes",
    "args": { "nameFilter": "WindowServer" },
    "rows": [{ "label": "WindowServer", "ownedByYou": false, "stoppable": false, "stopRefusal": "is not owned by you" }],
    "nonOwnedWindowServerRowPresent": true
  },
  "fenceProbe": {
    "command": "kill -0 <Finder pid>",
    "signalSent": false,
    "resultAt": "2026-11-07T19:44:26Z",
    "result": "Operation not permitted (exit 1)",
    "meaning": "fence still blocks signal permission in this session"
  },
  "verdict": "PASS for the LT-A1 assertions above. The installed native discovery now finds both host tools on query process."
}
```

The receipt records the caller as a fenced Harness Claude session on claude-haiku-5-5 and an exact `process`
search with the limit omitted. The installed build's identity remains known only by its modification time
(7 November 09:10 local).

## Evidence run — 2026-11-14 (resume after the landing was parked)

No check was open, so nothing was re-driven and no dev app was launched.

- **Why it was parked.** Landing was refused, not the work: the root checkout had uncommitted edits to `docs/plans/livetest-remediation-register.md` (about 494 added lines from other items), and this item also adds the LT-791 entry to that file. The agent cannot commit or put away another session's changes. The coordinator can land this item once those edits are committed or set aside.
- **LT-791 still free.** `LT-791` appears in neither the root register (including its uncommitted edits) nor main's committed copy; the branch holds the only entry (index row plus `## LT-791`, 46 added lines, the branch's only difference from its merge base). The branch is behind main, so the coordinator's merge-main step applies.
- **Targeted checks re-run today:** `npm run test:quiet` on `orchestrator-host-process-tools`, `orchestrator-mcp-deferral`, `orchestrator-mcp-stable-tools` and `tool-search-ranker` specs: exit 0, 4 files, 37 tests passed (Windows PC remote run). A first attempt with a wrong path produced no report and is not counted.
- **Defects:** none new. **Cleanup:** nothing created that needs removing (no dev app, no data folder, no automations).
