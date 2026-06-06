# Remote Access Runbook

This runbook covers connecting AI Orchestrator to remote worker nodes: LAN,
Tailscale, SSH tunnels, pairing, and troubleshooting.

## Overview

AI Orchestrator runs a coordinator (the desktop app) and one or more worker
nodes (the `worker-agent`). Workers connect *outward* to the coordinator's
WebSocket endpoint over a shared token. The coordinator never dials workers
directly — workers dial in.

## Starting a Remote Worker

### Step 1 — Find the coordinator URL

In the app: **Settings → Remote Nodes → Coordinator endpoint**. The default
is `ws://0.0.0.0:PORT` (replace `0.0.0.0` with the machine's actual IP for
remote workers).

### Step 2 — Enroll the worker

Run `ENROLL` from the coordinator UI to generate an enrollment token (single-use,
short-lived). Copy it to the remote machine.

### Step 3 — Start the worker

**Preferred (token via environment variable — keeps token off process table):**

```bash
AIO_WORKER_TOKEN=<enrollment-token> ./start-worker.sh \
  --coordinator ws://<host>:PORT \
  --name my-remote-worker
```

**Legacy (deprecated — token appears in `ps aux`):**

```bash
./start-worker.sh \
  --coordinator ws://<host>:PORT \
  --token <enrollment-token> \
  --name my-remote-worker
```

Always prefer `AIO_WORKER_TOKEN` over `--token` in production environments.

## Network Setups

### LAN (same subnet)

Use the coordinator machine's LAN IP:

```bash
AIO_WORKER_TOKEN=<token> ./start-worker.sh --coordinator ws://192.168.1.50:3001
```

Ensure the coordinator's port is not blocked by the firewall:

```bash
# macOS
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
# Linux
sudo ufw allow 3001/tcp
```

### Tailscale

Replace the LAN IP with the Tailscale MagicDNS name or Tailscale IP
(`100.x.y.z`). No firewall rules needed — Tailscale manages the overlay.

```bash
AIO_WORKER_TOKEN=<token> ./start-worker.sh --coordinator ws://<mac-name>.<tailnet>.ts.net:3001
# or:
AIO_WORKER_TOKEN=<token> ./start-worker.sh --coordinator ws://100.x.y.z:3001
```

Run `tailscale status` on both machines to confirm connectivity before starting
the worker. In the app's generated pairing config/link, AI Orchestrator prefers
the coordinator's Tailscale MagicDNS name when available, then its `100.x.y.z`
Tailscale IP, then a normal LAN IP. Keep the coordinator bound to `0.0.0.0` so
it accepts connections on the Tailscale interface.

### Auxiliary Model Access (local LLMs over the remote network)

Auxiliary routing (compression, memory distillation, titles, classification,
scoring) can use local models — e.g. Ollama on a Windows/RTX host — running on a
remote machine. There are two ways to reach them:

**Preferred — via the worker-agent RPC proxy (no extra exposure).** Enroll the
remote host as a worker node (see above). The worker probes its own
`http://127.0.0.1:11434/api/tags` on heartbeat and reports any local models as
`localModelEndpoints`. The coordinator discovers them automatically and routes
generation through the existing encrypted RPC channel — Ollama never has to
listen on the LAN. The discovered endpoint shows up with source `worker-node`
under **Settings → Auxiliary Models**.

**Direct — via a manual Tailscale/LAN endpoint.** When you want the coordinator
to call Ollama directly, expose it on `0.0.0.0:11434` on the remote host and add
its Tailscale hostname (`http://<host>.<tailnet>.ts.net:11434`) or LAN IP
(`http://192.168.x.x:11434`) as a manual endpoint under **Settings → Auxiliary
Models**. Tailscale encrypts the connection, so no additional TLS setup is
required for private-network auxiliary calls. Only private ranges are accepted
(`localhost`/`127.0.0.1`, `192.168.*`, `10.*`, `172.16-31.*`, `100.*`); public
internet IPs are rejected because Ollama has no authentication.

> **Warning:** Never open port `11434` on a public-facing firewall — Ollama is
> unauthenticated. Keep it on Tailscale or a trusted LAN only.

See `docs/runbooks/AUXILIARY_LOCAL_MODELS.md` for full model setup, slot
reference, and troubleshooting.

### SSH Tunnel (port forwarding)

Forward the coordinator port through an SSH tunnel when Tailscale is unavailable:

```bash
# On the remote machine — forward local 3001 to the coordinator's 3001
ssh -L 3001:localhost:3001 user@coordinator-host -N &

AIO_WORKER_TOKEN=<token> ./start-worker.sh --coordinator ws://localhost:3001
```

The `-N` flag keeps the SSH process running without a shell. Use `ssh -f` to
background it.

## Pairing and Security

- **Enrollment tokens expire** — generate a fresh one for each worker. Reuse
  will fail with `403 enrollment token expired/invalid`.
- **Node tokens** are issued after successful enrollment and persisted in
  `~/.orchestrator/worker-node.json`. Treat this file as a secret; set
  permissions `0600`.
- **Revoking a worker**: In the app, **Settings → Remote Nodes → [worker name]
  → Revoke**. The next heartbeat from that node will be rejected.
- **Re-enrolling after revocation**: Delete `~/.orchestrator/worker-node.json`
  on the remote machine and obtain a new enrollment token.

## Doctor Checks for Remote Failures

The built-in Doctor (`Settings → Diagnostics → Run Doctor`) runs the following
remote-node probes:

| Probe | What it checks |
|-------|----------------|
| Endpoint reachable | WebSocket handshake to coordinator URL |
| Pairing valid | Node token accepted by coordinator |
| Heartbeat fresh | Last heartbeat within 2× heartbeat interval |
| Auth mismatch | Token format and length validation |
| Port conflict | Another process using the coordinator port |

### Common failures

**`ECONNREFUSED` / endpoint unreachable**  
The coordinator is not running, or the port/IP is wrong. Verify the app is
open and check the endpoint URL.

**`403 enrollment token expired`**  
The enrollment token was used already or timed out. Generate a new one.

**`401 invalid node token`**  
The stored node token was revoked. Re-enroll: delete `worker-node.json` and
get a new enrollment token.

**`ERR_TLS_CERT_ALTNAME_INVALID`**  
The coordinator is using TLS but the certificate does not match the host.
Either use the Tailscale IP (matching the cert SAN) or add the coordinator IP
to the cert.

**Heartbeat missed, worker appears offline**  
Check the worker process is still running (`ps aux | grep worker-agent`).
If it crashed, check `logs/worker-agent-*.log`. Increase `reconnectIntervalMs`
in `~/.orchestrator/worker-node.json` if the network is unstable.

## Troubleshooting Checklist

1. [ ] Coordinator URL is correct (include `ws://` or `wss://` prefix)
2. [ ] Enrollment token was obtained *after* the previous one expired
3. [ ] `AIO_WORKER_TOKEN` or `--token` flag is set on the worker start command
4. [ ] Firewall allows the coordinator's port from the worker's IP
5. [ ] Tailscale is up on both machines (`tailscale status`)
6. [ ] SSH tunnel is still alive (if used)
7. [ ] `~/.orchestrator/worker-node.json` exists and has valid JSON
8. [ ] Worker process is running (check `ps aux | grep worker-agent`)
9. [ ] Run Doctor to get structured findings with repair hints
