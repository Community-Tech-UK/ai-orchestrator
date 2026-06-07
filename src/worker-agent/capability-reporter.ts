import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { WorkerNodeCapabilities, WorkerLocalModelCapability, NodePlatform } from '../shared/types/worker-node.types';
import type { CanonicalCliType } from '../shared/types/settings.types';
import { ProjectDiscovery } from '../main/remote-node/project-discovery';
import {
  OLLAMA_LOCAL_BASE_URL,
  LMSTUDIO_LOCAL_BASE_URL,
  LOCAL_MODEL_PROBE_TIMEOUT_MS,
} from './local-model-config';

/**
 * Detect local capabilities (CLIs, browser, GPU, memory) for reporting
 * to the coordinator. Called once on startup and periodically on heartbeat.
 */
export async function reportCapabilities(
  workingDirectories: string[],
  maxConcurrentInstances = 10,
): Promise<WorkerNodeCapabilities> {
  const supportedClis = detectClis();
  const gpu = detectGpu();

  const discovery = new ProjectDiscovery();
  const projects = await discovery.scan(workingDirectories);

  const localModelEndpoints = await detectLocalModelEndpoints();

  return {
    platform: process.platform as NodePlatform,
    arch: process.arch,
    cpuCores: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    availableMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
    gpuName: gpu.name,
    gpuMemoryMB: gpu.memoryMB,
    supportedClis,
    hasBrowserRuntime: detectBrowser(),
    hasBrowserMcp: false, // Detected at runtime when Chrome MCP connects
    hasDocker: detectDocker(),
    maxConcurrentInstances,
    workingDirectories,
    browsableRoots: workingDirectories,
    discoveredProjects: projects,
    localModelEndpoints,
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
      healthy: true,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

type DetectableCliType = CanonicalCliType | 'ollama';

function detectClis(): CanonicalCliType[] {
  const clis: { name: DetectableCliType; command: string }[] = [
    { name: 'claude', command: 'claude' },
    { name: 'codex', command: 'codex' },
    { name: 'gemini', command: 'gemini' },
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

function detectBrowser(): boolean {
  const paths = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [];

  for (const p of paths) {
    try { fs.accessSync(p); return true; } catch { /* not found */ }
  }

  // Fallback: try which for Linux
  if (process.platform === 'linux') {
    return isCommandAvailable('google-chrome') || isCommandAvailable('chromium-browser');
  }
  return false;
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
