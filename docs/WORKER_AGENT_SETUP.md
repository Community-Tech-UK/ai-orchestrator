# Worker Agent Setup Guide

This guide walks through setting up a remote worker node so the AI Orchestrator coordinator (running on your Mac) can offload work — browser automation, GPU tasks, extra CLI capacity — to another machine (e.g. your Windows PC).

## How It Works

The coordinator runs a WebSocket server. The worker agent connects to it, registers its capabilities (installed CLIs, GPU, browser, etc.), and then listens for RPC commands to spawn and manage CLI instances locally. The coordinator routes work to whatever node best matches the task requirements.

## Prerequisites

On the worker machine you need:

1. **Node.js 20+** — the worker agent targets Node 20.
2. **Git** — to clone the repo.
3. **At least one AI CLI** installed and on the PATH. The capability reporter auto-detects:
   - `claude` (Claude Code)
   - `codex` (OpenAI Codex CLI)
   - `gemini` (Gemini CLI)
   - `gh` (GitHub Copilot via `gh copilot`)
   - `ollama` (detected but not yet routed)
4. **npm** — for installing dependencies and building.
5. **(Optional) Google Chrome or Edge** — if you want browser automation tasks routed here. The reporter checks standard install paths on Windows (`C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`).
6. **(Optional) NVIDIA GPU with `nvidia-smi`** — if you want GPU tasks routed here. The reporter runs `nvidia-smi --query-gpu=name,memory.total` to detect GPU name and VRAM.
7. **(Optional) Docker** — detected via `docker` on PATH.

## Step 1 — Clone and Build

```bash
git clone <your-repo-url> ai-orchestrator
cd ai-orchestrator
npm install
npm run build:worker-agent
```

This runs esbuild and produces a single bundled file at `dist/worker-agent/index.js`.

## Step 2 — Enable Remote Nodes on the Coordinator (Mac)

On the Mac where the Electron app runs, open Settings and enable remote nodes. Under the hood this sets:

```json
{
  "remoteNodes": {
    "enabled": true,
    "serverPort": 4878,
    "serverHost": "0.0.0.0",
    "autoOffloadBrowser": true,
    "autoOffloadGpu": false
  }
}
```

Key points:
- `serverHost` must be `"0.0.0.0"` (not the default `127.0.0.1`) to accept connections from other machines on the LAN.
- `serverPort` defaults to `4878`. Open this port in your Mac firewall if needed.
- `autoOffloadBrowser: true` means any task the router detects as needing a browser will prefer a remote node that has one.
- `autoOffloadGpu` is off by default — flip it if you want GPU-heavy tasks routed to your Windows rig.

## Step 3 — Get the Auth Token

The coordinator auto-generates a 64-character hex token the first time remote nodes are enabled (or you can set one manually). You need this token for the worker config.

Find it in the app's settings panel under Remote Nodes, or in the config file at `~/.orchestrator/settings.json` on the Mac under `remoteNodes.authToken`.

## Step 4 — Configure the Worker Agent

On the Windows machine, create the config file at:

```
%USERPROFILE%\.orchestrator\worker-node.json
```

Contents:

```json
{
  "name": "windows-pc",
  "coordinatorUrl": "ws://<mac-ip>:4878",
  "authToken": "<paste-the-64-char-hex-token>",
  "maxConcurrentInstances": 10,
  "workingDirectories": [
    "C:\\Users\\James\\projects",
    "C:\\Users\\James\\repos"
  ],
  "reconnectIntervalMs": 5000,
  "heartbeatIntervalMs": 10000
}
```

Field reference:

| Field | What it does |
|---|---|
| `name` | Human-readable name shown in the orchestrator UI. |
| `coordinatorUrl` | WebSocket URL of the Mac coordinator. Use `ws://` or `wss://` if you've configured TLS. |
| `authToken` | Must match the coordinator's token exactly. |
| `maxConcurrentInstances` | How many CLI instances this node can run simultaneously. |
| `workingDirectories` | Paths the worker is allowed to use as working directories. The agent enforces path sandboxing — it will reject any spawn request targeting a directory outside these roots. |
| `reconnectIntervalMs` | How quickly to retry if the connection drops (default 5s). |
| `heartbeatIntervalMs` | Interval for heartbeat + capability refresh (default 10s). |

