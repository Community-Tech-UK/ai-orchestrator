import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type {
  WorkerNodeCapabilities,
  WorkerLocalModelCapability,
  WorkerLocalSttCapability,
  WorkerLoadedModel,
  NodePlatform,
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeAndroidAutomationSummary,
  WorkerNodeExtensionRelaySummary,
} from '../shared/types/worker-node.types';
import type { CanonicalCliType } from '../shared/types/settings.types';
import { ProjectDiscovery } from '../main/remote-node/project-discovery';
import {
  OLLAMA_LOCAL_BASE_URL,
  LMSTUDIO_LOCAL_BASE_URL,
  SPEACHES_STT_LOCAL_BASE_URL,
  LOCAL_MODEL_PROBE_TIMEOUT_MS,
} from './local-model-config';

const WORKER_AGENT_STARTED_AT = Date.now();
const WORKER_AGENT_VERSION =
  process.env['AIO_WORKER_AGENT_VERSION']
  ?? process.env['npm_package_version']
  ?? '0.1.0';

/**
 * Detect local capabilities (CLIs, browser, GPU, memory) for reporting
 * to the coordinator. Called once on startup and periodically on heartbeat.
 */
export async function reportCapabilities(
  workingDirectories: string[],
  maxConcurrentInstances = 10,
  browserAutomation?: WorkerNodeBrowserAutomationSummary,
  androidAutomation?: WorkerNodeAndroidAutomationSummary,
  extensionRelay?: WorkerNodeExtensionRelaySummary,
): Promise<WorkerNodeCapabilities> {
  const supportedClis = detectClis();
  const gpu = detectGpu();

  const discovery = new ProjectDiscovery();
  const projects = await discovery.scan(workingDirectories);

  const localModelEndpoints = await detectLocalModelEndpoints();
  const localSttEndpoints = await detectLocalSttEndpoints();

  const hasBrowserRuntime = resolveChromeExecutablePath() !== null;

  return {
    workerAgent: {
      version: WORKER_AGENT_VERSION,
      startedAt: WORKER_AGENT_STARTED_AT,
    },
    platform: process.platform as NodePlatform,
    arch: process.arch,
    cpuCores: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    availableMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
    gpuName: gpu.name,
    gpuMemoryMB: gpu.memoryMB,
    supportedClis,
    hasBrowserRuntime,
    // True only when browser automation is explicitly enabled in worker config
    // AND a Chrome/Chromium executable is resolvable — i.e. the worker can
    // actually inject the chrome-devtools MCP server into spawned agents.
    hasBrowserMcp: (browserAutomation?.enabled ?? false) && hasBrowserRuntime,
    ...(browserAutomation ? { browserAutomation } : {}),
    hasExtensionRelay: (extensionRelay?.enabled ?? false) && (extensionRelay?.running ?? false),
    ...(extensionRelay ? { extensionRelay } : {}),
    hasAndroidMcp: (androidAutomation?.enabled ?? false) && Boolean(androidAutomation?.adbVersion),
    ...(androidAutomation ? { androidAutomation } : {}),
    hasDocker: detectDocker(),
    maxConcurrentInstances,
    workingDirectories,
    browsableRoots: workingDirectories,
    discoveredProjects: projects,
    localModelEndpoints,
    localSttEndpoints,
  };
}

async function detectLocalModelEndpoints(): Promise<WorkerLocalModelCapability[]> {
  const endpoints: WorkerLocalModelCapability[] = [];

  // Probe worker-local model servers. The coordinator must NOT use these
  // 127.0.0.1 URLs directly — they are worker-local and only ever accessed via
  // the auxiliaryModel RPC proxy.
  const ollama = await probeOllamaCapability();
  if (ollama) {
    endpoints.push(ollama);
  } else if (isOllamaInstalled()) {
    // Installed but not currently responding — advertise as unhealthy so the
    // coordinator can surface it (e.g. "start Ollama") rather than hide it.
    endpoints.push({
      provider: 'ollama',
      baseUrl: OLLAMA_LOCAL_BASE_URL,
      models: [],
      healthy: false,
    });
  }

  // LM Studio (OpenAI-compatible server on the default port). Mirrors the
  // Ollama handling: advertise the live endpoint when the local server is
  // running, otherwise advertise it as unhealthy when LM Studio is installed so
  // the coordinator can surface "start the LM Studio local server".
  const lmStudio = await probeLmStudioCapability();
  if (lmStudio) {
    endpoints.push(lmStudio);
  } else if (isLmStudioInstalled()) {
    endpoints.push({
      provider: 'openai-compatible',
      baseUrl: LMSTUDIO_LOCAL_BASE_URL,
      models: [],
      healthy: false,
    });
  }

  return endpoints;
}

