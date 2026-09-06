# Worker Agent Setup Guide

This guide walks through setting up a remote worker node so the AI Orchestrator coordinator (running on your Mac) can offload work — browser automation, GPU tasks, extra CLI capacity — to another machine (e.g. your Windows PC).

## How It Works

The coordinator runs a WebSocket server. The worker agent connects to it, registers its capabilities (installed CLIs, GPU, browser, etc.), and then listens for RPC commands to spawn and manage CLI instances locally. The coordinator routes work to whatever node best matches the task requirements.

Workers pair to the coordinator with a one-time pairing command or canonical connection config. On first connection, the worker enrolls with that one-time credential and receives its own unique per-node token for all future connections. LAN mDNS discovery still exists as a fallback, but explicit pairing is the reliable path, especially on Windows and VPN/Tailscale networks.

## Prerequisites

On the worker machine you need:

1. **Node.js 22+** — the worker agent targets Node 22 and matches the repo engine.
2. **Git** — to clone the repo.
3. **At least one AI CLI** installed and on the PATH. The capability reporter auto-detects:
   - `claude` (Claude Code)
   - `codex` (OpenAI Codex CLI)
   - `gemini` (Gemini CLI)
   - `gh` (GitHub Copilot via `gh copilot`)
   - `ollama` (detected and routed for auxiliary local-model calls — see [Local Model Discovery](#local-model-discovery-auxiliary-routing))
4. **npm** — for installing dependencies and building.
5. **(Optional) Google Chrome or Edge** — if you want browser automation tasks routed here. The reporter checks standard install paths on Windows (`C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`).
6. **(Optional) NVIDIA GPU with `nvidia-smi`** — if you want GPU tasks routed here. The reporter runs `nvidia-smi --query-gpu=name,memory.total` to detect GPU name and VRAM.
7. **(Optional) Android SDK Platform Tools + Emulator** — if you want Android
   testing routed here. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT`, install at
   least one AVD, and make sure `adb` can see emulators/physical devices.
8. **(Optional) Docker** — detected via `docker` on PATH.

## Step 1 — Clone and Build (on the Worker Machine)

```bash
git clone <your-repo-url> ai-orchestrator
cd ai-orchestrator
npm install
npm run build:worker-dist
```

This runs esbuild and produces a bundled worker entrypoint at
`dist/worker-agent/index.js`. It also builds standalone worker binaries at
`dist/worker-agent-sea/worker-agent` and `dist/worker-agent-sea/aio-worker`
(`.exe` on Windows), plus the browser accessibility runner at
`dist/worker-tools/axe-audit.mjs`.

**Note:** `npm install` runs a postinstall script that rebuilds `better-sqlite3` for Electron. This is only needed if you plan to run the full Electron app on this machine — the worker agent itself doesn't use SQLite. If the postinstall fails (e.g. missing C++ build tools), the worker agent will still work fine.

## Step 2 — Enable Remote Nodes on the Coordinator (Mac)

On the Mac where the Electron app runs:

1. Open the orchestrator app
2. Go to **Settings** (gear icon or keyboard shortcut)
3. In the left sidebar, under **ADVANCED**, click **Remote Nodes**
4. Toggle **Enable** to on

The app will:
- Start a WebSocket server on port 4878, bound to `0.0.0.0` (all interfaces)
- Prepare pairing credentials for first-time worker enrollment
- Begin advertising the service on the LAN via mDNS for fallback discovery

You can adjust the port, host, and namespace in the Server Config section. If you change these while the server is running, click **Apply & Restart Server**.

**Firewall:** Your Mac may prompt "Accept incoming connections?" on first run. Allow it. On macOS Sequoia+, a "wants to find devices on your local network" prompt will also appear — allow that too (required for mDNS discovery).

## Step 3 — Pair This Computer

In the same **Remote Nodes** settings panel on the Mac:

1. Scroll to **Pair this computer**
2. Click **Copy Command**
3. Run the copied command on the worker machine

The copied command looks like this:

```powershell
aio-worker pair "ai-orchestrator://remote-node/pair?host=<mac-host>&port=4878&namespace=default&token=...&requireTls=false"
```

If you are running from a source checkout instead of a packaged worker binary, use the same arguments with the built worker entrypoint:

```powershell
node dist/worker-agent/index.js pair "ai-orchestrator://remote-node/pair?host=<mac-host>&port=4878&namespace=default&token=...&requireTls=false"
```

Or run the source-built standalone alias directly:

```powershell
.\dist\worker-agent-sea\aio-worker.exe pair "ai-orchestrator://remote-node/pair?host=<mac-host>&port=4878&namespace=default&token=...&requireTls=false"
```

The pairing link contains a one-time credential. Treat it as secret while it is valid. After the worker connects and registers, it automatically receives its own unique per-node token. Future connections use that per-node token — you never need to copy the one-time credential again.

## Step 4 — Canonical Config Fallback

The pairing command writes the worker config for you. If you cannot run the pairing command, use **Copy Canonical Config** in the Mac app and paste it into:

```
%USERPROFILE%\.orchestrator\worker-node.json
```

Canonical config shape:

```json
{
  "name": "windows-pc",
  "authToken": "<one-time-pairing-credential>",
  "coordinatorUrl": "ws://<mac-ip>:4878",
  "namespace": "default",
  "maxConcurrentInstances": 10,
  "workingDirectories": [
    "C:\\Users\\YourName\\projects"
  ]
}
```

Field reference:

| Field | Required | What it does |
|---|---|---|
| `name` | No | Human-readable name shown in the orchestrator UI. Defaults to the machine hostname when omitted. |
| `authToken` | Yes | One-time pairing credential from the coordinator (used for first-time registration only). |
| `coordinatorUrl` | Yes | WebSocket URL of the coordinator (e.g. `"ws://192.168.0.15:4878"`). Use `wss://` if TLS is enabled on the coordinator. |
| `namespace` | Yes | Must match the coordinator's namespace (default `"default"`). |
| `maxConcurrentInstances` | No | How many CLI instances this node can run simultaneously (default 10). |
| `workingDirectories` | No | Paths the worker is allowed to use. The agent enforces path sandboxing — it rejects spawn requests outside these roots. |
| `heartbeatIntervalMs` | No | Interval for heartbeat + capability refresh (default 10000ms). |

Optional Android automation block:

```jsonc
{
  "androidAutomation": {
    "enabled": true,
    "sdkPath": "C:\\Users\\YourName\\AppData\\Local\\Android\\Sdk",
    "defaultAvd": "Pixel_8_API_35",
    "headlessEmulator": true,
    "maxEmulators": 1,
    "allowPhysicalDevices": true,
    "injectMaestroMcp": false
  }
}
```

Rules:
- The block is ignored unless `enabled` is exactly `true`.
- `sdkPath` is optional when `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the platform
  default SDK path is valid.
- `maxEmulators` is capped at 4; the default is 1.
- Physical devices must be online and authorized in `adb devices -l`.
- Android automation can also be toggled from Settings > Remote Nodes on the
  coordinator after the worker has connected.

Older UI/config examples may contain `token`, `host`, `port`, and `requireTls`.
The worker still accepts that legacy shape for compatibility: it treats `token`
as the first-run pairing credential and derives `coordinatorUrl` from
`host`/`port`.

When Tailscale is running on the coordinator, the generated pairing config prefers
the coordinator's Tailscale MagicDNS name when the Tailscale CLI exposes it, then
falls back to the coordinator's `100.x.y.z` Tailscale IP, then to a normal LAN IP.
This avoids stale LAN addresses when the Mac changes networks. Keep the server
host set to `0.0.0.0` so it accepts connections on the Tailscale interface.

**Auto-generated fields** (don't set these manually):
- `nodeId` — UUID generated on first run, persisted to this file
- `nodeToken` — unique per-node token received after enrollment, persisted automatically
- `recoveryToken` — same-node recovery credential used only to repair a stale per-node token

## Step 5 — Run the Worker Agent

```bash
cd ai-orchestrator
node dist/worker-agent/index.js
```

You should see something like:

```
Worker node "windows-pc" (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
Connecting to coordinator at ws://192.168.x.x:4878...
Connected! Listening for work.
```

The worker:
1. Reads `coordinatorUrl` from `worker-node.json`
2. Connects and sends the one-time pairing credential
3. Receives a unique per-node token (saved to `worker-node.json` automatically)
4. Reports capabilities (CPU, memory, GPU, CLIs, browser, Android SDK/devices)
5. Starts listening for RPC commands

**Reconnection:** If the connection drops, the worker retries with exponential backoff (1s → 2s → 4s → ... up to 30s max). If the coordinator restarts or changes IP, continuous mDNS discovery detects it and reconnects automatically.

CLI flag overrides are available for development if you do not want to edit the config file:

```bash
node dist/worker-agent/index.js --coordinator ws://192.168.1.50:4878 --name windows-pc --token <token> --namespace default
```

### File Logging

In non-service mode the worker always writes a rotating log to
`~/.orchestrator/logs/worker-agent.log` (size-capped at 5 MB, 4 files kept:
`.log`, `.log.1` … `.log.4`). Every lifecycle edge is recorded — connect,
registration, reconnect attempts + backoff, socket `error`/`close` with codes,
heartbeat failures, uncaught exceptions, and supervisor restarts. This is
critical when the worker is launched headless (e.g. a Windows Startup `.vbs`
with `WScript.Shell.Run …, 0, False`, which discards stdout/stderr): if the
process ever dies, the log is the forensic record of why.

Service mode (`--service-run`, installed via WinSW/launchd/systemd) already
redirects stdout to the service manager's `logpath`, so file logging is skipped
there to avoid double-logging.

### Self-Supervision (Recommended for Headless / Startup Launch)

`--supervise` runs a thin parent process that forks the real worker and restarts
it if it ever exits abnormally — capped exponential backoff + jitter, giving up
only after several rapid-fire crashes (a genuinely broken install, not a
transient fault). This is the recommended way to launch the worker from a
Windows Startup folder, since nothing else will bring it back until the next
logon:

```bash
node dist/worker-agent/index.js --supervise
```

A clean exit (Ctrl-C / SIGTERM) stops the supervisor too; it only restarts on
crashes. Restarts are logged to `worker-supervisor.log`, kept separate from the
child's `worker-agent.log` so the restart history stays readable on its own (and
so the two processes do not race each other's log rotation).

`start-worker.sh` and `start-worker.bat` both pass `--supervise` already, so the
scheduled-task / Startup-folder path gets supervision by default.

### Windows Launcher Install (tracked, reproducible)

Two defects combined to cause the 2026-09-03 outage, and it is worth being precise
about where each lived, because they argue for different fixes:

- **The task action was `cmd /c start ... /min`, which detaches.** Task Scheduler
  saw its action finish in milliseconds, so it never learned the worker had died
  and its `RestartOnFailure` setting was inert. This lived in a hand-made,
  **untracked** file in `%USERPROFILE%\.orchestrator` that nobody could review.
  Tracking is the fix.
- **`start-worker.bat` did not pass `--supervise`,** so a single process exit left
  the node dead. This file was **tracked in the repo the whole time**. Version
  control did not catch it. That is why the installer has an anchored guard that
  refuses to deploy a launcher whose `node` command has lost the flag — review
  alone had already failed once.

The templates are now tracked in `scripts/windows/` and rendered by an installer:

```powershell
# dry run first - writes nothing
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 `
  -RepoPath 'C:\path\to\ai-orchestrator' -WhatIf

# deploy launcher files only
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 `
  -RepoPath 'C:\path\to\ai-orchestrator'

# deploy AND (re)register the scheduled task
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 `
  -RepoPath 'C:\path\to\ai-orchestrator' -RegisterTask
```

What it produces:

| File | Role |
| --- | --- |
| `scripts/windows/start-worker-autoupdate.template.bat` | tracked source; renders to `%USERPROFILE%\.orchestrator\start-worker-autoupdate.bat` |
| `scripts/windows/run-worker-hidden.template.vbs` | tracked source; renders to `%USERPROFILE%\.orchestrator\run-worker-hidden.vbs` |

**Why the deployed copy lives outside the repo.** It runs `git pull` on the repo,
and `cmd.exe` reads a running `.bat` incrementally by byte offset — a pull that
rewrote the running file would make cmd resume at a stale offset and execute
garbage. So the file performing the pull cannot sit inside the tree being pulled.
That is a reason to *deploy* it elsewhere, not to leave it *untracked*. Keep the
template minimal and stable; put anything that changes in `start-worker.bat`,
which is `call`ed after the pull and is safe to update in place.

The installer refuses to run if `start-worker.bat`'s `node` command has lost
`--supervise`, backs up the launcher files it overwrites and the existing task
definition (exported to XML, five most recent kept), and leaves the scheduled task
alone unless `-RegisterTask` is passed. The two `.sha256` drift stamps are
overwritten without a backup — they are regenerable derived data.

The registered task differs from the old hand-made one in two ways that matter:

- The action is `wscript.exe run-worker-hidden.vbs`, which **blocks** on the
  worker (`Run(cmd, 0, True)`). The task therefore stays *Running* for the
  worker's lifetime, so Task Scheduler tracks real liveness. The old
  `cmd /c start ... /min` detached, so the task "succeeded" instantly and
  `RestartOnFailure` could never fire.
- There are **two triggers**. A logon trigger starts the worker promptly at
  logon, and a separate **time trigger repeating every 5 minutes** is the
  keep-alive, so a worker that *exits* mid-session is picked up within minutes.
  `MultipleInstancesPolicy=IgnoreNew` plus the worker's own single-instance lock
  make the repeat a no-op while it is healthy.

The keep-alive is deliberately **not** attached to the logon trigger. A trigger's
repetition only begins when that trigger activates, so a repetition hung off the
logon trigger stays dormant until the next logon — and you almost always register
the task from a session that is already logged on. The XML looks identical either
way, which is what makes it dangerous.

The installer re-exports the task after every registration and asserts three
things rather than trusting them:

1. the time trigger's repetition serialises as `<Repetition><Interval>PT5M
   </Interval><StopAtDurationEnd>true</StopAtDurationEnd></Repetition>` — an
   interval with **no `<Duration>` element**, which is what the Task Scheduler
   UI's "Indefinitely" produces (`StopAtDurationEnd` is inert without a duration);
2. `ExecutionTimeLimit` equals `PT0S`. A non-unlimited limit serialises as an
   *absent* element (meaning "use the 72-hour default"), so absent is a warning too;
3. **`NextRunTime` is populated.** This is the only one that proves the keep-alive
   is armed in the current session; the first two can all pass on a task Task
   Scheduler is not counting down. If it is blank, the keep-alive is not running.

### Elevating can put you in a different account

Registering over an existing task requires an **elevated** PowerShell. Without it
the launcher files still deploy and only the task step is refused.

**Check `whoami` in that elevated shell before you run anything.** If "Run as
administrator" signs you into a separate admin account rather than elevating your
own, every default in the installer silently follows that account: `$env:USERPROFILE`
and therefore `-InstallRoot`, plus the task's principal and logon trigger. On
2026-09-06 that produced a task registered for `9950x3d\CTAdmin`, pointing at
`C:\Users\CTAdmin\.orchestrator\run-worker-hidden.vbs`. It reported an armed
`NextRunTime` and could never run — `LogonType Interactive` for an account with no
interactive session just accumulates missed runs — and undoing it needed elevation
all over again.

Three things now guard against it.

`-WorkerUser` names the account the worker runs as (defaulting to the current user)
and drives both the principal and the logon trigger.

Before anything is written — whether or not `-RegisterTask` was passed, since the
launcher files deploy either way — the installer resolves that account's real
profile directory from its SID and **refuses to run** if `-InstallRoot` does not sit
inside it, printing a corrected command that carries every parameter already in
force — including `-WhatIf`, since the guard fires during a dry run too and a
correction that quietly performed the real install would be worse than the mistake
it is correcting.

That check compares `-InstallRoot` against `-WorkerUser`, so it cannot catch the
case where both defaulted to the *same* wrong account. For that, running elevated
without an explicit `-WorkerUser` prints a warning naming the account about to be
used. Only you know which account runs the worker, so it warns rather than refuses:
where UAC elevates the same account, refusing would be an over-correction.

For a cross-account install, name both:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker-launcher.ps1 `
  -RepoPath 'C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator' `
  -InstallRoot 'C:\Users\shutu\.orchestrator' `
  -WorkerUser '9950X3D\shutu' -RegisterTask
```

Separately, the installer warns up front when a task already exists *and* the shell
is not elevated — the one combination that actually gets refused, since creating a
task for the current user usually does not need elevation. If registration is
refused anyway, it prints the exact command to re-run, carrying through whatever
`-InstallRoot`, `-WorkerUser`, `-TaskName` and `-RepeatMinutes` were in force.

That message names a cause only when it knows one. It checks whether the task
already existed as a **tri-state** — yes, no, or unknown — because
`-ErrorAction SilentlyContinue` on a name lookup hides a stopped Task Scheduler
service just as well as it hides an absent task. Told "no" while the service was
down, the installer would confidently rule elevation out and send you hunting a
bad principal instead. So: *yes* gets the elevation advice, *no* says elevation is
probably not the cause and lists the likely alternatives, and *unknown* says
plainly that neither can be ruled out and to check the service first.

### The launcher skips itself when a worker is already up

`start-worker.bat` checks, before it builds anything, whether a worker is already
running from this checkout, and exits 0 if so.

Without that check the repetition is actively harmful whenever the worker was
started outside the task — by hand, or from another console. Every firing ran
`git pull`, rebuilt `dist\worker-agent\index.js` **underneath the running worker**,
and only then failed, because `cmd` cannot open `worker-stderr.log` for append
while the live worker holds it. Observed on 2026-09-06: a rebuild every five
minutes and `LastTaskResult 1` every time, which also destroys the task result as a
health signal.

It matches the absolute path of this checkout's entrypoint (so a worker from a
different clone does not silence this one) and skips `native-host` helper
processes, which share that entrypoint. It fails **open**: only a definite match
skips, and a missing PowerShell, a CIM failure or an unreadable command line all
proceed exactly as before. Skipping when nothing is running would silently disable
the keep-alive, so the doubt has to resolve toward doing the work.

In the intended steady state this rarely fires, because the task owns the worker:
the blocking VBS keeps the task *Running* for the worker's lifetime and
`MultipleInstancesPolicy=IgnoreNew` suppresses the repeats.

**Known limit: this recovers from a worker that DIES, not one that HANGS.** The
action blocks for the worker's lifetime, and `ExecutionTimeLimit` is `PT0S`
(unlimited, which is required — the 72-hour default would otherwise kill a
healthy worker every three days). So a wedged-but-alive worker keeps the task in
the *Running* state indefinitely, and `IgnoreNew` suppresses every repeat. Nothing
will restart it. Detecting a hung worker is the coordinator's job — it sees
heartbeats stop and deregisters the node after 90s.

Because the repetition will restart the worker within 5 minutes, **stopping it
deliberately now means disabling the task**, not just killing the process:

```powershell
Disable-ScheduledTask -TaskName 'AI Orchestrator Worker'   # stop it staying up
Enable-ScheduledTask  -TaskName 'AI Orchestrator Worker'   # put it back
```

The installer backs up the previous task definition to
`%USERPROFILE%\.orchestrator\AI_Orchestrator_Worker.<timestamp>.task.xml` (five
most recent kept) and prints the exact restore command, which is:

```powershell
Register-ScheduledTask -Xml (Get-Content -Raw '<backup>.task.xml') `
  -TaskName 'AI Orchestrator Worker' -TaskPath '\'
```

**Drift detection.** The installer records **two** SHA-256 stamps in the install
root, and `start-worker.bat` compares both on every launch:

| Stamp | Warns when | Meaning |
| --- | --- | --- |
| `launcher-template.sha256` | the tracked template has changed | you pulled a new template — re-run the installer |
| `launcher-deployed.sha256` | the deployed `.bat` has changed | someone hand-edited the deployed launcher — the 2026-09-03 case |

The second one is the point: a template-only stamp cannot see a hand-edited
deployed file, which is exactly how the original drift went unnoticed. Tracking
the template made it *reviewable*; these stamps make divergence *detectable*.

**Both stamp comparisons are guarded on the stamp existing, so neither can see a
host where the installer was never run at all.** That is a third and different
failure, and it is the one that caused the 2026-09-05 outage: `windows-pc` had
picked up the tracked `--supervise` fix by `git pull`, so the worker looked
correct, while the scheduled task was still the old detached `cmd /c start` form
and no `run-worker-hidden.vbs` or stamps existed. `start-worker.bat` therefore
also checks the five things an install produces — the deployed `.bat`, the
`.vbs`, both stamps, and **the scheduled task itself** — and warns, naming each
missing one, when any is absent. Silence from the drift check is not evidence of
a healthy install; only the absence of *both* warnings is.

The task probe is not redundant with the four files. All four are written *before*
the installer's `-RegisterTask` gate, so their presence proves the launcher was
deployed and nothing more: install without `-RegisterTask`, or lose the task later
to a GPO reset, an AV sweep or a re-registration refused for lack of elevation,
and every file is still on disk while nothing is left to start the worker.

The probe reports two distinct states. **Missing** — no such task. **Stale** — the
task exists but its action does not point at **this host's own**
`%USERPROFILE%\.orchestrator\run-worker-hidden.vbs`, so it is the old hand-made
`cmd /c start ... /min` shape, or a launcher in someone else's profile, or
something else entirely. That is precisely what windows-pc had all through the
2026-09-05 outage, and a bare existence check would have called it healthy.

The comparison is against the **full path**, not the filename. A filename-only
match reported a task pointing at `C:\Users\CTAdmin\.orchestrator\run-worker-hidden.vbs`
as healthy on 2026-09-06 — a launcher in an admin account's profile that the worker
user could not even read.

It runs `Get-ScheduledTask` through PowerShell rather than `schtasks`, and the
reason is worth keeping. `schtasks /fo list /v` prints one flat verbose record, so
grepping it for the launcher filename also matches the `Comment` and `Author`
fields — a task merely *documented* as running the `.vbs`, while still carrying the
old action, would be waved through. Narrowing the grep to the `Task To Run` label
would be worse still, because that label is localised. `Get-ScheduledTask` exposes
`Execute` and `Arguments` on their own, and enumerates every task folder, which
keeps the probe consistent with the installer's own preservation of a non-root
`TaskPath`.

It enumerates and then filters, rather than asking for the one name with
`-ErrorAction SilentlyContinue`. That shorthand suppresses *every* non-terminating
error, so a stopped Task Scheduler service would be reported as "missing" and send
the reader off to re-run an installer that cannot fix it. Listing throws on a real
service or permission fault, and only a successful listing that does not contain
the name means missing.

The probe communicates by exit code: **0** healthy, **2** missing, **3** stale.
**1, or anything else, means it could not answer and nothing is printed** — so a
blocked or absent PowerShell fails open exactly like the `certutil` steps. The
batch side guards on `errorlevel 4` before testing 3 and 2, because `if errorlevel`
means "greater than or equal": without that guard a PowerShell that failed to
launch at all (cmd reports 9009) would be read as "stale".

Disabled tasks are deliberately *not* flagged: `Disable-ScheduledTask` is the
documented way to stop the worker on purpose.

When the install is incomplete, the drift warning is **suppressed**. Otherwise a
deleted `start-worker-autoupdate.bat` alongside a moved-on template would print
`missing: ...start-worker-autoupdate.bat` and then claim that same file "was
hand-edited". The remedy is the same installer re-run either way.

Three limits worth knowing. `start-worker.bat` hardcodes
`%USERPROFILE%\.orchestrator` and cannot discover an `-InstallRoot` override, so a
successful install under a custom root makes this warning fire on every start.
The same applies to `-TaskName`: the batch file looks for the default
`AI Orchestrator Worker`, so a task registered under any other name reads as
missing. Leave both at their defaults on any machine that actually runs the
worker. And the warning only ever warns — it never changes the exit code or blocks
startup.

All three checks only warn. Rewriting the deployed `.bat` while it is executing is
the byte-offset hazard described above, and a missing `certutil` or unexpected
hash output still fails silently rather than blocking startup.

### Post-Mortem Evidence After a Silent Death

A worker that vanishes leaves three things to read, in this order:

1. **`worker-supervisor.log`** — did the supervisor see the child exit and
   restart it? If there is no line at all, the supervisor was not running.
2. **`worker-agent.log`** — the last `[WorkerAgent] process exiting` line names
   the exit code. If the log simply stops mid-line with no exit line, no
   JavaScript ran on the way out: the process was hard-killed from outside
   (`TerminateProcess`, Task Manager "End task") or aborted by V8.
3. **`worker-stderr.log.1`** — the fd-level redirect from `start-worker.bat`.
   V8's fatal handler ("FATAL ERROR: … JavaScript heap out of memory") writes
   here and nowhere else. Check the **`.1`** first: `start-worker.bat` rolls
   `worker-stderr.log` aside on every launch, so once you have relaunched the
   worker the dying run's output is in `.1` and the live file is empty.
   **A second relaunch overwrites `.1`** — copy it somewhere safe before
   restarting again.

`[WorkerVitals]` lines carry `heapUsedMb`, `heapLimitMb` and `heapPressure` once
a minute. The last one before the gap distinguishes heap exhaustion (pressure
near 1.0, and warn-level for a while beforehand) from an external kill (flat).

### Running as a Background Service (Optional)

The worker also self-heals from most runtime faults now: unhandled exceptions
and promise rejections are logged and recovered from (the socket is torn down
and the reconnect loop takes over) rather than exiting. `--supervise` is the
backstop for the rare case the process still dies. A dedicated service manager
remains a good option for auto-start on boot and centralized log capture:

- **Windows service (recommended):** `--install-service` installs a WinSW
  service that runs `--service-run` and captures logs to its own `logpath`.
- **PM2:**

  ```bash
  npm install -g pm2
  pm2 start dist/worker-agent/index.js --name orchestrator-worker -- --supervise
  pm2 save
  pm2 startup
  ```

- Or `node-windows`, launchd, systemd, or simply a terminal that stays open.

## Step 6 — Verify the Connection

Back on the Mac, the orchestrator should show the worker node in the **Remote Nodes** section of Settings with a "connected" status and node count. The node's capabilities (CPU cores, memory, GPU, installed CLIs, browser availability) are reported on connection and refreshed every heartbeat.

You can also check the observer dashboard (if running) — the snapshot includes a `workerNodes` array.

## Local Model Discovery (Auxiliary Routing)

When a worker agent reports capabilities on heartbeat, it probes `http://127.0.0.1:11434/api/tags` (2 s timeout). If Ollama is running on the worker host, the discovered models appear as `localModelEndpoints` in the heartbeat payload.

The coordinator picks these up automatically. No extra configuration is needed — once the worker is connected, open **Settings → Auxiliary Models** to see the discovered endpoints.

The coordinator never connects to `127.0.0.1:11434` on the worker directly (that address is worker-local). All auxiliary generation calls are proxied through the existing encrypted worker-agent RPC channel, so Ollama never has to be exposed on the LAN. See [`runbooks/AUXILIARY_LOCAL_MODELS.md`](runbooks/AUXILIARY_LOCAL_MODELS.md) for the full Windows/RTX setup and model recommendations.

## Local STT Discovery (Voice Transcription)

Worker nodes can also advertise a local speech-to-text engine for Voice Mode.
The coordinator captures microphone audio on the Mac, segments it, and sends
small WAV chunks to the worker through the existing worker-agent RPC channel.
The coordinator never dials the worker's `127.0.0.1` STT server directly.

### Windows / NVIDIA: speaches on the 3080 Ti

For the current local-first STT path, run `speaches` (faster-whisper server)
on the Windows worker and bind it only to worker-local localhost:

```powershell
$env:CUDA_VISIBLE_DEVICES = "1"
docker run --rm --gpus '"device=1"' `
  -p 127.0.0.1:8000:8000 `
  ghcr.io/speaches-ai/speaches:latest-cuda
```

Operational notes:

- Use the `distil-large-v3` model for English v1 transcription.
- Keep the server on `127.0.0.1:8000`; the worker-agent probes it locally and
  reports `localSttEndpoints` in heartbeat capabilities.
- `CUDA_VISIBLE_DEVICES=1` pins STT to the 3080 Ti on James's Windows box,
  keeping the 5090 free for agents and LLM workloads. If GPU ordering differs
  on another host, verify with `nvidia-smi`.
- Blackwell cards such as the RTX 5090 require CUDA 12.8+ and recent
  CTranslate2/PyTorch builds. A stale image may silently fall back to CPU; check
  container logs and GPU utilization after startup.
- The worker-agent uses OpenAI-compatible `POST /v1/audio/transcriptions` via
  its `audio.transcribe` RPC handler, so no extra LAN firewall rule is needed
  for port `8000`.

### Apple Silicon Worker Or This Device

On Apple Silicon, prefer `whisper.cpp` with Metal/Core ML through its
OpenAI-compatible `whisper-server`. CTranslate2-based `speaches` is CPU-bound on
macOS and is not the recommended engine there. A second Mac should be enrolled
as a worker node and advertise `localSttEndpoints`; the coordinator's own Mac
may instead use the direct this-device endpoint configured under Voice settings.

## Auto-Discovery via mDNS

When `coordinatorUrl` is not set in the worker config, the worker automatically discovers the coordinator on the local network using mDNS (Bonjour/DNS-SD). The coordinator advertises itself as an `_ai-orchestrator._tcp` service. The worker finds it, checks that the `namespace` matches, and connects.

This is a fallback path. Prefer the copied pairing command or canonical config when setting up a worker, especially on Windows.

**Continuous discovery:** The worker keeps the mDNS browser running after connecting. If the coordinator restarts or its IP changes, the worker detects it and reconnects automatically.

**When mDNS won't work:**
- Different subnets / VPNs — mDNS is LAN-only
- Enterprise networks that block multicast traffic
- Docker containers or WSL2 (multicast may not cross the virtual bridge)

In these cases, set `coordinatorUrl` explicitly in the worker config or use an SSH tunnel.

## Per-Node Identity

After first-time enrollment:

1. The coordinator issues the worker a unique **per-node token** (64-char hex)
2. The worker saves this to `worker-node.json` as `nodeToken` (automatically)
3. All future connections use the per-node token — not the original pairing credential
4. The coordinator can **revoke** individual nodes from Settings > Remote Nodes without affecting others
5. Manual pairing credentials can be **regenerated** without disrupting existing registered nodes

If you need to re-enroll a worker (e.g. after revocation), delete the `nodeToken`,
`recoveryToken`, and `nodeId` fields from its `worker-node.json` and restart.

## Network Considerations

**Same LAN:** Both machines on the same network, Mac firewall allows port 4878 inbound. The copied pairing command can use the Mac's LAN address; mDNS remains available as a fallback.

**Tailscale (recommended across changing networks):** Install Tailscale on both
machines, sign them into the same tailnet, and keep MagicDNS enabled. When the
Remote Nodes server is bound to `0.0.0.0`, the generated pairing config/link
will prefer the Mac's MagicDNS name if available, then its stable `100.x.y.z`
Tailscale IP. If you create the worker config manually, use:

```json
"coordinatorUrl": "ws://<mac-machine-name>.<tailnet>.ts.net:4878"
```

or:

```json
"coordinatorUrl": "ws://100.x.y.z:4878"
```

**Different networks / SSH tunnel:** If the machines aren't on the same LAN, set up an SSH tunnel from Windows to Mac:

```bash
ssh -L 4878:localhost:4878 user@<mac-ip>
```

Then set `"coordinatorUrl": "ws://localhost:4878"` in the worker config.

**To find the Mac's IP:** On the Mac, run `ifconfig | grep "inet "` in Terminal, or check System Settings > Network. Look for the LAN IP (usually `192.168.x.x` or `10.x.x.x`).

**TLS:** For untrusted networks, enable TLS in Settings > Remote Nodes > Require TLS. In auto mode, the coordinator generates a self-signed certificate. In custom mode, provide your own cert/key paths. Workers connect with `wss://` when TLS is enabled. **Important:** If TLS is enabled on the coordinator, you must use `wss://` in the `coordinatorUrl`. If TLS is disabled, use `ws://`. A mismatch will cause SSL errors or connection refused.

## Troubleshooting

**"Failed to connect" on startup** — Check that the coordinator has remote nodes enabled in Settings, the port is open, and both machines can reach each other (`ping` / `Test-NetConnection <mac-ip> -Port 4878`).

**"Worker config is missing coordinatorUrl"** — The worker only has a raw credential or incomplete config. Paste the full canonical Connection Config or run `aio-worker pair <pairing-link>`.

**"No coordinator discovered" on startup** — mDNS discovery failed. This is common on Windows. Run the copied pairing command or set `coordinatorUrl` explicitly in the worker config (e.g. `"ws://192.168.0.14:4878"`). Also check that both machines are on the same subnet, the Mac firewall allows incoming connections, and the `namespace` matches.

**Node shows "degraded" in the UI** — The coordinator hasn't received a heartbeat in 30 seconds. Check the worker agent process is still running and there are no network interruptions. It auto-recovers on reconnect within the 30s grace period.

**"Unauthorized" errors** — The one-time pairing credential does not match, expired, or the node was revoked. Copy a fresh pairing command from Settings > Remote Nodes. If the node was revoked, delete `nodeToken`, `recoveryToken`, and `nodeId` from `worker-node.json` and restart.

**Spawn rejected with "directory not allowed"** — The requested working directory isn't in the worker's `workingDirectories` list. Add the path to the config and restart the agent.

**GPU not detected** — The reporter runs `nvidia-smi`. Make sure NVIDIA drivers are installed and `nvidia-smi` is on your PATH. AMD GPUs aren't detected yet (only NVIDIA via nvidia-smi).

**Browser not detected** — The reporter checks `C:\Program Files\Google\Chrome\Application\chrome.exe` and `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. If Chrome/Edge is installed elsewhere, this won't pick it up currently.

## Running the Full Electron App on Windows (Optional)

If you want to run the full orchestrator UI on Windows (not just the worker agent), you need a few extra steps after `npm install`:

1. **Rebuild native modules for Electron:**
   ```bash
   npx electron-rebuild -f -w better-sqlite3
   ```
   The postinstall script tries this automatically, but it may fail on Windows if C++ build tools aren't installed. Running it manually with `npx electron-rebuild` downloads prebuilt binaries and usually works without a compiler.

2. **Start in dev mode:**
   ```bash
   npm run dev
   ```
   This builds the main process, starts the Angular dev server on port 4567, and launches the Electron window.

3. **If you get "port 4567 in use"** — a previous dev server is still running. Kill it:
   ```bash
   netstat -ano | findstr 4567
   taskkill /PID <pid> /F
   ```

**Note:** Packaging the app for Windows with `electron-builder` may fail without admin privileges due to symlink creation during code signing. For local development, `npm run dev` is the recommended approach.

## Architecture Reference

For the full design doc, see `docs/superpowers/specs/2026-04-04-remote-nodes-settings-design.md`. Key source files:

- `src/worker-agent/` — The standalone worker agent (this is what runs on the remote machine)
- `src/main/remote-node/` — Coordinator-side: WebSocket server, registry, health monitoring, failover
- `src/main/cli/adapters/remote-cli-adapter.ts` — Proxies CLI operations over RPC to the worker
- `src/shared/types/worker-node.types.ts` — Shared types for capabilities, placement, execution location
