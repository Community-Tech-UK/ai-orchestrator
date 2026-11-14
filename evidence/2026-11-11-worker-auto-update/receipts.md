# Worker auto-update live observation — 2026-11-11 receipts

Read-only. No commit, push, branch change, launcher/task change, worker or Chrome restart, setting change or
dev-app launch by this run. Windows reads used one Codex-provider `run_on_node` read-only diagnostic per question
(two instances, both terminated); the Claude provider was refused on that node (the `claudecomtech-7e12` account
is not signed in there). ct-test-mac was read over plain SSH. Times are UTC.

## 1. Coordinator registry (list_remote_nodes, no worker request)

- windows-pc: buildCommit `2924bfba`, autoUpdate `idle` (lastCheckedAt 07:14:50, 07:25:51), activeInstances 0 at 07:20 and 07:29
  (2 at 07:27 while this run's own diagnostics ran), extensionVersion 0.2.51.
- ct-test-mac: buildCommit `a9de0f2c`, autoUpdate `waiting_for_idle`, target `2924bfba`, activeInstances 0, at
  07:18:13, 07:23:43 and 07:29:13 (lastCheckedAt advancing 5 min apart). extensionVersion 0.2.51.

## 2. windows-pc direct read, 07:23:23Z (raw)

```
HEAD = @{u} = dist\worker-agent\.source-commit = 2924bfbab021db5d9f2fcdfaac79df3de32960cd
resources\browser-extension\manifest.json:4:  "version": "0.2.51",
.auto-update-failed present: False
dist\worker-agent: index.js 10/11/2026 20:11:55, index.prev.js 10/11/2026 18:52:30, .source-commit(.prev/.swapped) 10/11/2026 20:11:56
reflog (--date=iso):
2924bfbab HEAD@{2026-11-10 20:11:54}: merge 2924bfba...: Fast-forward
1e25ac28b HEAD@{2026-11-10 18:52:21}: merge 1e25ac28...: Fast-forward
50b2a4287 HEAD@{2026-11-10 00:12:33}: merge 50b2a428...: Fast-forward
a9de0f2cf HEAD@{2026-11-09 00:18:54}: merge a9de0f2c...: Fast-forward
d5a1195d3 HEAD@{2026-11-08 20:58:30}: merge ...: Fast-forward
e017aa7a7 HEAD@{2026-11-08 14:41:46}: merge ...: Fast-forward
74a28901e HEAD@{2026-11-08 08:47:12}: merge ...: Fast-forward
e6fc6f10e HEAD@{2026-11-08 00:29:05}: merge ...: Fast-forward
4ff3d6dcd HEAD@{2026-11-07 12:19:33}: merge ...: Fast-forward
bdf416f21 HEAD@{2026-11-07 09:15:22}: pull --ff-only: Fast-forward      <- the last blind pull
task: AI Orchestrator Worker  State Running  LastRunTime 07:20:19  NextRunTime 07:25:18  LastTaskResult 2147946720
launcher %USERPROFILE%\.orchestrator\start-worker-autoupdate.bat line 37: git pull --ff-only   (unchanged)
node processes: supervisor pid 10780 (started 07/11 09:31:59); worker pid 21708 (10/11 20:11:56);
  two native-host processes pid 40184 (11/11 01:42:45) and 65916 (11/11 01:43:01), both on dist\worker-agent\index.js
```

Worker log (`worker-agent.log`, line numbers from the node):

```
2274 2026-11-10T00:12:33.084Z [WorkerSelfUpdate] Updating worker { from: 'a9de0f2c', to: '50b2a428' }
2275 00:12:42.234Z New bundle in place   2276 00:12:42.235Z Restarting onto the new bundle   2290 00:12:57.928Z Automatic updates are on (50b2a428)
6427 2026-11-10T18:52:21.581Z Updating worker { from: '50b2a428', to: '1e25ac28' } ... 6446 18:52:50.683Z Automatic updates are on (1e25ac28)
6568 2026-11-10T20:11:34.130Z [WorkerAgent] Coordinator socket closed { code: 1001, reason: 'Server shutting down' }   (coordinator restart)
6577 20:11:54.391Z Updating worker { from: '1e25ac28', to: '2924bfba' }
6578 20:11:56.261Z New bundle in place   6579 20:11:56.261Z Restarting onto the new bundle   6597 20:12:17.730Z Automatic updates are on (2924bfba)
```

Supervisor log: `20:11:56.282Z Worker child exited to load an update — restarting {"ranMs":4764735,"restarts":9}`, child restarted 20:11:56.793Z
(same line pair for 00:12:42 and 18:52:31 on 10 November, and 8 and 9 November).

Earlier extension case (`worker-agent.log.1`): `2026-11-08T00:29:03 Updating worker 4ff3d6dc -> e6fc6f10`; `00:29:29 New bundle in place`;
`00:29:29.899 [WorkerExtensionRelay] Relay stopped`; `00:29:30.637 Relay started`; `00:29:35.249 Browser extension first contact`;
`00:29:51.686 Connected to coordinator`. Commit `b479ccebb` (7 Nov 21:12Z) raised the manifest 0.2.50 -> 0.2.51 and was in that update.
No worker-side "reload" line exists in either window (extension-side reload is not logged by the worker).

## 3. Coordinator log (app.log.2), windows-pc around the 20:11 update

```
20:11:34.033 WorkerNodeHealth Health monitoring stopped
20:11:34.058 WorkerNodeConnection Replaced worker socket closed; keeping active connection {closeCode 1001, "Server shutting down"}
20:24:04.108 Node registered via WebSocket / Node registered / Node registered via RPC (windows-pc)
20:24:04.119 StreamDurability Durable stream resume completed {instances 0, replayed 0}
```

`Node re-registered within disconnect grace` lines for windows-pc in `app.log.2`-`app.log.4` (grep of all three): 11-10 00:12:57.907,
07:48:17.955, 09:31:33.333 and 18:52:50.650. The first and last match worker updates (swap 00:12:42.235 and 18:52:30.991, supervisor exit
00:12:42.267 and 18:52:31.032). None for the 20:11:54 update, because the coordinator itself restarted at 20:11:34 and the worker came back at 20:24:04.
Last coordinator-logged work before the 20:11:54 update: browser command 19:30:51 (2,463 s earlier); `instance.terminate` 18:39:50
was 12.5 min before the 18:52:21 update.

## 4. ct-test-mac direct read (SSH, 07:2xZ)

- HEAD = `dist/worker-agent/.source-commit` = `a9de0f2cf3297294e7b34d81a43529150dee090c`.
- Worker log updates: 7 Nov 16:52 (4840dc9e -> 4ff3d6dc), 8 Nov 00:28, 08:45, 15:07, 20:55, 9 Nov 00:21 (-> a9de0f2c). None since.
- Processes: supervisor pid 30506 (up 3d 14h); worker child pid 63975 (up 2d 7h) with NO child processes; managed Chrome pid 15237 with its
  debug port in LISTEN only, no established connection; two native-host processes under Chrome (21 h).
- Coordinator log: browser commands to this node only 9 Nov 17:xx-21:xx, 10 Nov 00:xx-01:32, 11 Nov 06:38-07:00:30. No dispatched work in the
  03:00-04:00 hour of 11 Nov. Worker log in that hour: vitals every minute and a ten-minute account check, no requests.
- Filed as LT-1091 (register). No restart, debugger or setting change on that node.

## 5. Commit content and gates

- `4ff3d6dc..2924bfba` changed `resources/browser-extension/manifest.json` 0.2.50 -> 0.2.51 only inside the 8 Nov update; `1e25ac28..2924bfba`
  changed nothing under `resources/browser-extension`.
- `scripts/windows/start-worker-autoupdate.template.bat` has no executable `git pull` (line 14 is a comment). The installer refuses to run
  while the keep-alive task is running or enabled (`install-worker-launcher.ps1` lines 330-345), so deploying even to a scratch root needs the
  maintenance window.
- `npm run test:quiet -- worker-activity, worker-self-update, worker-self-update-dependencies, worker-self-update-wiring, worker-supervisor specs`:
  exit 0, 5 files, 104 tests.

## 6. Browser Gateway read after the updates (windows-pc only)

`browser_list_targets` with `refresh: true`, computer `windows-pc`, about 07:35Z: outcome succeeded, 15 tabs returned (audit 1d7825fa-133a-453b-af05-958cde30889b).
No page was opened, navigated, snapshotted or changed; tab titles are not retained here. The node was running `2924bfba` (worker started 20:11:56).