A stable `nodeId` (UUID) is auto-generated on first run and persisted back to this file. Don't manually set it unless you're migrating.

## Step 5 — Run the Worker Agent

```bash
cd ai-orchestrator
node dist/worker-agent/index.js
```

You should see:

```
Worker node "windows-pc" (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
Connecting to coordinator at ws://192.168.x.x:4878...
Connected! Listening for work.
```

CLI flag overrides are available if you don't want to edit the config file:

```bash
node dist/worker-agent/index.js --coordinator ws://192.168.1.50:4878 --name windows-pc --token <token>
```

### Running as a Background Service (Optional)

To keep the agent running persistently on Windows, you can use PM2:

```bash
npm install -g pm2
pm2 start dist/worker-agent/index.js --name orchestrator-worker
pm2 save
pm2 startup
```

Or create a Windows service with `node-windows`, or simply run it in a terminal that stays open.

## Step 6 — Verify the Connection

Back on the Mac, the orchestrator should show the worker node in the Remote Nodes section of Settings with a "connected" status. The node's capabilities (CPU cores, memory, GPU, installed CLIs, browser availability) are reported on connection and refreshed every heartbeat.

You can also check the observer dashboard (if running) — the snapshot now includes a `workerNodes` array.

## Network Considerations

**Same LAN (recommended):** Both machines on the same network, Mac firewall allows port 4878 inbound. This is the simplest setup.

**Different networks / SSH tunnel:** If the machines aren't on the same LAN, set up an SSH tunnel from Windows to Mac:

```bash
ssh -L 4878:localhost:4878 james@<mac-ip>
```

Then use `ws://localhost:4878` as the coordinator URL in the worker config.

**TLS:** For production or untrusted networks, configure TLS on the coordinator side:

```json
{
  "remoteNodes": {
    "tlsCertPath": "/path/to/cert.pem",
    "tlsKeyPath": "/path/to/key.pem",
    "tlsCaPath": "/path/to/ca.pem"
  }
}
```

Then use `wss://` in the worker's coordinator URL.

## Troubleshooting

**"Failed to connect" on startup** — Check that the coordinator has remote nodes enabled, `serverHost` is `0.0.0.0`, the port is open, and both machines can reach each other (`ping` / `Test-NetConnection`).

**Node shows "degraded" in the UI** — The coordinator hasn't received a heartbeat in 30 seconds. Check the worker agent process is still running and there are no network interruptions. It auto-recovers on reconnect within the 30s grace period.

**"Unauthorized" errors** — The auth token doesn't match. Copy it again from the coordinator settings. Tokens are compared using timing-safe comparison, so partial matches won't give you a hint — it either matches exactly or fails.

**Spawn rejected with "directory not allowed"** — The requested working directory isn't in the worker's `workingDirectories` list. Add the path to the config and restart the agent.

**GPU not detected** — The reporter runs `nvidia-smi`. Make sure NVIDIA drivers are installed and `nvidia-smi` is on your PATH. AMD GPUs aren't detected yet (only NVIDIA via nvidia-smi).

**Browser not detected** — The reporter checks `C:\Program Files\Google\Chrome\Application\chrome.exe` and `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. If Chrome/Edge is installed elsewhere, this won't pick it up currently.

## Architecture Reference

For the full design doc, see `docs/bigchange_remote-nodes.md`. Key source files:

- `src/worker-agent/` — The standalone worker agent (this is what runs on the remote machine)
- `src/main/remote-node/` — Coordinator-side: WebSocket server, registry, health monitoring, failover
- `src/main/cli/adapters/remote-cli-adapter.ts` — Proxies CLI operations over RPC to the worker
- `src/shared/types/worker-node.types.ts` — Shared types for capabilities, placement, execution location
