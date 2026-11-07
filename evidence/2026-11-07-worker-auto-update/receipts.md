# Worker auto-update live observation — 2026-11-07 receipts

Read-only evidence for the resumed live-test run. No commit, push, branch change,
launcher or task change, worker/Chrome restart, setting change, or dev app launch was
made by this run. Browser work used windows-pc only.

## 1. Coordinator registry (list_remote_nodes, no worker request)

- windows-pc: connected; buildCommit `4ff3d6dc`; autoUpdate.state `idle`;
  lastCheckedAt 1794072643471; activeInstances 0; extensionVersion 0.2.50.
- Read at about 17:33 UTC, before this run's own diagnostics. Raw record: `live-node-reading-1.json`.

## 2. Direct Windows read (run_on_node, claude provider, read-only; one instance, terminated)

Raw command output as returned by the node:

```
head:     4ff3d6dcd47afe027c59e63b6c2a900572689682
upstream: 4ff3d6dcd47afe027c59e63b6c2a900572689682
stamp:    4ff3d6dcd47afe027c59e63b6c2a900572689682
manifest: resources\browser-extension\manifest.json:4:  "version": "0.2.50",
task:     AI Orchestrator Worker  State: Running  LastRunTime 07/11/2026 17:30:19  NextRunTime 07/11/2026 17:35:18
failure-marker (.auto-update-failed present?): False
```

Launcher `%USERPROFILE%\.orchestrator\start-worker-autoupdate.bat` (lines 27-41, verbatim):

```
27: setlocal
28: set "REPO=C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator"
31: set "GIT_TERMINAL_PROMPT=0"
32: set "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
34: cd /d "%REPO%" || (echo Repo not found: %REPO% & exit /b 1)
36: echo Pulling latest AI Orchestrator...
37: git pull --ff-only
38: if errorlevel 1 echo git pull failed or skipped - continuing with current code.
40: call "%REPO%\start-worker.bat" %*
```

Reflog (`git reflog -n 6`, the blind launcher's pulls are labelled `pull --ff-only`, the updater's are `merge ... Fast-forward`):

```
4ff3d6dc merge 4ff3d6dc...: Fast-forward
bdf416f2 pull --ff-only: Fast-forward
4840dc9e merge 4840dc9e...: Fast-forward
f15d20a2 pull --ff-only: Fast-forward
73ff52be pull --ff-only: Fast-forward
f750e1c6 pull --ff-only: Fast-forward
```

Worker updater log, 2026-11-07 (verbatim lines):

```
09:15:22.503Z [WorkerSelfUpdate] Updating worker { from: '4840dc9e', to: 'bdf416f2' }
09:15:43.310Z [WorkerSelfUpdate] New bundle in place { commit: 'bdf416f2' }
09:15:43.310Z [WorkerSelfUpdate] Restarting onto the new bundle { commit: 'bdf416f2' }
09:16:11.100Z [WorkerSelfUpdate] Automatic updates are on { ... buildCommit: 'bdf416f2' }
09:32:24.561Z [WorkerSelfUpdate] Automatic updates are on { ... buildCommit: 'bdf416f2' }
12:19:30.878Z [WorkerSelfUpdate] Updating worker { from: 'bdf416f2', to: '4ff3d6dc' }
12:20:05.126Z [WorkerSelfUpdate] New bundle in place { commit: '4ff3d6dc' }
12:20:05.127Z [WorkerSelfUpdate] Restarting onto the new bundle { commit: '4ff3d6dc' }
12:20:35.516Z [WorkerSelfUpdate] Automatic updates are on { ... buildCommit: '4ff3d6dc' }
```

Supervisor log, 2026-11-07 (verbatim lines, trimmed to the update events):

```
09:15:49.311Z [Supervisor] Worker child exited to load an update — restarting {"ranMs":49706450,"restarts":8}
09:15:49.838Z [Supervisor] Worker child started {"pid":28988,"restarts":8}
09:31:59.733Z [Supervisor] Worker supervisor started {"maxRapidRestarts":5,"stableRuntimeMs":60000,"pid":10780}
09:31:59.741Z [Supervisor] Worker child started {"pid":13124,"restarts":0}
12:20:05.191Z [Supervisor] Worker child exited to load an update — restarting {"ranMs":10085456,"restarts":1}
12:20:05.718Z [Supervisor] Worker child started {"pid":31920,"restarts":1}
```

## 3. Coordinator log (app.log.1, Mac, read-only grep)

```
1794054004942 WorkerNodeConnection "Worker WebSocket closed" {nodeId bb62e3ee…, closeCode 1000,
              closeReason "Worker shutting down", sessionMs 10060624, heartbeatAgeMs 953,
              activeInstances 0, inFlightWork 0, inFlightControl 0}          # 12:20:04.9 UTC
1794054034    WorkerNodeConnection "Node WebSocket disconnected" (windows-pc) # 12:20:34
1794054034    BrowserReliability  node_disconnect, suspendedAttachments 11
1794054034    WorkerNodeRegistry  "Node deregistered" (windows-pc)
1794054035    WorkerNodeRegistry  "Node registered" (windows-pc), platform win32, address 192.168.0.2
1794054035    WorkerNodeRegistry  "Worker process restarted" (windows-pc)
1794054035    BrowserReliability  node_reconnect, restoredAttachments 11
```

Source for the 30 s grace window: `src/main/remote-node/connection-disconnect-lifecycle.ts:26`
(`DISCONNECT_GRACE_MS = 30_000`). The "Node re-registered within disconnect grace" branch
(`src/main/remote-node/worker-node-connection.ts:559`) did not fire for windows-pc because the
node had already been deregistered about 1 s before re-registering. The 31 s close-to-register
interval exceeds the grace window.

Quiet period before the update (coordinator dispatch records, not worker-side logs):
last work sent to windows-pc completed at 1794053725 (instance.terminate), 245 s before the
12:19:30 update start.

Browser command results on windows-pc after the restart: 830 coordinator rows with
`Browser command result ok: true` from 1794064201 onward (sampled; command names not captured).

## 4. Fresh browser read after the restart (Browser Gateway, windows-pc only)

- browser_list_targets computer=windows-pc: succeeded (audit b4956a97-9d88-4ebd-a8ef-ec85dc7c4f14).
- browser_snapshot of the active readable tab "LT fixture" (http://192.168.0.95:18752/):
  succeeded (audit f213cd60-33df-4e01-b466-5303df6e8ef1). Other tabs in the list are sign-in
  or admin pages and were not read.

## 5. Commit content

- `bdf416f2..4ff3d6dc` changed no files under `resources/browser-extension`, so the extension
  reload clause of Check 3 does not apply. It did change `src/main/browser-gateway/*` (main
  process). Whether any native-host file changed was not isolated.
- `4840dc9e..bdf416f2` changed no files under `resources/browser-extension`.

## Not captured

- The worker's own waiting_for_idle transitions before 12:19:30 were not logged.
- No new pushed commit, forced restart or broken commit was created. Checks 4 and 5 remain
  open for the reasons in the document.
