# Worker Agent Setup Guide

This guide walks through setting up a remote worker node so the AI Orchestrator coordinator (running on your Mac) can offload work — browser automation, GPU tasks, extra CLI capacity — to another machine (e.g. your Windows PC).

## How It Works

The coordinator runs a WebSocket server. The worker agent connects to it, registers its capabilities (installed CLIs, GPU, browser, etc.), and then listens for RPC commands to spawn and manage CLI instances locally. The coordinator routes work to whatever node best matches the task requirements.

Workers auto-discover the coordinator on the LAN via mDNS — no IP address needed. On first connection, the worker enrolls using a shared enrollment token and receives its own unique per-node token for all future connections.

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

## Step 1 — Clone and Build (on the Worker Machine)

```bash
git clone <your-repo-url> ai-orchestrator
cd ai-orchestrator
npm install
npm run build:worker-agent
```

This runs esbuild and produces a single bundled file at `dist/worker-agent/index.js`.

## Step 2 — Enable Remote Nodes on the Coordinator (Mac)

On the Mac where the Electron app runs:

1. Open the orchestrator app
2. Go to **Settings** (gear icon or keyboard shortcut)
3. In the left sidebar, under **ADVANCED**, click **Remote Nodes**
4. Toggle **Enable** to on

The app will:
- Start a WebSocket server on port 4878, bound to `0.0.0.0` (all interfaces)
- Auto-generate a 64-character enrollment token
- Begin advertising the service on the LAN via mDNS

You can adjust the port, host, and namespace in the Server Config section. If you change these while the server is running, click **Apply & Restart Server**.

**Firewall:** Your Mac may prompt "Accept incoming connections?" on first run. Allow it. On macOS Sequoia+, a "wants to find devices on your local network" prompt will also appear — allow that too (required for mDNS discovery).

## Step 3 — Get the Enrollment Token

In the same **Remote Nodes** settings panel on the Mac:

1. Scroll to the **Auth Token** section
2. Click the **eye icon** to reveal the token, then **Copy** — or use the **Copy Connection Config** button which generates a ready-to-paste `worker-node.json` file

The enrollment token is used for first-time registration only. After the worker connects and registers, it automatically receives its own unique per-node token. Future connections use that per-node token — you never need to copy the enrollment token again.

## Step 4 — Configure the Worker Agent (on the Worker Machine)

On the Windows machine, create the config file at:

```
%USERPROFILE%\.orchestrator\worker-node.json
```

If you used **Copy Connection Config** on the Mac, paste it directly. Otherwise, create it manually:

