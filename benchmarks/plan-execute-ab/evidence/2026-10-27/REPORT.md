# Local-model live-test evidence — 27 October 2026

Status: **partial evidence handoff; pilot and document remain open**. The coordinator owns
independent verification and any rename. No new paid benchmark invocation, commit, branch,
worktree, hosted-code sharing, full-run authorization or BIOS change was made.

The canonical per-check record is the original root-checkout document:
`/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.
It was edited there only. This report is an evidence receipt, not a copy of that document.

## What ran

- Recovered the current standalone benchmark unchanged from `9cc19c6d6`. Its source seal
  compares every recovered source file against that checkpoint. The temporary runner copy is removed after sealing, as requested; the source remains recoverable
  from that checkpoint. The assigned checkout and branch remain on base `7c8922a37`.
- Built both app processes. Ran an isolated dev app with the required profile and debugging
  port. Focus emulation preceded DOM observations; real preload IPC succeeded. A new-profile
  migration race was recorded as LT-710; restarting that initialized disposable profile
  allowed testing. Host Chromium sandbox initialization required `--no-sandbox` for this test.
- Paused helper routing, started settled native 2.60.0 with the 35B at context 65536/parallel 1,
  and proved key enforcement (401/401/200) from Mac and Windows plus a tailnet-only listener.
  The documented pre-task placeholder key was reused; no new private credential was provisioned or transferred.
- Measured a real 36,071-token prompt: server cold prompt 2787.89 tok/s, subsequent prompt
  11979.62 tok/s and decode 17.32 tok/s. The runner's derived 51.32 write figure is retained
  but not substituted for server decode timing. Loaded PCIe samples show Gen 5 ×16.
- The 35B completed Read/Edit/Bash and npm test in about 31 seconds, without tool errors.
  Independent file/test checks passed. Its second request did not reuse cache; later requests
  did. This leaves A4's second-turn criterion open as LT-712.
- Checked the archived task's scoring control. Current Vitest causes loader errors (LT-709).
  An owned temporary Vitest 3.2.7 selection removes that error, but the known-broken parent
  and fixed AIO-01 both pass all 40 tests, twice (LT-711). No hidden tests were changed.
- Recovered original worker command receipts corroborating the 25 October completed C1/C2
  batches. Missing full records and patches were not invented. The portable session still
  contains 32 records (A/D/G ten each, C1 two), and a real report regeneration correctly
  withholds both pilot comparison decisions. Historical 50-record printed results remain
  separate and provisional.

## Disposition of every check

| Check | Disposition |
|---|---|
| A1 | Prior download/load completion retained; no new integrity claim. |
| A2 | Native serving/authentication proved; equivalent WSL2 toolchain absent and optional tuning unrun. |
| A3 | 35B real-prompt and loaded PCIe measurements recorded; C2's prior gate retained without a new C2 measurement. |
| A4 | Tool task passes; second-turn cache acceptance fails (LT-712). |
| A5 | No new B score accepted: current scoring controls fail (LT-709/LT-711). |
| A6 / R-A | Historical settled-engine execution corroborated; portable full-record/patch recovery and sound scoring remain open. |
| A7 | Historical C2 execution corroborated; raw-data recovery and sound current comparison remain open. |
| A8 | Interim report regenerated; complete six-arm comparison/subscription conclusion unavailable. |
| B1 | Hosted code sharing not authorized; arm E skipped. |
| B2 | James's optional personal prompt review not supplied or inferred. |
| B3 | Separate full-run spend authority absent; pilot also incomplete. |
| B4 | Conditional BIOS action not eligible on the current validated evidence; physical action not attempted. |
| C1 finishing | Evidence recorded, no completion rename or completion claim. |

## Verification

`receipts.jsonl` preserves actual command exits. Benchmark tests passed (182), benchmark and
root typechecks, spec typecheck, lint, explicit benchmark ESLint, LOC/UI-hint checks and both
builds passed. Dev focus/IPC and local tool smoke also ran successfully. Scoring preflight
commands intentionally remain nonzero failed evidence.

The broader repository test command was interrupted at partial handoff with **exit 143**.
It is **not passed**. `full-suite-interruption.json`, `full-suite.log` and the complete captured
partial output in `full-suite.partial.log.gz` preserve that limitation. No test or application
source was edited to obtain a passing result. Independent coordinator verification is pending.

Retained metered total: **$66.278098505**, maximum headroom **$13.721901495**. This remains
retained CLI evidence with its earlier reconstruction limits, not invoice confirmation. Remote
diagnostic agents used Codex; this report makes no claim that the campaign used zero cloud tokens.

## Cleanup and limits

The dev app exited cleanly with eight completed shutdown phases. Its owned PIDs and ports are
gone. Windows native PID 72920 was stopped, port 1235 closed, helper 35B restored IDLE at context
229376/parallel 2, routing restored and read back `local-first`, and the three owned remote
diagnostic instances terminated. No automations were created (isolated database count zero).

`cleanup-receipt.json` records removal of the local owned profile, source exports, historical
dependency installation, compiled output, temporary recovered runner/source evidence and identifiable owned caches after this report and
the initial source seal were written. Pre-existing dependency links, historical session data,
model downloads, the pre-task key file and AIO worktrees are preserved.

Automatic approval review rejected recursive and file-by-file deletion on Windows with
**“blocked by policy”**. Original policy errors are retained in
`remote-cleanup-policy.receipt.json`. An independent file listing confirms eight small files
remain under `C:\Users\shutu\Documents\Work\_scratch\queue-7ca7a00e-20261027-130100-5e195fa7`.
No alternate deletion channel was used. This cleanup residual is explicitly incomplete.

LT-709 through LT-712 have register entries and matching status in the active remediation
follow-up. No completed plan/spec was edited. The historical backlog received an owner link;
current check statuses remain in their owning document as that index instructs.
