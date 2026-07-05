# Runbook: Noah Desktop Worker Repair and Cross-Machine Session Sync

Status: PARTIALLY LIVE-VERIFIED / not completed. The desktop worker repair and
old-path trust cleanup gates have been live-checked. This file must not be
renamed `_completed` until the session-sync gates pass on both machines.

## What This Covers

Noah's worker is a hidden `node.exe` process launched from a Startup-folder VBS file,
not a Windows service and not the Harness GUI. The laptop failure was caused by a VBS
launcher still pointing at the old OneDrive checkout after the repo moved. The desktop
needs the same discovery-first repair because paths and launcher names may differ.

Noah also runs the full Harness coordinator app on both laptop and desktop, one at a
time. Conversation history and memory state should be shared with a checkout model:
pull before launching Harness, run Harness, push after Harness exits.

## Scripts Added

Run these from the repo root on the Windows machine:

- `scripts/windows/noah-worker-discover.ps1` - read-only worker, launcher, and state-root discovery.
- `scripts/windows/noah-worker-fix.ps1` - validates the new worker build, backs up VBS launchers, rewrites them, kills stale workers, and relaunches.
- `scripts/windows/noah-config-path-cleanup.ps1` - scans/applies old-path cleanup in `.codex\config.toml` and `.claude.json` without printing secret values.
- `scripts/windows/harness-state-sync.ps1` - lock-guarded checkout wrapper for shared Harness history and memory state.

Always run scripts as files, not pasted multi-line PowerShell blocks:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\<script>.ps1
```

## Current Constraints

- Do not put the repo, worker folder, Harness userData, or the sync hub in OneDrive.
- The packaged app sets Electron `userData` to `%APPDATA%\harness`.
- The dev app sets Electron `userData` to `%APPDATA%\harness-dev`.
- `%APPDATA%\Harness` is treated only as a legacy candidate during discovery.
- A live WAL SQLite DB must not be continuously cloud-synced. The wrapper only syncs
  while Harness is closed and uses a hub lock to prevent two writers.
- If `list_remote_nodes` / `run_on_node` are not available, Noah must run Part A phases
  1 and 2 locally, then paste discovery/verification output.

## Live Check Notes

2026-07-05:

- Coordinator roster was reachable through the packaged `aio-mcp remote-nodes`
  bridge. `Noah3900x` was connected and returned to `0/10` slots after test
  instances were terminated.
- `Noah3900x` desktop worker launchers already point at
  `C:\Users\User\Documents\work\ai-orchestrator\start-worker.bat` from both
  `C:\Users\User\.orchestrator\run-worker-hidden.vbs` and the Startup-folder
  `HarnessWorker.vbs`.
- A coordinator-launched desktop check returned `WORKER_OK`, found the worker
  process running `dist/worker-agent/index.js`, and showed both desktop
  launchers targeting the non-OneDrive repo. The worker command line itself is
  relative because the launcher enters the repo before starting Node.
- Old-path CLI trust scans on `Noah3900x` found no exact matches for either
  `C:\Users\User\OneDrive\Documents\work\ai-orchestrator` or
  `C:\Users\noah\OneDrive\Documents\work\ai-orchestrator` in
  `C:\Users\User\.codex\config.toml` or `C:\Users\User\.claude.json`.
  A broader line-number-only scan found no OneDrive plus `ai-orchestrator`
  references in those files, so no apply step was needed.
- Session sync is blocked:
  - `noahlaptop` disconnected during the source-side read-only probe, so the hub
    cannot be seeded from the current source machine through remote tools.
  - `Noah3900x` reports Harness running, so `seed-to-local`, `pull`, `push`, and
    `run` modes would correctly refuse until Harness is closed.
  - `\\windows-pc\HarnessState` is not reachable from `Noah3900x`.
  - The connected node named `windows-pc` reports computer name `9950X3D` and has
    no `HarnessState` SMB share or local candidate folder at `C:\HarnessState`,
    `D:\HarnessState`, or `C:\Users\shutu\HarnessState`.

Next live run needs a connected source laptop, Harness closed on both target
machines, and a real non-OneDrive hub share chosen or created before running
`seed-from-local`, `seed-to-local`, desktop verification, and wrapper shortcut
installation.

## Part A: Repair Desktop Worker

### Phase 0: Access

On the coordinator, check whether remote-node tools are available and whether the
desktop is connected:

```text
list_remote_nodes
```

If the desktop is absent or accepts spawns that immediately die, Noah runs phases 1
and 2 by hand on the desktop. Windows Tailscale targets generally do not have SSH
available, so do not rely on `tailscale ssh`.

### Phase 1: Discover

On the desktop, from the moved repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\noah-worker-discover.ps1
```

Record:

- `USER`, `APPDATA`, `PROFILE`, `COMPUTER`
- `NODEEXE` from the running worker command line or `Get-Command node`
- `OLDPATH` from the current VBS or running worker command line
- `NEWPATH`, confirmed with Noah, for example `C:\dev\ai-orchestrator`
- Startup launcher filename, for example `HarnessWorker.vbs`
- Whether `%USERPROFILE%\.orchestrator\run-worker-hidden.vbs` exists
- Scheduled tasks that may relaunch a worker
- Which userData root exists: usually `%APPDATA%\harness`

### Phase 2: Fix Launchers

Build the worker at the new repo path if `dist\worker-agent\index.js` is missing:

```powershell
npm run build:worker-agent
```

Then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\noah-worker-fix.ps1 `
  -RepoPath 'C:\dev\ai-orchestrator' `
  -StartupLauncherName 'HarnessWorker.vbs'