```json
{
  "name": "windows-pc",
  "authToken": "<paste-the-enrollment-token>",
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
| `name` | Yes | Human-readable name shown in the orchestrator UI. |
| `authToken` | Yes | Enrollment token from the coordinator (used for first-time registration only). |
| `namespace` | Yes | Must match the coordinator's namespace to be discovered via mDNS (default `"default"`). |
| `maxConcurrentInstances` | No | How many CLI instances this node can run simultaneously (default 10). |
| `workingDirectories` | No | Paths the worker is allowed to use. The agent enforces path sandboxing — it rejects spawn requests outside these roots. |
| `coordinatorUrl` | No | Override mDNS discovery with an explicit WebSocket URL (e.g. `"ws://192.168.0.15:4878"`). Only needed if mDNS doesn't work on your network. |
| `heartbeatIntervalMs` | No | Interval for heartbeat + capability refresh (default 10000ms). |

**Auto-generated fields** (don't set these manually):
- `nodeId` — UUID generated on first run, persisted to this file
- `nodeToken` — unique per-node token received after enrollment, persisted automatically

## Step 5 — Run the Worker Agent

```bash
cd ai-orchestrator
node dist/worker-agent/index.js
```

You should see something like:

```
Auto-discovered coordinator at 192.168.x.x:4878
Worker node "windows-pc" (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
Connected! Listening for work.
```

The worker:
1. Discovers the coordinator on the LAN via mDNS (filtered by namespace)
2. Connects and sends the enrollment token
3. Receives a unique per-node token (saved to `worker-node.json` automatically)
4. Reports capabilities (CPU, memory, GPU, CLIs, browser)
5. Starts listening for RPC commands

**Reconnection:** If the connection drops, the worker retries with exponential backoff (1s → 2s → 4s → ... up to 30s max). If the coordinator restarts or changes IP, continuous mDNS discovery detects it and reconnects automatically.

CLI flag overrides are available if you don't want to edit the config file:

```bash
node dist/worker-agent/index.js --coordinator ws://192.168.1.50:4878 --name windows-pc --token <token> --namespace default
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

Back on the Mac, the orchestrator should show the worker node in the **Remote Nodes** section of Settings with a "connected" status and node count. The node's capabilities (CPU cores, memory, GPU, installed CLIs, browser availability) are reported on connection and refreshed every heartbeat.

You can also check the observer dashboard (if running) — the snapshot includes a `workerNodes` array.

## Auto-Discovery via mDNS

When `coordinatorUrl` is not set in the worker config, the worker automatically discovers the coordinator on the local network using mDNS (Bonjour/DNS-SD). The coordinator advertises itself as an `_ai-orchestrator._tcp` service. The worker finds it, checks that the `namespace` matches, and connects.

This means you typically don't need to know the Mac's IP address — just make sure both machines are on the same subnet and the Mac firewall allows port 4878 inbound.

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
3. All future connections use the per-node token — not the enrollment token
4. The coordinator can **revoke** individual nodes from Settings > Remote Nodes without affecting others
5. The enrollment token can be **regenerated** without disrupting existing registered nodes

If you need to re-enroll a worker (e.g. after revocation), delete the `nodeToken` and `nodeId` fields from its `worker-node.json` and restart.

## Network Considerations

**Same LAN (recommended):** Both machines on the same network, Mac firewall allows port 4878 inbound. mDNS handles discovery. This is the simplest setup.

**Different networks / SSH tunnel:** If the machines aren't on the same LAN, set up an SSH tunnel from Windows to Mac:

```bash
ssh -L 4878:localhost:4878 user@<mac-ip>
```

Then set `"coordinatorUrl": "ws://localhost:4878"` in the worker config.

**To find the Mac's IP:** On the Mac, run `ifconfig | grep "inet "` in Terminal, or check System Settings > Network. Look for the LAN IP (usually `192.168.x.x` or `10.x.x.x`).

**TLS:** For untrusted networks, enable TLS in Settings > Remote Nodes > Require TLS. In auto mode, the coordinator generates a self-signed certificate. In custom mode, provide your own cert/key paths. Workers connect with `wss://` when TLS is enabled.

## Troubleshooting

**"Failed to connect" on startup** — Check that the coordinator has remote nodes enabled in Settings, the port is open, and both machines can reach each other (`ping` / `Test-NetConnection <mac-ip> -Port 4878`).

**"No coordinator discovered" on startup** — mDNS discovery failed. Check that both machines are on the same subnet, the Mac firewall allows incoming connections, and the `namespace` matches. Try setting `coordinatorUrl` explicitly as a workaround.

**Node shows "degraded" in the UI** — The coordinator hasn't received a heartbeat in 30 seconds. Check the worker agent process is still running and there are no network interruptions. It auto-recovers on reconnect within the 30s grace period.

**"Unauthorized" errors** — The enrollment token doesn't match, or the node was revoked. Copy the enrollment token again from Settings > Remote Nodes. If the node was revoked, delete `nodeToken` and `nodeId` from `worker-node.json` and restart.

**Spawn rejected with "directory not allowed"** — The requested working directory isn't in the worker's `workingDirectories` list. Add the path to the config and restart the agent.

**GPU not detected** — The reporter runs `nvidia-smi`. Make sure NVIDIA drivers are installed and `nvidia-smi` is on your PATH. AMD GPUs aren't detected yet (only NVIDIA via nvidia-smi).

**Browser not detected** — The reporter checks `C:\Program Files\Google\Chrome\Application\chrome.exe` and `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. If Chrome/Edge is installed elsewhere, this won't pick it up currently.

## Architecture Reference

For the full design doc, see `docs/superpowers/specs/2026-04-04-remote-nodes-settings-design.md`. Key source files:

- `src/worker-agent/` — The standalone worker agent (this is what runs on the remote machine)
- `src/main/remote-node/` — Coordinator-side: WebSocket server, registry, health monitoring, failover
- `src/main/cli/adapters/remote-cli-adapter.ts` — Proxies CLI operations over RPC to the worker
- `src/shared/types/worker-node.types.ts` — Shared types for capabilities, placement, execution location
