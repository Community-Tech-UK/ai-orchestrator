# Local-First Voice STT — Architecture Plan

**Status:** COMPLETED — phases 0-6 implemented and verified; renamed `_completed`.
**Date:** 2026-06-21 (rev 2 — corrected topology: GPU box is a remote worker node, not localhost)
**Author:** planning pass for James

---

## 0. The correction that drives this plan (rev 2)

**rev 1 assumed the STT engine runs on `localhost` of the app machine. That was
wrong.** Verified topology:

- The **Electron app runs on the Mac** (the local TTS provider is macOS-only
  `/usr/bin/say`, `macos-say-tts-provider.ts`).
- The **GPUs (RTX 5090 + 3080 Ti) live on a Windows machine** that is already a
  first-class **remote worker node** running `src/worker-agent`. It already:
  - reports GPU/CLIs/memory via heartbeat (`capability-reporter.ts`, `detectGpu` via `nvidia-smi`),
  - probes its **own** local model servers (Ollama `127.0.0.1:11434`, LM Studio
    `127.0.0.1:1234`) and advertises them as `WorkerLocalModelCapability[]`
    (`capability-reporter.ts:70-107`),
  - serves LLM generation to the Mac coordinator over an RPC proxy
    (`auxiliaryModel.generate`) — **the coordinator never dials the worker's
    127.0.0.1 directly** (`auxiliary-llm-service.ts:508-528`).

**Therefore local STT is a *remote-node* feature, not a localhost feature.** The
Mac captures mic audio; the **Windows node transcribes it on its GPU**; the audio
travels over the existing worker RPC channel (WebSocket, JSON-RPC 2.0, base64,
80 MB/frame cap). Worker-node STT is the **primary path**, with a Mac-local
engine and OpenAI cloud as secondary/fallback. This is the structural change
versus rev 1.

---

## 1. Goal

Make session STT **local-first**, preferring on-prem GPU transcription (the
Windows worker) over the cloud, and reusing the proven worker-node /
`AuxiliaryLlmService` machinery rather than inventing a parallel one. Fall back
to OpenAI realtime only when no healthy local option exists.

### Non-goals
- Bundling/compiling a Whisper binary or weights into the DMG (the engine runs
  on the worker; the app only makes RPC calls).
- Replacing the OpenAI realtime path — it stays as the cloud fallback and the
  best token-live option when a key is present.
- Local TTS work — **already** local-first on macOS (`local-macos-say` beats
  `openai-tts`, `voice-service.ts:247-254`). No change.
- Arbitrary-language translation. **English-only v1** (see §1a) → cut.

---

## 1a. Decisions locked (2026-06-21, from James)

**Topology:** Mac app ↔ Windows worker node (Ryzen 9 9950X3D, 192 GB, RTX 5090
32 GB Blackwell sm_120, RTX 3080 Ti 12 GB). The Windows box already runs the
worker-agent and is used for CLI execution, GPU/Ollama workloads, and (in
progress) remote terminals.

- **D-Topology (NEW, rev 2):** STT engine runs **on the Windows worker node**.
  Coordinator proxies audio via the existing worker RPC channel. Worker-node STT
  = **primary path** (was "deferred" in rev 1 — reversed).
- **D-Engine:** **`speaches`** (a.k.a. `faster-whisper-server`) on the Windows
  node — CTranslate2/faster-whisper exposing OpenAI-compatible
  `POST /v1/audio/transcriptions` at worker-local `127.0.0.1:8000`. The worker
  probes it and advertises it; the coordinator reaches it only via RPC.
- **D-Model:** **`distil-large-v3`** (English, ~6× faster than large-v3). Trivial
  for either GPU.
- **D-GPU:** Pin the STT server to the **3080 Ti** (`CUDA_VISIBLE_DEVICES=1`) so
  the 5090 stays free for agents/LLMs. App is GPU-agnostic.
- **D-Blackwell gotcha:** sm_120 needs **CUDA 12.8+** and a recent
  CTranslate2/PyTorch build. Use the current official `speaches` CUDA container;
  a stale build silently CPU-falls-back. Documented in worker setup notes.
- **D-Language:** **English only v1.** No translation slot/hop. A `task` field
  (`'transcribe'|'translate'`) is plumbed for a future foreign→English toggle.