async function detectLocalSttEndpoints(): Promise<WorkerLocalSttCapability[]> {
  const endpoint = await probeOpenAiCompatibleSttCapability(SPEACHES_STT_LOCAL_BASE_URL);
  return endpoint ? [endpoint] : [];
}

/** Probe Ollama's native `/api/tags`. Returns null when unreachable. */
async function probeOllamaCapability(): Promise<WorkerLocalModelCapability | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_MODEL_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_LOCAL_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { models?: { name: string }[] };
    return {
      provider: 'ollama',
      baseUrl: OLLAMA_LOCAL_BASE_URL,
      models: (data.models ?? []).map((m) => m.name),
      healthy: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Probe LM Studio's OpenAI-compatible `/v1/models`. Returns null when unreachable. */
async function probeLmStudioCapability(): Promise<WorkerLocalModelCapability | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_MODEL_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${LMSTUDIO_LOCAL_BASE_URL}/v1/models`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { data?: { id: string }[] };
    return {
      provider: 'openai-compatible',
      baseUrl: LMSTUDIO_LOCAL_BASE_URL,
      models: (data.data ?? []).map((m) => m.id),
      loadedModels: await probeLmStudioLoadedModels(),
      healthy: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeOpenAiCompatibleSttCapability(
  baseUrl: string
): Promise<WorkerLocalSttCapability | null> {
  const models = await listOpenAiCompatibleModelIds(baseUrl);
  if (!models) return null;

  const hasAudioRoute = await probeAudioTranscriptionsRoute(baseUrl);
  if (!hasAudioRoute && !models.some(isLikelySttModelId)) {
    return null;
  }

  return {
    provider: 'openai-compatible',
    baseUrl,
    models,
    healthy: true,
  };
}

async function listOpenAiCompatibleModelIds(baseUrl: string): Promise<string[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_MODEL_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as { data?: { id: string }[] };
    return (data.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeAudioTranscriptionsRoute(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_MODEL_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.status === 400 || response.status === 401 || response.status === 405;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isLikelySttModelId(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes('whisper') ||
    normalized.includes('distil-large-v3') ||
    normalized.includes('transcribe');
}

/** Shape of LM Studio's native `/api/v0/models` rows we care about. */
interface LmStudioV0Model {
  id: string;
  state?: string;
  loaded_context_length?: number;
}

/** Pure: extract loaded models + their context from an `/api/v0/models` body. */
export function parseLmStudioLoadedModels(data: unknown): WorkerLoadedModel[] {
  const rows = (data as { data?: LmStudioV0Model[] } | null)?.data ?? [];
  return rows
    .filter((m) => m.state === 'loaded')
    .map((m) => ({ id: m.id, contextLength: m.loaded_context_length ?? 0 }));
}

/**
 * LM Studio's native `/api/v0/models` exposes per-model load state and the
 * context length each loaded model is resident with — richer than the
 * OpenAI-compatible `/v1/models` (which lists every downloaded model with no
 * load state). Returns undefined when the endpoint is unavailable so the
 * coordinator falls back to its size-based pick.
 */
async function probeLmStudioLoadedModels(): Promise<WorkerLoadedModel[] | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_MODEL_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${LMSTUDIO_LOCAL_BASE_URL}/api/v0/models`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!resp.ok) return undefined;
    return parseLmStudioLoadedModels(await resp.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

type DetectableCliType = CanonicalCliType | 'ollama';

function detectClis(): CanonicalCliType[] {
  const clis: { name: DetectableCliType; command: string }[] = [
    { name: 'claude', command: 'claude' },
    { name: 'codex', command: 'codex' },
    { name: 'antigravity', command: 'agy' },
    { name: 'copilot', command: 'gh' },
    { name: 'cursor', command: 'cursor-agent' },
    { name: 'ollama', command: 'ollama' },
  ];

  const found: CanonicalCliType[] = [];
  for (const cli of clis) {
    if (isCommandAvailable(cli.command)) {
      // ollama is detectable but not yet in CanonicalCliType; skip it for now
      if (cli.name !== 'ollama') {
        found.push(cli.name as CanonicalCliType);
      }
    }
  }
  return found;
}

function isCommandAvailable(command: string): boolean {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(whichCmd, [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isOllamaInstalled(): boolean {
  for (const installPath of getOllamaInstallPaths()) {
    if (installPath && fs.existsSync(installPath)) {
      return true;
    }
  }
  return false;
}

function getOllamaInstallPaths(): string[] {
  if (process.platform === 'win32') {
    return [
      `${process.env['LOCALAPPDATA'] ?? ''}\\Programs\\Ollama\\ollama.exe`,
      `${process.env['ProgramFiles'] ?? ''}\\Ollama\\ollama.exe`,
      `${process.env['ProgramFiles(x86)'] ?? ''}\\Ollama\\ollama.exe`,
    ];
  }
  return [];
}

function isLmStudioInstalled(): boolean {
  // The `lms` CLI ships with LM Studio and is the most reliable cross-platform
  // signal; fall back to known install locations when it is not on PATH.
  if (isCommandAvailable('lms')) {
    return true;
  }
  for (const installPath of getLmStudioInstallPaths()) {
    if (installPath && fs.existsSync(installPath)) {
      return true;
    }
  }
  return false;
}

function getLmStudioInstallPaths(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return [
      `${localAppData}\\Programs\\lm-studio\\LM Studio.exe`,
      `${localAppData}\\Programs\\LM Studio\\LM Studio.exe`,
      `${process.env['ProgramFiles'] ?? ''}\\LM Studio\\LM Studio.exe`,
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/LM Studio.app'];
  }
  // Linux: LM Studio ships as an AppImage with no canonical install path, so we
  // rely on the `lms` CLI check above plus the per-user config directory.
  return [`${process.env['HOME'] ?? ''}/.lmstudio`];
}

/**
 * Resolve the path to a Chrome/Chromium (or Edge, as a Chromium fallback)
 * executable for this platform, or null when none is found. Shared by capability
 * detection (`hasBrowserRuntime`) and the worker's browser automation manager,
 * which launches this binary with remote debugging. Pure filesystem checks — no
 * Electron, safe to call from the worker process.
 */
export function resolveChromeExecutablePath(): string | null {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
       'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
         '/Applications/Chromium.app/Contents/MacOS/Chromium',
         '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : [];

  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch { /* not found */ }
  }

  // Linux: no canonical install path — resolve via PATH.
  if (process.platform === 'linux') {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
      const resolved = resolveCommandPath(cmd);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Resolve a command to its absolute path via `which`/`where`, or null. */
function resolveCommandPath(command: string): string | null {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(whichCmd, [command], { stdio: 'pipe' })
      .toString()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return out ?? null;
  } catch {
    return null;
  }
}

function detectGpu(): { name?: string; memoryMB?: number } {
  if (process.platform === 'win32' || process.platform === 'linux') {
    try {
      const output = execFileSync(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { stdio: 'pipe', timeout: 5_000 },
      ).toString().trim();
      if (output) {
        const [name, memory] = output.split(',').map((s) => s.trim());
        return { name, memoryMB: parseInt(memory, 10) || undefined };
      }
    } catch { /* nvidia-smi not available */ }
  }
  return {};
}

function detectDocker(): boolean {
  return isCommandAvailable('docker');
}
