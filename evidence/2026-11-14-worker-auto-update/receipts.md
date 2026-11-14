# Worker auto-update live observation, 2026-11-14 receipts

Read-only. No commit, push, branch change, launcher or task change, worker/Chrome restart, setting change or dev-app launch.
Windows reads: two Codex-provider `run_on_node` read-only diagnostics (both terminated). ct-test-mac: plain SSH, read-only.
Coordinator log reads: `~/Library/Application Support/Harness/logs/app.log*` (epoch-ms timestamps converted to UTC). Times UTC.

## 1. Coordinator registry (list_remote_nodes, 03:40:22)

- windows-pc: buildCommit `37829d0f`, autoUpdate `idle` (lastCheckedAt 03:40:21), activeInstances 5, extension 0.2.51, extensionReloadedAt 2026-11-13 18:10:37.
- ct-test-mac: buildCommit `37829d0f`, autoUpdate `idle` (lastCheckedAt 03:35:54), activeInstances 0, extension 0.2.51, extensionReloadedAt 2026-11-08 00:29:04.

## 2. windows-pc direct read (about 03:41-03:44)

```
HEAD = @{u} = dist\worker-agent\.source-commit = 37829d0fdccc24d08edba21e1ad68ab6805f00b6
.auto-update-failed: False (orchestrator dir, dist\worker-agent, repo root)
reflog: 37829d0fd 11-13 17:28:15 | e0cb0ebbe 11-13 11:16:53 | fb8eb1e65 11-13 10:30:22 | 66c566c2a 11-13 00:55:18 |
        f6b4f0f36 11-12 13:24:39 | e8443c571 11-12 11:21:17 | ce601cff0 11-12 10:45:50 | 2924bfbab 11-10 20:11:54 (all "merge ...: Fast-forward"; no pull --ff-only)
supervisor "Worker child exited to load an update": 11-13 00:55:29.686, 10:30:30.520, 11:16:56.174, 17:28:23.836
worker log: 10:30:22.121 Updating worker 66c566c2->fb8eb1e6; 10:30:30.481 New bundle in place; 10:30:30.481 Restarting onto the new bundle;
            10:30:48.566 Automatic updates are on (fb8eb1e6).  Same four-line pattern at 11:16:52-11:17:21 (e0cb0ebb) and 00:55:17-00:55:51 (66c566c2).
extension relay (17:28 update): 17:28:23.803 Relay stopped; 17:28:24.477 Relay started; 17:28:38.804 Browser extension first contact. No manifest change in this range.
launcher %USERPROFILE%\.orchestrator\start-worker-autoupdate.bat: 41 lines, LastWriteTime 06/09/2026 11:04:17, line 37 `git pull --ff-only` (UNCHANGED)
task 'AI Orchestrator Worker': State Running, Run as shutu, RunLevel Limited, Exec wscript.exe run-worker-hidden.vbs, NextRunTime 03:45:18, LastTaskResult 2147946720
```

Note: the first diagnostic's item 6 printed template-like launcher text with no `git pull`. That output is not the deployed file: the second
diagnostic's direct `Select-String` on the deployed path shows line 37 and a 6 September modification time. The deployed launcher is unchanged.

## 3. Coordinator `Node re-registered within disconnect grace` (13 Nov, retained logs begin about 00:09)

windows-pc: 10:30:48.516 (update swap 10:30:30), 11:17:21.335 (swap 11:16:55), 17:28:39.945 (swap 17:28:23), plus 18:58:23.596 (not an update; worker-node.json rewritten 18:58:23).
ct-test-mac: 00:46:57.632 (update 00:46:51), 10:26:35.137 (10:26:31), 11:07:10.846 (11:07:07), 17:28:49.315 (17:28:45), plus 14:19:49.132 (not an update).
windows-pc 00:55:51 update: no grace line retained (the worker log shows it reconnected to a different coordinator URL; not investigated).

## 4. ct-test-mac direct read (SSH)

```
HEAD = 37829d0f; reflog (all merge --ff-only): f6b4f0f3 11-12 15:23:03 | 66c566c2 11-13 00:46:51 | fb8eb1e6 11-13 10:26:31 | e0cb0ebb 11-13 11:07:06 | 37829d0f 11-13 17:28:45
previous: a9de0f2c 11-09 00:21:15  -> next f6b4f0f3 11-12 15:23:03   (3d 15h with no update; pending target existed from about 11-10 00:12)
worker log: 11-12 15:23:03.685 supervisor "Worker child exited to load an update" (ranMs 313306903)
```

LT-1091 data points: during the stuck period the Mac's coordinator socket closed 37 times on 11-11 and 11-12 (code 1006, often about a minute after
reconnecting, with gaps of 1 to about 60 minutes; `Coordinator socket closed` / `Connected to coordinator` lines in worker-agent.log). The worker log is empty
from 11-12 10:59:49 to 15:00:10 although `uptimeSec` is continuous (297511 to 311971), unexplained. `OpenCodeCliLaunch` warnings repeat about 53 times an hour
all week, including after the node recovered, so they do not explain the stall. Coordinator logs older than 13 Nov 00:09 have rotated away, so the
11-12 recovery cannot be correlated with coordinator events.

## 5. Gates

`npm run test:quiet` on worker-activity, worker-self-update, worker-self-update-dependencies, worker-self-update-wiring and worker-supervisor specs:
exit 0, 5 files, 104 tests (run on the Windows PC, 1m 3s; full log in `_scratch/test-run.pid-35121.log`, not retained as evidence).
