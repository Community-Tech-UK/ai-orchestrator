# Worker ↔ Controller File Movement — Live Test Checklist

## Status — completed 2026-09-27

Open: 0 · Closed: 6 · Failed: 0 · Transferred: 1

The six agent-runnable checks in this document now pass with live evidence. The sole remaining
production-config mutation was removed from this checklist and transferred to the consolidated
[human/external residuals checklist](2026-09-27-livetest-human-external-residuals_livetest.md#res-001--remove-the-windows-worker-browser-upload-safety-net-root).

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching active remediation implementation record. A pending or unrun
> check is not automatically a defect, but a *reproduced* one belongs there, not only here.
> Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-07-16-worker-controller-file-movement-plan_completed.md](2026-07-16-worker-controller-file-movement-plan_completed.md)

## Completion evidence

| Check | Result | Date | Evidence |
| --- | --- | --- | --- |
| 1 — approvals banner | PASS | 2026-09-27 | An isolated non-YOLO Claude instance displayed the pending `browser.upload_file` request in the global banner while another page was selected. The banner exposed Approve, Deny and More options; Deny resolved the durable request and injected the exact denial notice into the live instance, which continued without retrying. More options navigated to the exact request on `/browser`. The production RLM database independently contains 136 approved upload requests with durable grants and 71 matching grants reused by `allowed/succeeded` upload audits, proving the approve/retry path completes. |
| 2 — existing-tab upload approval row and UI surfaces | PASS | 2026-09-27 | A real `BrowserApprovalStore` upload request tied to live instance `igxm3eten` rendered concurrently in the global banner, selected-instance approval card and exact `/browser?view=permissions&requestId=…` view. Denying it through the instance card removed the card and persisted `status=denied`, `actionClass=file-upload` and `decidedAt`. The live instance received the denial system message. |
| 3 — agent-facing upload guidance | PASS | 2026-08-18 | `browser_audit_entries` audit `6e46ba9e-1c5c-44fb-876d-fa633d180aef` recorded `decision=denied`, `outcome=not_run`; the deployed `aio-mcp` bundle contained the updated upload guidance. |
| 4 — Files page | PASS | 2026-09-27 | In the isolated dev renderer, real drag/drop transferred a file local→`windows-pc` and a second file worker→local. Both rows reached **Done** and the source/destination SHA-256 values matched (`64dd0b…7e3e` and `51bcb0…6de`). A send into a read-only worker root failed and did not create the target. A folder drag was a no-op: the row count stayed 3→3 and no target appeared. |
| 5 — agent folder sync | PASS | 2026-07-29 | `sync_to_node`/`sync_from_node` completed dry run, real run, identical second run and byte-identical round trip against the writable `scratch` root. `Downloads`, declared read-only, returned `remote_write_refused`. |
| 6 — streamed transfer >50 MB | PASS | 2026-07-24 | The owning 2026-07-26 evidence run recorded the large streamed transfer as passed. |

## Superseded expectation noted during the run

The July wording said autonomous credential proposals should be review-only. That expectation was
superseded deliberately by
[the 2026-09-19 persistent approvals implementation](2026-09-19-browser-persistent-approvals_plan_completed.md):
credential requests now expose Once, Session, Unattended and Forever modes, each requiring explicit
operator consent and backend enforcement. The 2026-09-27 live run observed all four modes in the
banner and Once/Session/Autonomous on the instance card, then denied the harmless proposal. The
current renderer rule test also protects the four-mode behavior; no rollback was made.

## Remote Browser Gateway confirmation

On `windows-pc`, the live Browser Gateway attached the harmless coordinator file
`aio-lt-browser-upload-check-20260927.txt` to a disposable public upload form without submitting it.
The tool returned `decision=allowed`, `outcome=succeeded`, audit
`f25b9372-56fd-4ed1-a273-da59ad2545eb`; the page accessibility tree reported the exact selected
filename. Only the disposable tab was closed, and the local temporary file was deleted afterward.

## Cleanup

Both temporary Claude instances, the isolated worker server, renderer servers and isolated Electron
processes were stopped. Ports 9761, 9229, 9230, 4968, 4661 and 4662 were absent after cleanup. The
one-time temporary roots and files were deleted after handle checks. One diagnostic Electron launch
did not answer its DevTools discovery endpoint and did not exit on TERM; it was killed by exact PID
after a bounded wait and is not counted as test evidence.
