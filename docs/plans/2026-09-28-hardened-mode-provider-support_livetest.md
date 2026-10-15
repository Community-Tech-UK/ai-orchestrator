# Hardened Mode Provider Support — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`.
> Per-check evidence stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plans: [2026-09-28-hardened-mode-provider-support_plan_completed.md](2026-09-28-hardened-mode-provider-support_plan_completed.md)
(Phase 0) and [2026-09-28-hardened-mode-provider-enablement_plan_completed.md](2026-09-28-hardened-mode-provider-enablement_plan_completed.md)
(enablement).

## Prerequisites

- Rebuild and restart Harness from a checkout that contains the enablement plan's changes
  (`npm run build:main`, `npm run build:renderer`, or a packaged build). Do not use an older build.
  Never restart the packaged Harness while James has live sessions. He restarts it himself.
- Use the provider accounts already signed in. Do not enter credentials inside a Hardened session.
  For Copilot, use only the personal github.com account (the legacy `copilot-cli-home` profile),
  never the EBRD seats.
- Use one scratch workspace per provider under `/tmp/aio-hardened-live/<provider>/`. Turn on YOLO
  and Hardened for each session, and record the instance id and the UTC time window.
- Before each negative check, pick a unique absent path such as
  `~/Desktop/aio-hardened-<provider>-<timestamp>.txt`, and verify it is absent before and after.
- Keep instance-correlated evidence from `~/Library/Application Support/Harness/logs/app.log` and
  `lifecycle.ndjson`. Every hardened spawn logs `Spawning CLI under Seatbelt hardened mode` with
  `grantedRoots`.
- To re-run the out-of-app evidence, run `node scripts/hardened-probe/probe.mjs` from a normal
  Terminal, not from inside a Harness session.

## Status — 2026-09-28

Open: 3 · Closed: 0 · Failed: 0

**Superseded:** the earlier Phase 0 version of this doc listed one-provider-at-a-time checks, with
temporary allow-list edits and Grok kept refused. James decided on 2026-09-28 to enable every
provider at once and accepted granting `~/.grok`. The out-of-app probe evidence for every provider
is recorded in the enablement plan. The checks below cover what only the real app can show.

## Check 1 — Every provider works hardened inside the rebuilt app

For each of Claude, Codex, Antigravity, Grok, OpenCode, Cursor and Copilot (Copilot only after its
quota resets, see Check 3):

1. Create a session in the provider's scratch workspace with YOLO and Hardened ON. Confirm the
   composer toggle shows `Hardened ON`, not `N/A`.
2. Turn 1: ask it to write `workspace-ok.txt` in the workspace and read it back.
3. Turn 2: ask it to write the unique Desktop probe path and report the exact error.
4. Wait at least 60 seconds idle, then Turn 3: ask for a one-line reply containing
   `<PROVIDER>-HARDENED-TURN-3`.
5. Restore the session from history. Confirm it is still hardened (a new `Spawning CLI under
   Seatbelt hardened mode` line for the restored instance), and repeat the Desktop write.
6. Confirm `grantedRoots` in `app.log` contain the provider's own roots and nothing belonging to
   another provider. For example, only Grok's list contains `~/.grok`.

**Pass per provider:** all turns answer, the workspace file exists, both Desktop writes fail with
`Operation not permitted` and the file stays absent, and the restored session is still jailed.
**Fail:** file an LT item with the instance-correlated evidence, and remove that provider from
`src/shared/hardened-mode-support.ts` until it is fixed.

## Check 2 — Codex adapter respawns inside the app

During Check 1's Codex session, count every Codex adapter or process spawn in `app.log` and
`lifecycle.ndjson` for the instance, and place each one on a turn boundary. The 2026-09-20 WS13
run spawned the adapter five times in about two minutes.

**Pass:** no adapter respawn outside a turn boundary, and optional MCP `Transport channel closed`
messages are non-fatal. **Fail:** file an LT item. Leave Codex enabled only if every turn still
answered.

## Check 3 — Copilot tool turn (after 2026-10-01)

The 2026-09-28 probe showed a jailed Copilot start, authenticate and reach the model API with its
routed home granted, but GitHub refused the turn with `402 quota_exceeded`. After the 2026-10-01
reset, run Check 1 for Copilot on the personal account. Also confirm the session used that account
(`COPILOT_HOME` is the legacy profile home in the spawn log). Using any other account is a hard
fail, even if the prompts answered.

## Completion and cleanup

- Append a dated evidence section for each check, without overwriting earlier runs.
- Rename this file to `_livetest_completed.md` only when all three checks pass with evidence.
- Terminate disposable sessions, delete the scratch workspaces and any Desktop probe files, and
  verify `git status --short`.

## Evidence run — 2026-10-04 (orchestrating session; re-examined, not run)

The installed app now contains the enablement build (built 19:06 from `3d05e250e`, restarted
20:45:59), so the rebuild prerequisite is met. The checks remain unrunnable by an agent: every
Harness session — and any dev app launched from one — runs inside the Seatbelt signal fence, where a
nested `sandbox-exec` fails `sandbox_apply: Operation not permitted` (today `ps` itself is refused in
this shell), and the composer's **Hardened** toggle is in the hard-denied Harness UI. James needs to
create the seven sessions himself (or run `node scripts/hardened-probe/probe.mjs` from Terminal.app
for the out-of-app half). Open: 3 · Closed: 0 · Failed: 0.
