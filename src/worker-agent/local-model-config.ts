/**
 * Worker-local auxiliary model server defaults.
 *
 * These loopback endpoints live on the worker node and are NEVER dialed by the
 * coordinator directly — the coordinator only ever reaches them by proxy via the
 * `auxiliaryModel.list` / `auxiliaryModel.generate` RPC methods. Both the
 * capability reporter (which advertises what is running) and the RPC dispatcher
 * (which serves the proxied calls) import these constants so the probed URL and
 * the served URL can never drift apart.
 */

/** Default Ollama REST endpoint (native `/api/*` API). */
export const OLLAMA_LOCAL_BASE_URL = 'http://127.0.0.1:11434';

/**
 * Default LM Studio local server endpoint (OpenAI-compatible `/v1/*` API).
 * LM Studio's "Local Server" listens on port 1234 by default. Other
 * OpenAI-compatible servers (llama.cpp, vLLM, …) use different ports and are
 * not auto-detected; configure those as a manual endpoint on the coordinator.
 */
export const LMSTUDIO_LOCAL_BASE_URL = 'http://127.0.0.1:1234';

/**
 * Default worker-local OpenAI-compatible STT endpoint. The coordinator must not
 * dial this worker loopback URL directly; audio reaches it only through the
 * worker-agent `audio.transcribe` RPC proxy.
 */
export const SPEACHES_STT_LOCAL_BASE_URL = 'http://127.0.0.1:8000';

/** Timeout for the lightweight startup/heartbeat reachability probes. */
export const LOCAL_MODEL_PROBE_TIMEOUT_MS = 2000;
