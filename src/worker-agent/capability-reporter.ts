import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { WorkerNodeCapabilities, NodePlatform } from '../shared/types/worker-node.types';
import type { CanonicalCliType } from '../shared/types/settings.types';

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
  };
}

type DetectableCliType = CanonicalCliType | 'ollama';

function detectClis(): CanonicalCliType[] {
  const clis: Array<{ name: DetectableCliType; command: string }> = [
    { name: 'claude', command: 'claude' },
    { name: 'codex', command: 'codex' },
    { name: 'gemini', command: 'gemini' },
    { name: 'copilot', command: 'gh' },
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
