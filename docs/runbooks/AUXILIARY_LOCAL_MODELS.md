# Auxiliary Local Models Setup

Route low-risk helper calls (compression, memory distillation, title generation, routing classification, approval scoring, loop scoring) through local or cheap models while keeping frontier models for main interactive agents.

---

## Windows RTX 5090 / Ollama Setup (Recommended: via Worker Agent)

Using the existing worker-agent enrollment keeps Ollama off the LAN and routes all calls through the secure RPC channel.

### 1. Install Ollama and pull models

```powershell
# Install Ollama from https://ollama.com/download/windows
ollama serve
ollama pull gemma4:12b
ollama pull gemma4:26b
ollama list
```

Recommended models:
- `gemma4:12b` — title generation, routing classification, web extraction, loop/approval scoring
- `gemma4:26b` (or `gemma4:31b`) — compression, memory distillation (higher quality, higher latency)
- Keep model IDs configurable — availability changes as new versions ship

### 2. Enroll the Windows machine as a worker node

Follow `docs/WORKER_AGENT_SETUP.md`. Once the worker is connected, the coordinator automatically discovers `localModelEndpoints` from the heartbeat and makes them available as `worker-node` candidates in Auxiliary Models settings.

The coordinator never opens a direct connection to `127.0.0.1:11434` on the worker. All generation calls go through the worker-agent RPC proxy.

---

## Direct Endpoint Setup (Trusted LAN / Tailscale Only)

Use this only when you want direct HTTP access from the coordinator to Ollama. Requires a private network — never expose unauthenticated Ollama to the public internet.

### 1. Expose Ollama on the LAN interface

```powershell
$env:OLLAMA_HOST="0.0.0.0:11434"
ollama serve
```

**Warning:** Ollama has no authentication. Only use this on a trusted private network or Tailscale. Never open port 11434 on a public-facing firewall.

### 2. Add a manual endpoint in settings

In AI Orchestrator → Settings → Auxiliary Models:

- Provider: `ollama`
- Base URL: `http://<windows-host>.<tailnet>.ts.net:11434` (Tailscale) or `http://192.168.x.x:11434` (LAN)
- Click **Probe** to verify connectivity

Allowed URL prefixes for manual Ollama endpoints:
- `http://localhost` / `http://127.0.0.1`
- `http://192.168.*` (LAN)
- `http://10.*` (LAN)
- `http://172.16-31.*` (LAN)
- `http://100.*` (Tailscale CGNAT range)

Public internet IPs are rejected.

### 3. Tailscale hostname

```powershell
# On the Windows machine, confirm your tailnet hostname:
tailscale status
# Use: http://<machine-name>.<tailnet>.ts.net:11434
```

---

## Settings UI

Open Settings → Auxiliary Models:

| Setting | Description |
|---|---|
| **Enable auxiliary routing** | Master on/off switch |
| **Routing mode** | `local-first` tries local/worker models before cheap cloud; `cheap-first` reverses that; `manual-only` only uses explicitly configured endpoints |
| **Allow worker-node models** | Include Ollama endpoints discovered from connected worker nodes |
| **Discovered candidates** | Automatically probed endpoints — shows health, model count, and source |
| **Manual endpoint** | Add a LAN/Tailscale Ollama or OpenAI-compatible endpoint |
| **Slot table** | Enable/disable per slot, configure timeout |

---

## Slot Reference

| Slot | Use | Recommended model |
|---|---|---|
| `compression` | Context compaction summaries | gemma4:26b or 12b |
| `memoryDistillation` | Long-term memory summarization | gemma4:26b or 12b |
| `webExtract` | Web page content extraction | gemma4:12b |
| `titleGeneration` | Auto-title for conversations | gemma4:12b |
| `routingClassification` | Advisory — explains eligible cheap-model requests | gemma4:12b |
| `approvalScoring` | Advisory only — does not affect approval decisions | gemma4:12b |
| `loopScoring` | Advisory loop quality scores | gemma4:12b |

**Safety boundaries:**
- `approvalScoring` is advisory only. The approval policy and user confirmation remain the authority.
- `routingClassification` is advisory only. Model routing decisions are not changed.
- Main chat agents, file mutations, shell execution, security review, and cross-model verification always use the configured frontier provider.

---

## Troubleshooting

### Is Ollama running?

```bash
curl http://127.0.0.1:11434/api/version
# Expected: {"version":"x.x.x"}

curl http://127.0.0.1:11434/api/tags
# Expected: {"models":[{"name":"gemma4:12b",...},...]}
```

### From Windows (PowerShell)

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/version
Invoke-RestMethod http://127.0.0.1:11434/api/tags
nvidia-smi
```

### Is the worker node connected?

Settings → Remote Nodes → verify the node appears with status `connected`.

Once connected, go to Settings → Auxiliary Models → Discovered candidates. The worker's Ollama should appear with source `worker-node`.

### Candidate is unhealthy

1. Check Ollama is running (`ollama serve`)
2. Check the worker node heartbeat (Settings → Remote Nodes → latency/last heartbeat)
3. Probe manually: Settings → Auxiliary Models → Manual endpoint → Probe

### Compression still works when Ollama is stopped

Expected behavior. When no auxiliary model is available, the system falls back to the existing deterministic local summarization in `LLMService`. Main chat sessions are unaffected.

### API key env var not working

`apiKeyEnv` must be an environment variable **name** (e.g., `OPENAI_API_KEY`), not the raw key value. Raw API key strings are rejected. Set the variable in your shell environment before launching AI Orchestrator.

---

## Modifying `docs/WORKER_AGENT_SETUP.md`

Add a section after the enrollment steps:

```markdown
## Local Model Discovery (Auxiliary Routing)

When a worker agent reports capabilities on heartbeat, it probes `http://127.0.0.1:11434/api/tags` (2 s timeout). If Ollama is running on the worker host, the discovered models appear as `localModelEndpoints` in the heartbeat payload.

The coordinator picks these up automatically. No extra configuration is needed — once the worker is connected, open Settings → Auxiliary Models to see the discovered endpoints.
```

## Modifying `docs/REMOTE_ACCESS.md`

Add a note under the Tailscale section:

```markdown
## Auxiliary Model Access via Tailscale

For direct Ollama access (not via worker-agent proxy), expose Ollama on `0.0.0.0:11434` on the remote host and use its Tailscale hostname (`http://<host>.<tailnet>.ts.net:11434`) as a manual endpoint in Settings → Auxiliary Models. Tailscale encrypts the connection; no additional TLS setup is required for private-network auxiliary calls.
```
