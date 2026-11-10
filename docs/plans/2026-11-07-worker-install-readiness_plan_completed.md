# Plan: a new worker computer comes out of install ready to use

**Status:** Completed 7 November 2026. Live checks deferred to [the livetest doc](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-07-worker-install-readiness_plan_livetest.md).
**Spec:** [2026-11-07-worker-install-readiness_spec_completed.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/specs/2026-11-07-worker-install-readiness_spec_completed.md)
**Builds on:** [agent-issued remote node pairing](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-07-agent-issued-remote-node-pairing_plan_completed.md)
(uncommitted in the tree; this plan edits some of the same files and keeps that work intact).

## Facts found while planning (they change the spec's picture)

1. **There is no Mac install for a logged-in worker.** The only launchd code installs a system LaunchDaemon as
   `_orchestrator` (`src/worker-agent/service/macos-service-manager.ts`). The test Mac's
   `~/Library/LaunchAgents/com.aiorchestrator.worker.user.plist` was written by hand (node + `dist/worker-agent/index.js
   --supervise`, `KeepAlive.SuccessfulExit=false`, `ThrottleInterval 30`, `LimitLoadToSessionType Aqua`). The spec's
   "install", Local Network prompt, browser and keychain checks all need a worker in the logged-in session, so this plan
   adds that install (`aio-worker install-agent`).
2. **The main app cannot read a worker's status file.** It is local to the worker, and a worker that cannot connect sends
   nothing. So "the node's Settings detail names the Local Network setting" can only happen once the worker gets through by
   some other address (for example the Tailscale IPv6 address from item 3), or on the next good connection. The status file
   always has it.
