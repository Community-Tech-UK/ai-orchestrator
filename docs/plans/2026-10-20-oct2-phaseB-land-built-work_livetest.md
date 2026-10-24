# Phase B: installed Codex backup retention

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation-followup_plan.md` (or its current
> completed successor if the register points there). Keep per-check evidence in this file.
>
> Before running a campaign, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [Phase B](2026-10-20-oct2-phaseB-land-built-work_plan.md).

## Status

On main: no. Not run against James's installed data. Isolated filesystem, settings migration and renderer
checks run in the implementation worktree; they do not prove the first installed pruning run.

## Prerequisites

- AIO's owning coordinator integrates Phase A's safety fixes and this change through the queue, runs the
  full canonical verification and obtains its independent PASS. Use a packaged build from the root
  checkout if James uses the installed app. Do not install, launch or restart Harness from this worker.
- James chooses when to restart his existing installed Harness without losing live sessions. Record the
  running build identity from Settings > About after that restart. Branch presence or local `dist/` is
  insufficient evidence.
- Browser/desktop inspection runs on `windows-pc` through the Browser Gateway after worker and channel
  preflight. If unavailable, report that health result and leave the browser check blocked. No Mac fallback.
- Decision 19(a), answered on 20 October, already authorises keep-three for the existing backlog. This is
  not a new approval request. No settings/database write from an ad-hoc script is part of this check.

## Open installed check: first keep-three run

- [ ] Before James's restart, use read-only filesystem inspection of
  `~/.ai-orchestrator/codex/backups`: list recognised automatic reconcile copies and record their count,
  timestamps and sizes; separately identify cleanup/archive copies that must remain. Do not inspect
  database content or delete files manually. Record the running build identity and current Storage toggle.
- [ ] After James restarts the integrated, packaged build, open Settings's Storage/Disk space card.
  Expected: “Keep only the newest 3 Codex backups” is on for the existing legacy backlog. A fresh isolated
  install remains off. Record the actual visible value, not an inferred migration result.
- [ ] Read the app log's `Codex backup keep-3 run` entry. Record selected, removed, failed and bytesFreed.
  Expected: at most the newest three recognised reconcile backups remain; the removal count and bytes
  agree with the before/after filesystem observation. Cleanup/archive/unrelated files and links remain.
- [ ] Ask the owning coordinator to inspect the next normal start when James chooses to restart again.
  Expected: the setting remains as chosen, and pruning removes only copies beyond the newest three.
  Turning the setting off in Storage persists and disables the next startup run. Never restart solely
  to satisfy this checkbox while live work would be lost.

Why deferred: this check is specifically the one-shot settings migration and first deletion run in James's
installed Harness. A worktree build or a test fixture cannot prove that installed event. Automated code,
filesystem safety and renderer checks must remain in-loop and are not deferred here.