```

Pass `-NodeExe 'C:\Program Files\nodejs\node.exe'` only if discovery did not resolve
the correct `node.exe`.

The script refuses OneDrive repo paths and refuses to kill the current worker until
the new `dist\worker-agent\index.js` exists. It backs up launchers before writing.

### Phase 3: Verify Worker From Coordinator

After the desktop reconnects:

- `list_remote_nodes` should show the desktop connected with fresh heartbeat and `0/N` slots used.
- Run a real test spawn on the desktop:

```powershell
Write-Host 'WORKER_OK'
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*worker-agent*' } |
  Select-Object -ExpandProperty CommandLine
```

Expect `WORKER_OK` and a worker command line pointing at `NEWPATH`. Terminate the test
instance afterward so it does not hold a slot.

### Phase 4: Clean Old CLI Trust Paths

First scan only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\noah-config-path-cleanup.ps1 `
  -OldPath 'C:\Users\noah\OneDrive\Documents\work\ai-orchestrator' `
  -NewPath 'C:\dev\ai-orchestrator'
```

If the scan finds only the intended stale path, apply:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\noah-config-path-cleanup.ps1 `
  -OldPath 'C:\Users\noah\OneDrive\Documents\work\ai-orchestrator' `
  -NewPath 'C:\dev\ai-orchestrator' `
  -Apply
```

The script backs up files first and writes UTF-8 without BOM. It prints filenames and
line numbers only, not secret values.

## Part B: Sync Harness History and Memory

### Durable State Include List

Sync only these durable state paths under the resolved userData root:

- `rlm\` - RLM DB and content files.
- `conversation-history\` - native conversation-history files.
- `conversation-ledger\` - chat/conversation ledger DB.
- `session-continuity\` - session state and snapshots.
- `projects\` - project-scoped session event logs and agent-tree snapshots. The
  wrapper excludes `shadow-repo` working-tree checkpoints from this mirror, and
  prunes stale hub-side copies on push, so the shared hub does not become a
  source-code snapshot store.
- `transaction-logs\` - recovery transaction logs.
- `archived-sessions\`
- `content-store\`
- `output-storage\`
- `child-results\` - bounded child-result artifacts used by orchestration sessions.
- `snapshots\`
- `operator\` - operator/chats DB.
- `loop-mode\`
- `loop-learnings.json`

Exclude caches, logs, and machine-specific or auth/session state:

- `logs\`, `diagnostics\`, `diagnostics-bundles\`, `stats\`
- `output-cache\`, `image-cache\`, `remote-config-cache\`, `cost-attribution\`
- `browser-profiles\`, `whatsapp-session\`
- `provider-plugins\`, `repo-jobs\`, `codex-broker\`
- `codemem.sqlite` and code-index data
- `settings.json`, `hook-approvals.json`, native sockets, and machine identity files

### Choose a Hub

Use a non-OneDrive folder reachable by both machines. Recommended options:

- A neutral always-on Tailscale Windows share, for example `\\windows-pc\HarnessState`.
- A desktop-hosted share if the desktop is the intended source of truth.

The examples below use:

```powershell
$hub = '\\windows-pc\HarnessState'
```

### Phase 1: Scan Local and Hub State

On the laptop first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\harness-state-sync.ps1 `
  -Mode scan `
  -HubPath $hub
```

The scan prints names and sizes for DB files only. Do not read or paste conversation
contents.

### Phase 2: Seed Hub From Current Source Machine

Close Harness fully on the laptop, then:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\harness-state-sync.ps1 `
  -Mode seed-from-local `
  -HubPath $hub
```

This creates `STATE-READY.txt` in the hub. Without that marker, pull/run modes refuse
to overwrite a local working copy.

### Phase 3: Seed Desktop From Hub

Close Harness fully on the desktop, then:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\harness-state-sync.ps1 `
  -Mode seed-to-local `
  -HubPath $hub
```

Open Harness on the desktop and confirm history and memories are present. Then close
Harness and push:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\harness-state-sync.ps1 `
  -Mode push `
  -HubPath $hub
```

### Phase 4: Replace Harness Shortcuts With Wrapper

Use this as the shortcut target on both machines, adjusting `HubPath` and `HarnessExe`
if auto-discovery does not find the app:

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\ai-orchestrator\scripts\windows\harness-state-sync.ps1 `
  -Mode run `
  -HubPath '\\windows-pc\HarnessState'
```

The wrapper:

1. Refuses OneDrive-backed userData or hub paths.
2. Refuses to run if another machine holds `sync.lock`.
3. Refuses to sync while Harness is already running.
4. Pulls durable state from the hub.
5. Starts Harness and waits for it to exit.
6. Pushes durable state back to the hub.
7. Releases the lock.

Use `-Force` only after confirming the other machine is closed and the lock is stale.
Use `-DryRun` to print robocopy operations without copying.

## Completion Gate

Rename this file to `noah-desktop-worker-fix-and-session-sync_completed.md` only after
all of these are true:

- Desktop worker launchers are backed up and repointed to the non-OneDrive repo.
- Coordinator test spawn returns `WORKER_OK` and shows the worker command line at `NEWPATH`.
- Test spawn has been terminated and desktop slots return to `0/N`.
- Old-path Codex/Claude trust config scan is clean or intentionally remapped.
- Hub is seeded from the current source machine.
- Desktop seed from hub succeeds with Harness closed.
- Harness opens on the desktop with expected history and memories.
- Desktop closes and pushes back to the hub successfully.
- Wrapper shortcut is installed on both machines or Noah explicitly chooses manual `pull`/`push`.