3. **Signing errors live only in Xcode build logs.** On the test Mac the licence block ("PLA Update available ... Program
   License Agreement") is in `~/.orchestrator/_scratch/signcheck-dd/Logs/Build/*.xcactivitylog` (gzip). Nothing cheap
   reports it otherwise, and a real signed probe build would register bundle IDs in the Apple account. So the signing check
   reads the newest build logs in known places.
4. **Port 4879 is the phone gateway, not a worker listener.** It binds the Tailscale IPv4 address on purpose; no change.
5. **`::` accepts IPv4 on macOS** (checked: a `::` listener saw `::ffff:127.0.0.1`), and this Mac's Tailscale IPv6 address
   (`fd7a:115c:a1e0::/48`) is visible in `os.networkInterfaces()` on `utun*`.
6. The test Mac today: AC sleep 0, its user is in `com.apple.access_ssh`, FileVault on, Tailscale running, licence accepted
   (`xcodebuild -license check` exit 0), one iOS 27.2 runtime, `devicectl` lists devices as JSON.

## Design

### 1. Waiting for pairing is a state, not a crash
- `src/worker-agent/index.ts`: when the config has no `coordinatorUrl`, keep the single-instance lock, write status
  `waiting_for_pairing` with a plain message, log one line, and re-read the config every 5 s until a coordinator appears,
  then carry on starting. No exit, so neither the supervisor nor launchd restarts it.
- New state in `src/shared/types/pair-both.types.ts` and the status parser's set in `worker-connection-status.ts`.
- `aio-worker pair` against a waiting worker: the waiting worker picks the new config up; `pair` must not fail because the
  lock is held (check `pair-cli.ts` start path and say so in its output).

### 2. Name the Local Network block
- `coordinator-network-readiness.ts` keeps each candidate's error (`code`, resolved `address`).
- `worker-agent.ts`: when no candidate answers, on macOS, and any candidate failed with `EHOSTUNREACH` on a private-range
  address (10/8, 172.16/12, 192.168/16, 169.254/16, IPv6 `fe80::/10`, `fc00::/7` outside Tailscale's `fd7a:115c:a1e0::/48`),
  the status message becomes: "macOS is blocking this computer from reaching Harness. Turn on node under System Settings >
  Privacy & Security > Local Network." (the binary's real name, not always "node"). The worker remembers it until a private
  address answers.
- Reported to the main app as `connectionNotice` in the capabilities (sent on registration and every heartbeat), copied to
  the roster entry, shown in the node's Settings detail. Also feeds the Local Network host check (item 8).
- The prompt: `install-agent` loads the agent, whose first act is a connection attempt to every coordinator address,
  including the LAN one, while someone is at the screen; install and `pair` on macOS print "If macOS asks whether node may
  find devices on your local network, click Allow."

### 3. The coordinator answers on IPv6 too
- When the host setting is the all-interfaces wildcard (`0.0.0.0`), `worker-node-connection.ts` listens on `::`, which takes
  both. The setting and every `0.0.0.0` check stay as they are (no settings migration). Pair-both's listener follows the same
  rule.
- Connection addresses drop the `::ffff:` prefix where they are recorded.
- Advertised addresses add the Tailscale IPv6 address; every URL builder brackets IPv6 hosts (`ws://[fd7a:...]:4878`):
  `coordinator-advertised-urls.ts`, `shared/remote-node/pairing-command.ts` (fallback hosts too), worker
  `cli/pairing-config.ts`, pair-both.
- 4879 (phone gateway): no change (fact 4).

### 4. Browser features on when Chrome is present
- One worker helper used by `pair` and `install-agent`: if Chrome is found (`resolveChromeExecutablePath`, plus the Windows
  per-user `%LOCALAPPDATA%` path) and `--no-browser` was not given, turn on `browserAutomation` (headful, AIO's own profile
  directory) and `extensionRelay`, and register the native host as `install-browser-extension` does. Changed while
  building: an earlier "off" choice is not detected (loading drops an `enabled: false` browser block), so pairing again
  turns browser features on unless `--no-browser` is given, and says so. Loading a config still never turns anything on.
- Extension status: the relay summary gains `extensionFolder` (added by the capability report, so the relay file stays
  under its size limit). The
  Settings detail says when the relay is on but the extension hasn't made contact since the worker started, with the folder.

### 5. Friendly name
- The pairing link carries `name` when a label is given (Settings and the agent-issued command); `aio-worker pair --name`
  wins over it; `install-agent --name` sets it. A default from the hostname drops `.local`.

### 6. Pair both: log it and make it reachable
- A `PairBoth` logger line for every state change: started, worker connected, code shown, approved, rejected, closed and
  why, expired, stopped. Session id, status, times and addresses only; never keys, tokens, codes or payloads; peer error
  text length-capped.
- The request lists every reachable address (MagicDNS name only when Tailscale is running, Tailscale IPv4 and IPv6, LAN),
  and the joining side tries each in order.
- `docs/WORKER_AGENT_SETUP.md` names `$AIO_MCP remote-nodes pair` as the recommended route for agents.

### 7. iOS readiness in the roster
- New `src/worker-agent/ios/ios-readiness.ts`, macOS only, async, each command with a time limit, cached 5 minutes,
  never on the awaited connect path:
  - Xcode: `xcode-select -p`, `xcodebuild -version`, licence via `xcodebuild -license check` exit code
  - runtimes: `xcrun simctl list runtimes --json`
  - physical devices: `xcrun devicectl list devices --json-output <tmp>` (`reality == physical`), paired state and
    Developer Mode
  - signing: an Apple account in Xcode (`defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists`) and
    the newest signing error in the newest build logs under the default DerivedData, the worker's working folders and its
    config folder (bounded depth, newest few files, size cap)
- Runs inside the worker, so in the logged-in session (keychain unlocked), never over SSH.
- `iosAutomation` in capabilities, the heartbeat schema, roster, `remote-nodes` table tag and `--json`.
- `run_on_node` gains `requiresIos`; placement filters to nodes whose iOS block is ready (Xcode licence accepted and a
  runtime or a paired device), the way `requiresAndroid` filters. Routing only; no iOS tool is injected.

### 8. Host readiness checks on macOS
- New `src/worker-agent/host-readiness.ts`: sleep on power (`pmset -g custom`, AC `sleep`), Remote Login access for the
  worker's user (`dseditgroup -o checkmember ... com.apple.access_ssh`, only when the group exists), Local Network (from item
  2's evidence), Tailscale running, FileVault on. Each: ok / problem / note, plain summary, exact fix, and whether it needs an
  admin password.
- Reported as `hostReadiness` in capabilities (cached 10 minutes), included in `REMOTE_NODE_REPAIR_DIAGNOSE`'s result and
  shown in the repair panel.
- `aio-worker check-host` prints them; `install-agent` runs it and applies the only fix that needs no admin (open Tailscale
  when installed but not running). The rest are steps for James.

### The Mac install
- `aio-worker install-agent [--name <n>] [--no-browser] [--config <path>]` and `uninstall-agent`, macOS only, no root:
  writes the per-user LaunchAgent (same shape as the test Mac's hand-made one, using the running binary/script and the
  current PATH), applies item 4 and 5, runs item 8, loads it with `launchctl bootstrap gui/<uid>` (replacing a loaded one),
  and prints the Local Network hint. Windows keeps its scheduled-task install; its name and browser come from `pair`.

## Wire compatibility
New capability fields (`connectionNotice`, `iosAutomation`, `hostReadiness`, relay `extensionFolder`) are optional and must be
added to the non-strict heartbeat schema or they are silently stripped. Older workers simply don't send them; older
coordinators drop them.

## What could break
- Wildcard listen on `::`: connection addresses gain `::ffff:` (normalised); a machine without IPv6 would fail to listen.
- Pairing link and advertised lists change shape (bracketed IPv6, `name`): pairing-command, advertised-urls, pairing-config
  specs.
- Browser auto-enable reverses the "never silently on" test in `worker-config.spec.ts`; that test stays true for loading.
- Placement: `requiresIos` filter in `worker-node-registry.ts`.
- Another session is building Settings > Computers (`computers-list.*`, `remote-nodes-settings-tab.*`); this plan doesn't
  touch those files.

## Checklist
- [x] 1 Waiting for pairing (state, wait loop, pair against a waiting worker) + specs
- [x] 2 Local Network cause (probe errors, status message, `connectionNotice`, roster, Settings detail) + specs
- [x] 3 Dual-stack listen, `::ffff:` normalising, IPv6 advertising and URL brackets + specs
- [x] 4 Browser on at pair/install, `--no-browser`, `extensionFolder`, Settings detail line + specs
- [x] 5 Name in link and agent command, `--name` on install, `.local` dropped + specs
- [x] 6 Pair-both logging, address list, joiner tries each; docs + specs
- [x] 7 `iosAutomation` probe, schema, roster, CLI, `requiresIos` routing + specs
- [x] 8 Host readiness checks, repair diagnose, repair panel, `check-host` + specs
- [x] Mac install command + specs
- [x] Canonical checklist (`npm run checks`, `npm run test:quiet`)
- [x] Fresh-eyes completion gate (first pass FAIL, eight findings fixed; second pass `VERDICT: PASS`)
- [x] Live checks on `ct-test-mac` written to a `_livetest.md`

## As built (7 November 2026)

- **1.** `src/worker-agent/wait-for-pairing.ts`; `index.ts` waits holding the lock and retakes it if pairing changed the
  namespace. `assertWorkerConfigHasCoordinator` is gone (no caller left). `pair` reads the running worker's report before
  clearing it: a waiting worker connects by itself; any other running worker gets "Restart it to use this pairing" (it
  would previously have exited as a duplicate silently). Worker Mode shows the new state.
- **2.** `src/worker-agent/local-network-evidence.ts` (shared prefix `LOCAL_NETWORK_BLOCKED_PREFIX` in
  `pair-both.types.ts`); the probe gained an observer (`coordinator-network-readiness.ts`). The binary name comes from
  `process.execPath`.
- **3.** `src/shared/remote-node/host-address.ts` (`toListenHost`, `formatHostForUrl`), `dual-stack-listen.ts` (falls back to
  the IPv4 wildcard only when IPv6 is unavailable: `EAFNOSUPPORT`, `EADDRNOTAVAIL`, `EPROTONOSUPPORT`),
  `worker-node-listener.ts`; `getTailscaleIpv6Address` in `network-addresses.ts`; Settings status, the agent command and repair
  commands all carry the IPv6 address.
- **4.** `src/worker-agent/cli/browser-setup.ts` (also now the body of `install-browser-extension`, whose message prints
  the real folder), `browser-extension-folder.ts`; the Settings node page shows the hint while the relay is on and the
  extension hasn't made contact.
- **5.** `name` in the pairing link; `pair --name` still wins; `defaultWorkerName()` drops `.local`.
- **6.** `pair-both-logging.ts`, `pair-both-addresses.ts`, `pair-both-worker-side.ts` (joiner tries each address, 3 s
  each). Stop or replace now ends a waiting session as `cancelled` and revokes its credential (the status existed but
  nothing set it). The pair-both payload also carries the other addresses as `coordinatorUrls`.
- **7.** `src/worker-agent/ios/ios-readiness.ts`, `probe-command.ts`; `isIosAutomationReady` in `worker-node-registry.ts`.
  Real run on `ct-test-mac`: Xcode 27.2, licence accepted, two iOS 27.2 runtimes (two builds), Apple account present, the
  licence-agreement signing error found in its scratch build log, under a second.
- **8.** `src/worker-agent/host-readiness.ts`; repair diagnose carries `hostReadiness` from the live registry entry (none
  once a node disconnects). Real run of `check-host` on `ct-test-mac`: only the FileVault note.
- **Install.** `src/worker-agent/cli/install-agent-cli.ts`, `service/macos-launch-agent.ts`; `install-agent`,
  `uninstall-agent`, `check-host` in `index.ts`.
- **Review round 1 fixes:** `pair` probed IPv6 addresses with brackets left on (always failed; fixed and tested
  against a real `::1` listener); the host-and-port config form did not bracket IPv6 either. The wait loop now only reads
  the file (`readConfiguredCoordinatorUrl`) so it cannot write over a pairing being saved; `pair` sets up the browser
  before saving the pairing; a stop signal while waiting releases the lock. A home-network `EHOSTUNREACH` is also what a
  sleeping or switched-off main Mac gives, so the Local Network message now needs the router to be unreachable too
  (`router-reachability.ts`); with another route winning, this is settled in the background and the next heartbeat
  carries it. The signing check reads only the newest log per project, so a fixed problem stops being reported, and
  caches each log by path, time and size. `install-agent` retries the start after replacing an old agent and only blames
  the login when there is no session. Two older specs ran the real Xcode and Mac probes; they are mocked now. A TLS
  listen error used to be thrown by `ws` instead of rejected (existing, now fixed in `worker-node-listener.ts`).
  Listening on `::` also accepts the Mac's other IPv6 addresses; worker credentials still apply to every connection.
- **Found, not changed:** the worker bundle loads `electron` (through `settings-manager`) at start-up, so it only runs
  beside a checkout's `node_modules`, as it always has. The livetest doc says so.
- **Verification (after the review fixes):** `npm run checks` all seven passed; `npm run test:quiet` 3,659 files, 46,888
  tests passed.
- **Left as is (reviewer's optional notes):** `install-agent` does not drop the `--supervise` that `start-worker.sh`
  appends, so run it as `node dist/worker-agent/index.js install-agent` (as the guide says); a killed probe for oversized
  output counts as timed out; after `pair` a waiting worker's old "waiting" status can show for a few seconds.
