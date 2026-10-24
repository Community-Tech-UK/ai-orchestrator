# Browser Gateway: many Chrome profiles on one machine — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-15-browser-gateway-multi-profile_plan_completed.md](2026-10-15-browser-gateway-multi-profile_plan_completed.md)

**Prerequisites (why these checks were deferred on 15 October 2026):**

Every layer is implemented and verified in-loop: unit and integration tests for the contact state,
command store, tab store, remote bridge, local RPC server, native host, worker relay and service,
plus an extension-VM harness that drives the real `background.js`. The live path cannot run it yet:

1. **Coordinator.** The running Harness is the packaged app, built before this change. It needs a
   rebuild and restart from a checkout that contains this change. James restarts Harness himself;
   do not restart it while sessions are live. Update the coordinator **before or with** the worker:
   an old coordinator rejects tab reports from a new native host behind a not-yet-restarted relay.
2. **windows-pc worker.** The worker relay and the native host ship together in the worker bundle.
   The PC must pull and rebuild this change through its normal update path. Check that
   `browser.health` for windows-pc reports the new worker build and no worker-skew warning.
3. **Extension 0.2.42 in both profiles.** Chrome on windows-pc loads the extension unpacked from the
   PC's checkout. After the pull, each profile must be running bundle **0.2.42**. The version-follow
   reload normally handles this; otherwise reload it in `chrome://extensions` in each profile.
   **Re-enable the extension in the profile where James turned it off.**

All browser work runs on windows-pc through the Browser Gateway (`computer: "windows-pc"`). Never
use the Mac browser for these checks.

## Checks

Call the two profiles **P1** and **P2**. Open an ordinary signed-in site in each, ideally one that
is only signed in on that profile.

| # | Check | Steps | Expected | Status |
|---|---|---|---|---|
| 1 | Both profiles listed | `browser.list_targets` with `computer: "windows-pc"` | P1's and P2's tabs are both listed. A shared tab's profile id contains `:p.<id>:`, and the two profiles show different ids | Open |
| 2 | Commands reach the right profile | `browser.snapshot` on a P1 tab, then on a P2 tab, then on P1 again | Each returns that tab's own page. No `No tab with id`, `browser_extension_wrong_profile` or `runtime_incompatible` errors, and no tab vanishes from `list_targets` afterwards | Open |
| 3 | Interleaved work | Run 6+ alternating reads (`snapshot`/`query_elements`) across one P1 tab and one P2 tab in quick succession | All succeed | Open |
| 4 | One profile closing does not break the other | Close P2's Chrome window entirely (or switch the extension off in P2), wait 15s, then `browser.snapshot` a P1 tab | Succeeds. The coordinator log shows no `browser_extension_runtime_incompatible` for P1. P2's tabs may stay listed for up to ~10 min (accepted limit); a command on one waits ~90s then fails `browser_extension_command_not_delivered` | Open |
| 5 | Returning profile recovers | Reopen P2 (or switch the extension back on), wait ~30s, `browser.list_targets` then `browser.snapshot` a P2 tab | P2's tabs are live again and the snapshot succeeds | Open |
| 6 | Opening a tab | `browser.find_or_open` with a URL not already open | A tab opens in one of the profiles, and later reads of the returned target succeed (the target belongs to the profile that opened it) | Open |
| 7 | Health stays calm | `browser.health` before and after checks 2 and 3 | The windows-pc `serviceWorkerRestarts` count does not climb during ordinary interleaved use | Open |
| 8 | Single-profile regression | With only one profile running the extension, repeat check 2 on that profile | Works exactly as before | Open |

Record evidence (tool outputs, trimmed and redacted) under each check below as it is run.

## Evidence

_None yet._
