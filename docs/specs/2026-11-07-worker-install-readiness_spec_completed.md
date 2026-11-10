# A new worker computer comes out of install ready to use

Status: completed 7 November 2026. Plan: [2026-11-07-worker-install-readiness_plan_completed.md](../plans/2026-11-07-worker-install-readiness_plan_completed.md); live checks deferred to [its livetest doc](../plans/2026-11-07-worker-install-readiness_plan_livetest.md).
Written 7 November 2026 from setting up the CT test Mac (`ct-test-mac`).

## Problem

Setting up the CT test Mac as a worker took most of a night. Each problem below was found by hand,
one at a time, and most needed a round trip to James. None is specific to that Mac: a new Mac or
Windows worker would hit the same ones. James wants the install itself to handle them, so a new
computer is ready for jobs, browser work and (on a Mac) iPhone/iPad testing as soon as it is
paired.

Already handled elsewhere, so out of scope here: agent-issued pairing codes, and the worker trying
every coordinator address until one answers. See
[agent-issued remote node pairing](../plans/2026-11-07-agent-issued-remote-node-pairing_plan_completed.md)
and its live checks.

## What went wrong on 7 November

1. **The worker crash-looped until it was paired.** With no `coordinatorUrl`, the worker exits with
   "Worker config is missing coordinatorUrl". The supervisor gives up after five quick failures,
   then launchd starts it again, so the logs filled with stack traces for hours.
2. **macOS Local Network privacy silently blocked the worker.** After pairing, the LaunchAgent's
   `node` got `EHOSTUNREACH` for the coordinator's home-network address, while the same connection
   from an SSH shell worked. The worker only logged "Coordinator network not ready; deferring
   WebSocket connection", every 20 seconds. It connected once James turned on `node` under System
   Settings > Privacy & Security > Local Network on the worker.
3. **The coordinator can't be reached over Tailscale from this Mac.** Harness listens on IPv4 only
   (`*:4878`). Tailscale IPv4 (100.x) times out to and from the main Mac (memory note "Mac Tailscale
   has no IPv4 route"), and the Tailscale IPv6 address is refused because nothing listens there.
   So the worker only works while both Macs are on the home network.
4. **Browser features were off on the new worker.** `browserAutomation` and `extensionRelay` default
   to disabled, so Harness showed no browser capability even though Chrome was installed. Both were
   turned on by editing `worker-node.json` and restarting the worker. The extension link only
   started once the Chrome extension had been loaded by hand.
5. **The node name defaulted to the hostname** (`CTs-MacBook-Pro.local`), not a friendly name.
6. **"Pair both" failed three times.** Its listener is IPv4-only and advertises only the Tailscale
   name. It expires in minutes. The headless worker can't accept it. One attempt closed early, and
   the coordinator side writes nothing to `app.log`, so the cause is unknown.
7. **Nothing reports whether a Mac is ready for iPhone/iPad testing.** Xcode, simulator runtimes,
   connected devices and signing were all checked by hand. Signing turned out to be blocked by an
   unaccepted Apple Program License Agreement, which only shows up in a signed build's output. The
   roster has `androidAutomation` but no equivalent for iOS.
8. **Mac host settings were wrong for an unattended worker.** Sleep was set to 1 minute, Remote
   Login was limited to an admin-only group, and FileVault means someone must log in after every
   restart before the worker (a LaunchAgent) runs. All of this was found by hand.

## Required behaviour

1. **Waiting for pairing is a normal state, not a crash.** An unpaired worker starts, writes a clear
   "waiting to be paired" status (to `worker-node.status.json` and once to the log), and checks for
   a config change, without exiting or restarting.
2. **Name the Local Network block.** When a coordinator candidate fails with `EHOSTUNREACH` (or the
   macOS equivalent) on a private-range address, while the worker runs on macOS, the worker records
   the cause in plain words: "macOS is blocking this computer from reaching Harness. Turn on node
   under System Settings > Privacy & Security > Local Network." It goes in the status file, the
   roster, and the Settings > Other computers detail for that node. Install on macOS triggers the
   permission prompt while someone is likely at the screen, with a short connection attempt to the
   coordinator's LAN address, and says to click Allow.
3. **The coordinator answers on IPv6 too.** The worker server (default port 4878) listens
   dual-stack, so a worker can reach it on the Tailscale IPv6 address, and the advertised addresses
   include it. The aim is that the test Mac also connects away from home. Check whether the "Pair
   both" listener and the Tailscale-bound listener on 4879 need the same change.
4. **Turn browser features on when Chrome is present.** At install and pairing, if Chrome is
   installed, the worker turns on `browserAutomation` (headful, default profile directory) and
   `extensionRelay`, and registers the native host. The roster shows whether the extension has
   contacted the worker yet. If it hasn't, the Settings detail shows the exact unpacked-extension
   folder for that computer. Opting out stays possible with `--no-browser`.
5. **Ask for a friendly name.** `aio-worker pair` and the install take `--name`, and the
   agent-issued pairing command passes the label through as the name. The worker never shows a raw
   `.local` hostname when a label was given.
6. **Pair both: log it and make it reachable.** Log every coordinator-side state change (started,
   worker connected, code shown, approved, rejected, closed and why, expired). Never log keys or
   codes. List every reachable address in the request, not just the MagicDNS name. Point
   `docs/WORKER_AGENT_SETUP.md` at the agent-issued pairing command as the recommended route for
   agents.
7. **iOS readiness in the roster.** A macOS worker reports an `iosAutomation` block alongside
   `androidAutomation`:
   - Xcode version and selected path, and whether the licence is accepted
   - installed iOS simulator runtimes
   - connected physical devices, each with trust and Developer Mode state
   - a signing check: whether an Apple account is present in Xcode, and the last signing error
     seen, such as the licence agreement block
   `run_on_node` gains `requiresIos`, routed by that block the way `requiresAndroid` works.
   Checks that need the login keychain must run in the worker's own logged-in session, not over
   SSH. Over SSH the keychain is locked, which made Claude and signing look broken when they
   weren't.
8. **Host readiness checks on macOS, reported and not changed silently.** At install and on
   demand, report each of these in plain words, with the exact fix, through the existing repair
   path (`remote-worker-repair-service.ts`, `REMOTE_NODE_REPAIR_DIAGNOSE`):
   - sleep while on power (`pmset`)
   - Remote Login access for the worker's account (`com.apple.access_ssh`)
   - Local Network permission (item 2)
   - Tailscale running
   - whether FileVault is on, so someone must log in after a restart
   Fixes that need an admin password stay a step for James. Everything else, the install applies
   itself.

## Acceptance

- A fresh macOS worker installed and paired from this build connects without anyone editing
  `worker-node.json`. It shows a friendly name, browser and extension status, and an `iosAutomation`
  block in `$AIO_MCP remote-nodes --json`.
- With Local Network permission turned off, the node's Settings detail and status file name the
  setting and the fix, within one retry.
- From a worker on a different network, the worker connects over the Tailscale IPv6 address.
- An unpaired worker produces no crash or restart lines in its logs for 10 minutes.
- A "Pair both" attempt leaves a readable trail in `app.log`, whether it succeeds, is rejected,
  closes or expires.
- On a Mac with an unaccepted Apple licence agreement, the roster's signing check says so.
- Unit tests for each new check and for the status and roster fields. The canonical checklist in
  `AGENTS.md` passes. Live checks on `ct-test-mac` go in a `_livetest.md` document.