- **D-Latency:** Near-realtime (segment-level finals) **accepted**.
- **D-Location preference:** Routing is `auto` — prefer a healthy **this-device**
  engine (the Mac running the app; audio never leaves the box, no network hop),
  else a **worker node**, else **cloud**. Configurable — the Windows GPU is far
  more powerful, so James may pin `worker-node` for accuracy/throughput over the
  this-device latency/privacy win.
- **D-Hosts (NEW):** A local engine may run on (a) **this Mac** → this-device
  backend, direct localhost HTTP; or (b) **another machine** — the Windows GPU
  box *or* a second Mac — which runs the **worker-agent** and is reached via the
  **RPC proxy** (never dial a remote box's localhost directly, even another Mac).
  "Another Mac" is just a worker node advertising `localSttEndpoints`; **zero new
  code** beyond the worker-node path we're already building.
- **D-Engine-by-host (NEW):** NVIDIA host (Windows) → **`speaches`/faster-whisper
  (CTranslate2)** on the 3080 Ti. **Apple Silicon** host → **whisper.cpp
  (Metal/Core ML)** via its `whisper-server` — CTranslate2 is CPU-bound on macOS,
  so don't run speaches there. Both expose an OpenAI-compatible
  `/v1/audio/transcriptions`, so the provider/backend code is identical; only the
  engine binary/container differs per host.
- **D-Network:** Mac ↔ other nodes over **Tailscale** (WireGuard). Per-segment
  RTT is low but non-zero and can be off-LAN → keep segments small (~3–5 s) and
  prefer this-device when present. Expose `voiceLocalSttMaxSegmentMs` for tuning.

---

## 2. Current state (verified by reading the code)

### 2.1 STT — cloud only
- `VoiceService` (`src/main/services/voice/voice-service.ts:54-56`) holds one
  transcription provider: `OpenAiRealtimeTranscriptionProvider`. It mints an
  ephemeral OpenAI realtime (WebRTC) session
  (`openai-realtime-transcription-provider.ts:60`) returning
  `{ clientSecret, sdpUrl, expiresAt, model }`.
- The renderer (`realtime-transcription.service.ts`) opens an `RTCPeerConnection`,
  adds the mic track, reads token deltas off the `oai-events` data channel
  (lines 75-145, 357-408). **This transport is intrinsically OpenAI-shaped.**
- `selectActiveTranscriptionProviderId` only returns `openai-realtime`
  (`voice-service.ts:240-245`).

### 2.2 Local STT is scaffolded but hard-disabled
- `localWhisperStatus()` detects a `whisper`/`whisper-cli` binary on PATH but
  always reports `available: false` (`voice-service.ts:269-285`). The status
  contract already models `source: 'local'`, `privacy: 'local'`,
  `capabilities: ['stt']` (`voice.schemas.ts:8-19`).

### 2.3 The reusable machinery (this is what we copy)
- **Worker RPC**: `sendServiceRpc(nodeId, method, params, timeoutMs)`
  (`service-rpc-client.ts`) → `WorkerNodeConnectionServer.sendRpc()`. JSON-RPC
  2.0 over WebSocket; **max frame ≈ 80 MB**
  (`WORKER_NODE_WS_MAX_PAYLOAD_BYTES = BROWSER_CDP_MAX_FRAME_BYTES + 16 MB`,
  `rpc-schemas.ts`). Unreachable node → pending RPCs reject immediately.
- **Heartbeat capabilities**: `WorkerNodeCapabilities` includes
  `localModelEndpoints?: WorkerLocalModelCapability[]`
  (`worker-node.types.ts:12-26,89-113`); `provider: 'ollama' | 'openai-compatible'`,
  `baseUrl`, `models`, `healthy`. Worker probes its own servers and advertises
  them (`capability-reporter.ts:70-107`).
- **Worker dispatch**: `worker-rpc-dispatcher.ts` switches on `msg.method`,
  Zod-validates params, runs a handler, returns a result. Aux example:
  `case COORDINATOR_TO_NODE.AUXILIARY_MODEL_GENERATE` → POSTs to the worker's
  local model server, returns `{ text }`.
- **Coordinator proxy**: `auxiliary-llm-service.ts:508-528` — for
  `source: 'worker-node'` endpoints it calls `sendServiceRpc(workerNodeId,
  'auxiliaryModel.generate', {...}, timeoutMs+1000)` and uses `result.text`.
  **Never dials worker localhost.**
- **Correction to a tempting assumption:** Ollama/LM Studio serve **LLMs**, not
  Whisper STT. So we cannot reuse `auxiliaryModel.generate`; we add a sibling
  `audio.transcribe` method that follows the identical shape.

---

## 3. Key architectural decisions

### D1 — STT engine = OpenAI-compatible HTTP server on the worker, reached via RPC
Run `speaches` on the Windows node, exposing `/v1/audio/transcriptions` at
worker-local `127.0.0.1:8000`. The worker probes/advertises it; the coordinator
POSTs audio to it **only through the `audio.transcribe` RPC proxy**. Rationale:
mirrors the proven aux-LLM worker proxy; no native compile; no DMG bloat; keeps
the worker's port unexposed on the LAN.

Secondary backends, same provider interface:
- **this-device HTTP** — a Mac-local OpenAI-compatible engine (e.g. whisper.cpp
  server with Metal), dialed directly by main (no RPC). Optional; lowest latency
  + best privacy when present.
- **cli-binary** — `whisper-cli` one-shot (this-device or worker), batch only,
  optional fallback. On Windows use file-path args, never inline JSON (the
  `shell:true` cmd.exe quote-stripping gotcha).

### D2 — New worker RPC method `audio.transcribe` (mirror `auxiliaryModel.generate`)
- Method constant in `worker-node-rpc.ts` (`COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE
  = 'audio.transcribe'`).
- Zod `AudioTranscribeParamsSchema` in `rpc-schemas.ts`:
  `{ provider: 'openai-compatible'|'whisper-cli', baseUrl?, model, language,
  task: 'transcribe'|'translate', audioBase64, sampleRate, timeoutMs }`.
  Register in the schema-lookup map and `WORK_DISPATCH_METHODS`.
- Worker handler `handleAudioTranscribe` (`worker-rpc-dispatcher.ts`):
  base64-decode → multipart `POST 127.0.0.1:8000/v1/audio/transcriptions`
  (`model`, `language`, `response_format: 'json'`, `task`) → return `{ text }`.
- Coordinator timeout = handler `timeoutMs` + margin (per aux convention).

### D3 — Capability advertising: a dedicated STT field on the heartbeat
Add `capabilities.localSttEndpoints?: WorkerLocalSttCapability[]`
(`provider`, `baseUrl`, `models`, `healthy`) rather than overloading
`localModelEndpoints` (LLM semantics). The worker probes `speaches`
(`GET /v1/models` or `/health`) in `detectLocalModelEndpoints`'s sibling and
advertises it (or `healthy: false` when installed-but-down, mirroring the
Ollama/LM-Studio pattern at `capability-reporter.ts:79-104`). The coordinator
reads it in `rpc-event-router.ts` heartbeat handling.

### D4 — Explicit transport discriminator in the voice provider contract
The session contract bakes in OpenAI's WebRTC shape. Add `transport`:
- `transport: 'webrtc'` → existing OpenAI path (`clientSecret`, `sdpUrl`).
- `transport: 'local-segmented'` → renderer captures + segments audio, sends WAV
  segments to **main** over IPC; main routes each to the resolved backend
  (worker RPC / this-device HTTP / CLI) and emits partial/final transcript
  events back. Network/RPC stays in main; renderer never dials anything.

### D5 — Renderer capture: Web Audio PCM + silence segmentation (NOT MediaRecorder chunks)
**Correcting rev 1's hand-wave.** `MediaRecorder` timeslices produce webm/opus
fragments that are **not individually decodable** after the first — wrong for
per-segment transcription. Instead:
- Capture via Web Audio `AudioWorklet` (ScriptProcessor fallback) → Float32 PCM.
- Downsample to **16 kHz mono**, accumulate into an utterance buffer.
- Segment on a **silence boundary** using RMS energy — **reuse the existing
  meter** (`createAudioMeter`, `realtime-transcription.service.ts:319-355`,
  extracted to a shared helper) with min/max-duration guards.
- Encode each segment as a 16 kHz mono 16-bit **WAV**, hand to main over IPC.
This gives clean, independently-transcribable segments and exact latency control.

### D6 — Health-aware, `auto`-location routing
`getStatus()` is sync → it reads **cached** health (60 s TTL, mirror
`auxiliary-llm-service.ts:430-454`); a background probe refreshes. Selection
order per `voiceSttRoutingMode`/`auto`:
**this-device engine (if healthy) → worker-node STT (if a healthy worker
advertises one) → OpenAI cloud (if keyed) → unavailable** with a clear
`requiresSetup` message. (Rationale for preferring this-device over worker for
STT — unlike aux LLM's worker-first ordering — lower latency, audio stays local,
no dependency on the worker being up. Configurable.)

### D8 — How `auto` *knows* an engine exists (detection mechanism)
`auto` prefers this-device only when it can confirm a healthy STT engine. The
two locations are detected differently:

- **Worker node — passive (advertised).** The worker-agent probes its **own**
  `127.0.0.1` engine and reports `capabilities.localSttEndpoints` (with
  `healthy`) on every heartbeat — same as Ollama/LM Studio today
  (`capability-reporter.ts:79-104`). The coordinator just **reads the flag**; it
  never probes the worker. "Installed but down" surfaces as `healthy:false`.

- **This device — active (localhost health probe).** Mirror
  `AuxiliaryLlmService`'s health pattern:
  1. **Resolve candidate URL:** explicit `voiceThisDeviceSttEndpointUrl`, else a
     short well-known list probed once — whisper.cpp `whisper-server`
     (`127.0.0.1:8080`), speaches (`127.0.0.1:8000`). Gated by
     `voiceLocalSttEnabled`.
  2. **Probe:** `GET /v1/models` (or `/health`) with a 1–2 s `AbortController`
     timeout (cf. `checkOllamaHealth`, `llm-service.ts:1024`).
  3. **STT-disambiguation (critical):** a bare `/v1/models` could be an LLM
     server (Ollama/LM Studio), **not** a transcriber. Require evidence it's
     STT: the audio route exists (`/v1/audio/transcriptions` answers GET with
     405/400, not 404) **or** the model list contains a whisper/distil-like id.
     Without that, do **not** mark this-device available — never route audio to a
     chat server.
  4. **Cache 60 s** (the aux `healthCache` TTL); re-probe on settings change.

- **Binary-only — weak signal.** `commandExists('whisper-cli')`
  (`voice-service.ts:270`) means *installed*, not *running*. It powers only the
  `cli-binary` fallback and is reported `configured: true` but `available` only
  after a transcription actually succeeds.

**Cold-cache behavior:** `getStatus()` is synchronous → it reads the cached
verdict. A background probe runs at startup, on settings change, and on cache
expiry. Until the first this-device probe resolves, `auto` treats this-device as
"unknown → not yet available" and falls to the next tier (worker → cloud); when
the probe reports healthy, `auto` flips to this-device. This transient is
deliberate and documented, not a bug.

### D7 — Near-realtime, not token-live, for local
Local segment transcription yields segment-level finals (no per-token deltas).
Surface the tradeoff in the UI (`latencyClass: 'live' | 'near-realtime'`).
On a 3080 Ti with distil-large-v3, inference per ~3–5 s segment is sub-second;
LAN/Tailscale RTT is negligible → perceived latency ≈ segment length.

---

## 4. Target architecture (component view)

```
MAC (coordinator / Electron)                                    WINDOWS worker node
────────────────────────────                                   ───────────────────
Renderer
  mic ─► AudioWorklet ─► 16kHz mono PCM ─► silence segmenter ─► WAV segment
                                                  │ IPC VOICE_LOCAL_STT_CHUNK
                                                  ▼
Main / VoiceService.LocalWhisperTranscriptionProvider
   resolve backend by routing (auto):
     ├─ this-device HTTP  ─► direct fetch ─► Mac-local whisper server (optional)
     ├─ worker-node       ─► sendServiceRpc(nodeId,'audio.transcribe',{audioBase64,…})
     │                                                   │ WebSocket JSON-RPC (≤80MB)
     │                                                   ▼
     │                                        worker-rpc-dispatcher
     │                                          handleAudioTranscribe
     │                                          POST 127.0.0.1:8000/v1/audio/transcriptions
     │                                          (speaches · distil-large-v3 · 3080 Ti)
     │                                                   │  { text }
     │                          ◄────────── RPC reply ───┘
     └─ cloud fallback    ─► OpenAi realtime (WebRTC, token-live)
   emit VOICE_LOCAL_STT_EVENT {partial|final|error} ─► renderer store
```

Heartbeat: worker probes `speaches` → advertises `capabilities.localSttEndpoints`
→ coordinator marks worker-node STT available.

---

## 5. Contract / type changes

> AGENTS.md packaging gotcha #1: any **new** `@contracts/...` subpath must be
> added to `tsconfig.json`, `tsconfig.electron.json`, `register-aliases.ts`, and
> `vitest.config.ts`. Editing existing files needs none; adding new schema files
> does.

### 5.1 Voice schemas (`packages/contracts/src/schemas/voice.schemas.ts`)
1. Session transport discriminated union on `transport`:
   - `webrtc`: today's `{ clientSecret, sdpUrl?, expiresAt?, model, providerId }`.
   - `local-segmented`: `{ model, providerId, sampleRate, maxSegmentMs, language, task }`.
   - Back-compat: missing `transport` defaults to `'webrtc'`.
2. `VoiceTranscriptionProviderId` (`providers/types.ts:9`) →
   `'openai-realtime' | 'local-whisper'`.
3. New IPC payloads: `VoiceLocalSttChunkPayloadSchema`
   `{ sessionId, seq, wavBase64, last?, ipcAuthToken? }`; `VoiceLocalSttEventSchema`
   (main→renderer) `{ sessionId, kind:'partial'|'final'|'error', text?, segmentId?, error? }`.
4. `VoiceProviderStatus`: add `latencyClass?: 'live'|'near-realtime'` and an
   optional `location?: 'this-device'|'worker-node'|'cloud'` for UI labeling.

### 5.2 Remote-node RPC (`src/main/remote-node/`)
1. `worker-node-rpc.ts`: `COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE = 'audio.transcribe'`.
2. `rpc-schemas.ts`: `AudioTranscribeParamsSchema` (§D2); register in the
   method→schema map and `WORK_DISPATCH_METHODS`.
3. `worker-node.types.ts`: `WorkerLocalSttCapability` +
   `WorkerNodeCapabilities.localSttEndpoints?`.

### 5.3 New voice IPC channels
`VOICE_LOCAL_STT_CHUNK` (invoke) + `VOICE_LOCAL_STT_EVENT` (main→renderer push)
in `IPC_CHANNELS`, `packages/contracts/src/channels`, preload voice domain, and
renderer facade.

---

## 6. Settings (`src/shared/types/settings.types.ts`, mirror `auxiliaryLlm*`)

Coordinator-side (the engine itself is configured on the worker):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `voiceSttRoutingMode` | `'auto' \| 'this-device' \| 'worker-node' \| 'cloud' \| 'this-device-or-cloud'` | `'auto'` | location/selection policy |
| `voiceLocalSttEnabled` | `boolean` | `true` | master toggle for local STT |
| `voiceLocalSttWorkerNodeId` | `string` | `''` (auto) | pin a specific worker; empty = first healthy |
| `voiceLocalSttModel` | `string` | `''` (auto) | model hint (e.g. `distil-large-v3`) |
| `voiceLocalSttLanguage` | `string` | `'en'` | English-only v1 |
| `voiceThisDeviceSttEndpointUrl` | `string` | `''` | optional engine on the app's own Mac (direct localhost HTTP, no RPC) |
| `voiceThisDeviceSttApiKeyEnv` | `string` | `''` | optional env var for the this-device endpoint |
| `voiceLocalSttMaxSegmentMs` | `number` | `5000` | max utterance length before forced flush (Tailscale RTT tuning) |

> **Deferred (not v1):** translation mode/target + `translation` aux slot.
> The provider still carries `task` so foreign→English is a later one-line toggle.

Worker-side config (worker-agent, not coordinator settings): the speaches base
URL/port + which GPU — owned by the worker's environment
(`CUDA_VISIBLE_DEVICES`, container args). The worker simply probes and advertises.

---

## 7. Implementation by layer

### 7.1 Worker-agent (Windows) — `src/worker-agent/`
- `capability-reporter.ts`: add `detectSttEndpoints()` (sibling of
  `detectLocalModelEndpoints`) probing `speaches` `GET /v1/models` (2 s timeout,
  reuse `LOCAL_MODEL_PROBE_TIMEOUT_MS`); advertise `localSttEndpoints` (healthy,
  or `healthy:false` when installed-but-down).
- `worker-rpc-dispatcher.ts`: add `case AUDIO_TRANSCRIBE` →
  `handleAudioTranscribe` → multipart POST to the worker-local speaches → `{ text }`.
- `local-model-config.ts`: add the speaches base URL constant.
- Cross-platform-safe (HTTP body, no shell). If a future `whisper-cli` backend is
  added, materialize the WAV to a temp file and pass a **path** arg (Windows
  `shell:true` quote-stripping memory).

### 7.2 Coordinator main — `src/main/`
- New `LocalWhisperTranscriptionProvider`
  (`services/voice/providers/local-whisper-transcription-provider.ts`) implementing
  `VoiceTranscriptionProvider`:
  - `getStatus()` reads cached health across {this-device, worker-node}; replaces
    the former hard-disabled status path; sets `location`/`latencyClass`.
  - `createSession()` → `local-segmented` session (no network at create).
  - `pushSegment(sessionId, seq, wav, last)` → resolve backend per routing.
    Phase 2 implements the worker-node path via `sendServiceRpc(workerNodeId,
    'audio.transcribe', { audioBase64, model, language, task, sampleRate,
    timeoutMs }, timeoutMs+1000)` → emit `final`; Phase 4 owns this-device
    direct `fetch` and CLI fallback.
  - `closeSession()` flush/dispose.
  - A small `LocalSttBackend` seam: worker-node is implemented in Phase 2;
    `ThisDeviceHttpSttBackend` and `CliBinarySttBackend` remain Phase 4.
  - **Worker-import isolation**: lazy-require remote-node modules (they
    transitively import electron) — follow the exact pattern at
    `auxiliary-llm-service.ts:54-110`. Add a `context-worker-import-isolation`
    spec assertion.
- `VoiceService`:
  - construct `LocalWhisperTranscriptionProvider`; add `configure(settings)`
    (clears health cache on change, mirror aux).
  - rewrite `selectActiveTranscriptionProviderId` (line 240-245) for the §D6
    ladder; update `resolveTranscriptionProviderId` error copy (line 199-208).
  - remove the former dead `localWhisperStatus()` path.
- Discovery: query the worker registry for connected nodes advertising
  `localSttEndpoints` (mirror `auxiliary-llm-service.ts` worker-endpoint
  surfacing); honor `voiceLocalSttWorkerNodeId` pin.
- IPC: register `VOICE_LOCAL_STT_CHUNK` handler (Zod-validate, `ensureAuthorized`)
  → `provider.pushSegment`; push `VOICE_LOCAL_STT_EVENT` via `webContents.send`.

### 7.3 Renderer — `src/renderer/app/core/voice/`
- `LocalSegmentedTranscriptionService` with the same surface as
  `RealtimeTranscriptionService.connect()` → `VoiceTranscriptionConnection`
  (`{ events, level, close }`). Implements §D5 capture/segment/WAV; sends
  `VOICE_LOCAL_STT_CHUNK`; maps `VOICE_LOCAL_STT_EVENT` → `VoiceTranscriptEvent`.
  Reuse the extracted RMS meter for `level` and silence detection; reuse the
  `getUserMedia` error mapping (`realtime-transcription.service.ts:148-172`).
- `voice-conversation.store.ts`: after `createTranscriptionSession`, dispatch by
  `session.transport` (`'webrtc'` vs `'local-segmented'`). Downstream unchanged.
- UI (`input-panel.component.ts` + voice settings panel): provider/location
  picker (Auto / This device / Worker GPU / OpenAI), status badge showing
  `location` + `privacy` + `latencyClass`, settings for §6 keys. Reuse the
  Auxiliary-Models settings UI patterns. Empty-state copy: "No local STT engine
  detected — start `speaches` on a worker node (or this device), or add an
  OpenAI key."

---

## 8. Phasing (each phase independently verifiable)

- **Phase 0 — Scaffolding.** ✅ Voice transport discriminator + IPC schemas (§5.1,
  5.3); `audio.transcribe` method/schema (§5.2); `localSttEndpoints` capability
  type; settings (§6). Typecheck + spec compile.
- **Phase 1 — Detection & status.** ✅ Worker `detectSttEndpoints` advertising +
  coordinator discovery/health/`getStatus()`/routing selection (§D6). No capture
  yet — status correctly reports worker-node STT availability when speaches is up.
  Exhaustive routing-matrix unit tests.
- **Phase 2 — Worker transcription RPC.** ✅ Worker `handleAudioTranscribe`
  (POST→speaches) + coordinator `WorkerNodeSttBackend` proxy. Unit-test with
  mocked RPC + mocked speaches.
- **Phase 3 — MVP end-to-end (renderer capture → worker GPU).** ✅ §D5 capture +
  chunked IPC + `LocalSegmentedTranscriptionService` + store dispatch.
  **This is the milestone:** Mac mic → Windows 3080 Ti → live near-realtime
  English transcript. (Live E2E needs the real Windows node + speaches — like
  Piece C's node-pty, it can't be fully verified in the dev env; verify on
  hardware.)
- **Phase 4 — This-device backend (in scope).** ✅ Direct localhost HTTP to a
  whisper.cpp `whisper-server` (Metal/Core ML) on the app's Mac; `whisper-cli`
  one-shot as a further fallback. (A *second* Mac is not this — it's a worker
  node and already covered by Phases 1–3.)
- **Phase 5 — UI/settings polish.** ✅ Voice settings tab exposes local STT
  routing controls, this-device endpoint settings, live provider health, and
  location/privacy/latency labels; the input-panel provider badge now names
  worker-node STT distinctly.
- **Phase 6 — Docs (`WORKER_AGENT_SETUP.md` STT section, `REMOTE_ACCESS.md`),
  full verification gates.** ✅
- **Deferred (post-v1):** foreign→English `task:'translate'` toggle;
  arbitrary-language translation via aux `translation` slot.

---

## 9. Testing strategy (Vitest)

- **Routing matrix:** selection × {auto, this-device, worker-node, cloud,
  this-device-or-cloud} × {this-device healthy?, worker STT healthy?, openai
  keyed?} → expected backend/unavailable. Pure, exhaustive.
- **Health cache:** ≤1 probe/TTL; stale re-probe; config change clears cache.
- **This-device detection (§D8):** healthy whisper endpoint → available; an
  **LLM-only** `/v1/models` (no audio route, no whisper model) → **not** available
  (must not route audio to a chat server); unreachable → not available; cold
  cache → `auto` falls to worker/cloud until the first probe resolves, then flips
  to this-device.
- **Worker capability:** `detectSttEndpoints` advertises healthy/unhealthy
  correctly; coordinator surfaces it; `voiceLocalSttWorkerNodeId` pin honored.
- **`audio.transcribe` RPC:** Zod accept/reject; base64 round-trip; `task`
  plumbing; coordinator timeout = handler+margin; unreachable node → typed error
  → fallback per routing.
- **Backend adapters:** mock `fetch`/multipart (HTTP), mock `sendServiceRpc`
  (worker), mock spawn (CLI).
- **Segmentation:** fake AudioWorklet/PCM; silence boundary triggers a segment;
  min/max-duration guards; WAV header correctness; `seq` ordering; `last` flush.
- **Transport contract back-compat:** a `webrtc` session without `transport`
  still parses.
- **Worker-import isolation:** new main modules must not top-level-import
  `electron` (existing spec + the lazy-require pattern from aux).

Gates (AGENTS.md): `npx tsc --noEmit`,
`npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, targeted `npm run test`.

---

## 10. Transport & performance notes

- Audio rides the worker WebSocket as **base64 in JSON-RPC**; the 80 MB frame cap
  is irrelevant for ~3–5 s 16 kHz mono WAV segments (~100–200 KB). Never send
  whole-session audio in one frame — always segment.
- One RPC round-trip per segment Mac↔Windows (LAN/Tailscale) — negligible vs the
  segment length. distil-large-v3 on a 3080 Ti is sub-second per segment.
- If the worker disconnects mid-session, pending `audio.transcribe` RPCs reject
  immediately (`worker-node-connection.ts`); the provider surfaces a typed error
  and routing can fall back to cloud for subsequent segments.

---

## 11. Packaging & ops (engine lives on the worker, not the DMG)

- The app makes only RPC/HTTP calls → **no native compile, no weights in the
  DMG** → sidesteps packaging gotchas #2/#3.
- **Worker setup (Windows / NVIDIA):** run `speaches` (official CUDA container or
  pip) bound to `127.0.0.1:8000`, `CUDA_VISIBLE_DEVICES=1` (3080 Ti), model
  `distil-large-v3`. **Blackwell:** CUDA 12.8+/recent CTranslate2 — a stale build
  silently CPU-falls-back. Add to `WORKER_AGENT_SETUP.md`.
- **This-device / Mac worker (Apple Silicon):** run **whisper.cpp**
  `whisper-server` (Metal/Core ML) exposing an OpenAI-compatible endpoint — *not*
  speaches (CTranslate2 is CPU-bound on macOS). Same `/v1/audio/transcriptions`
  contract, so identical app/worker code; only the binary differs.
- `cli-binary` backend only spawns an already-installed `whisper-cli`; no
  toolchain requirement; Windows uses file-path args.

---

## 12. Security & privacy

- All engine access stays in **main**; renderer never dials anything. Worker
  speaches port stays worker-private (RPC proxy only), exactly like Ollama today.
- Mac-local endpoint API key (if any) from an env var
  (`voiceThisDeviceSttApiKeyEnv`), never persisted (mirror aux `apiKeyEnv`).
- Audio segments over IPC and RPC are Zod-validated and size-bounded; temp WAVs
  for any CLI backend go to OS temp and are deleted on segment/session close.
- Privacy posture to surface in UI: **this-device** = audio never leaves the Mac;
  **worker-node** = audio leaves the Mac to your own LAN GPU box (not a cloud
  vendor); **cloud** = OpenAI. Label `location`/`privacy` explicitly.

---

## 13. Resolved (2026-06-21) — see §1a / §0
1. **Topology:** STT runs on the Windows worker node; coordinator proxies via
   `audio.transcribe` RPC. Worker-node STT is the primary path.
2. **Engine/model/GPU:** speaches + distil-large-v3, pinned to the 3080 Ti.
3. **Translation:** English-only v1; `task` plumbed for later.
4. **Latency:** near-realtime accepted.
5. **Location preference:** `auto` = this-device → worker → cloud (configurable).
6. **Hosts (confirmed):** engine may run on **this Mac** (this-device, direct
   HTTP) **or another machine** — the Windows GPU box or a **second Mac** — as a
   worker node via RPC. "Another Mac" needs no new code. → Phase 4's this-device
   backend is **in scope** (whisper.cpp/Metal on Apple Silicon), not optional.
7. **Network (confirmed):** **Tailscale** between nodes → keep segments ~3–5 s,
   `voiceLocalSttMaxSegmentMs` default 5000, prefer this-device when present.

### Operational follow-up
- Which Mac (if any) will run a this-device engine, and is it Apple Silicon
  (→ whisper.cpp/Metal) — so I size Phase 4 accordingly?
- Default `auto` preference: this-device-first (latency/privacy) vs pin the
  Windows 5090/3080 Ti (raw power)? `auto` ships this-device-first; easy to flip.

---

## 14. Integration audit checklist (per AGENTS.md)

- [x] New `@contracts` subpath? If a new schema file is added, update
      `tsconfig.json`, `tsconfig.electron.json`, `register-aliases.ts`,
      `vitest.config.ts`. No new subpath was added.
- [x] `audio.transcribe` added to method constants, `rpc-schemas.ts` map,
      `WORK_DISPATCH_METHODS`, and the worker dispatcher switch.
- [x] `localSttEndpoints` added to `WorkerNodeCapabilities` + advertised by the
      worker + read in the coordinator heartbeat router.
- [x] New voice IPC channels in `IPC_CHANNELS`, `packages/contracts/src/channels`,
      preload, renderer facade.
- [x] `LocalWhisperTranscriptionProvider` constructed in `VoiceService`;
      `configure(settings)` invoked on startup + settings change.
- [x] New main modules **lazy-require** remote-node deps (no top-level electron
      import); isolation spec added.
- [x] Renderer store dispatches by `session.transport`.
- [x] Settings keys in `AppSettings` **and** `DEFAULT_SETTINGS`.
- [x] Voice settings tab exposes routing/status controls without adding a
      renderer network path.
- [x] `task` field plumbed session→RPC→worker (defaults `'transcribe'`/`'en'`);
      no `translation` aux slot in v1.
- [x] Tests green; typecheck/lint/loc gates pass for phases 0-5.
- [x] Docs: `WORKER_AGENT_SETUP.md` (speaches/CUDA/GPU pin) + `REMOTE_ACCESS.md`.
```
