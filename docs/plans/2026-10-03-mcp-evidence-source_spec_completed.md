# MCP evidence source repair

Status: completed and independently verified on2026-10-04. Implementation: [completed plan](2026-10-03-mcp-evidence-source_plan_completed.md). [Completed live checks](2026-10-03-mcp-evidence-source_livetest_completed.md).

## Scope and acceptance

1. Restore enforced live worker discovery and a harmless Windows command, with usable returned results.
2. Associate evidence with genuine recorded source messages in the instance's canonical AIO conversation. Preserve chat/standalone ownership boundaries. Never fabricate messages, accept synthetic provenance, weaken enforcement, alter live databases or erase evidence.
3. Give repeated invocations independent capture identities. Distinguish requests blocked before execution from executed actions whose results could not be recorded. Diagnose failures using content-free codes.
4. Add regressions for the reproduced standalone transcript omission, persistence timing, ownership boundaries and fail-closed behavior; run normal project gates and a fresh independent completion review.
5. Run automated checks on windows-pc and verify the reviewed synthetic guided-tour fixture on Windows localhost: secure context, Web Crypto, replay, Next/Back, Close/focus restoration, preferences and duplicate-save guarding. Verify transferred hashes; synthetic accounts only; clean up owned resources.
6. Preserve genuine recorded user provenance throughout long turns after more than200 subsequent tool/system messages. Resolve the latest eligible user through a bounded indexed storage lookup rather than transcript-window exhaustion, preserving explicit ownership, malformed-data rejection and authoritative conversation checks.

## Constraints

Existing checkout and branch only. Preserve unrelated staged/unstaged work. No commits, pushes, dependency installs, evidence disabling, live database edits, production 12steps edits or private recovery records. Browser Gateway Windows preflight and explicit windows-pc targeting are mandatory.

## Investigation evidence

Live `list_remote_nodes` reproduced EVIDENCE_CAPTURE_REQUIRED. Separate Browser Gateway health reports windows-pc ready and deliverable. Source trace shows standalone ownership creates canonical instance conversations, while ChatTranscriptBridge drops unlinked instance events. MCP result wrapper executes before source resolution; its capture key combines source-message ID and tool name, so repeated invocations can collide. Deferred transcript batching also leaves a source-resolution timing gap.

## Activation boundary

If the running Harness needs rebuild/restart, finish the patch and runnable verification first and report the exact activation step. Windows acceptance cannot be claimed from local verification or retained reviews.

## Resumed long-turn defect (2026-10-04)

The installed initial repair restored new discovery and harmless Windows execution with correct canonical genuine-user linkage. Later calls failed before dispatch with `SOURCE_MESSAGE_MISSING`: the same source still exists at sequence1, while the latest200 of267 genuine records contains only tool results and system records. An independent read-only replay of the installed-byte-identical resolver reproduces the fallback and proves this is a lookup-window defect, without source loss or owner change. Proof: `_scratch/evidence-source-repair/windows-20261004/provenance/source-window-failure.md`. This reopens implementation and fresh verification; fixture acceptance and cleanup remain pending.

## As-built acceptance

The historical reopened/pending snapshot above is superseded by completed verification:

1. PASS: newly executed windows-pc discovery and literal PowerShell return usable results with expected stdout/exit0.
2. PASS: installed runtime and read-only live receipts associate those calls with the genuine recorded current user and correct canonical owner/conversation. No transcript fabrication or backfill, live DB edit or enforcement disabling.
3. PASS: server-owned UUID capture identities are distinct for repeated/concurrent calls; enforced failures disclose not_started versus completed/action_executed_do_not_blindly_retry using fixed content-free reasons.
4. PASS: relevant regressions and all seven normal gates pass for the unchanged31-file reviewed candidate. The final genuinely fresh task-completion-gate agent independently re-read sources/logs and re-executed native/runtime checks; VERDICT PASS with zero unresolved actionable findings.
5. PASS: newly executed Windows actual-byte hash/API tests and remote Gateway authenticated synthetic tour checks pass, including replay/Next/Back/Close/focus, reload persistence and one request/revision change for repeated clicks during saving. Owned process/files/tabs/worker resources are removed and independently checked.
6. PASS: indexed latest eligible user lookup remains correct beyond the old window. The final read-only live snapshot has349 natural later records and six distinct complete canonical receipts; migration/index/native long-tail/duplicate-key guards pass.

Final independent report: `_scratch/evidence-source-repair/windows-restarted-20261004/final-review/report.md`. Full current evidence and limits are in the completed live checks. Direct in-memory enforcement mode is not exposed; it is inferred from the matched installed executing path, startup/settings and completed authenticated receipts. Recorded creation chronology is not insertion instrumentation. Strict malformed ownership guards apply to indexed users; inherited native-call fallback remains as documented. Later unrelated changes are outside the earlier full-suite snapshot. The two user-selected lasting localhost permissions remain operator-managed; temporary test resources are cleaned up. No further activation or live check is pending for this task. This session made no commit/push/branch/worktree operation and preserved concurrent work.
