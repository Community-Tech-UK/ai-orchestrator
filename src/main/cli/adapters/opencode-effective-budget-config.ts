import { spawn } from 'node:child_process';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { resolveHardenedSpawn } from '../../sandbox/seatbelt';
import { buildCliSpawnOptions } from '../cli-environment';
import { killProcessGroup } from './base-cli-process-utils';
import { PosixSpawnCommandResolver } from './posix-spawn-command-resolver';
import { resolveWindowsSpawn } from './windows-cli-spawn';
import { projectOpenCodeConfig } from './opencode-config-shapes';
import { normalizeOpenCodeNativeConfig } from './opencode-v2-config';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 10_000;
const SAFE_PROBE_ERROR = 'Unable to resolve OpenCode model limits safely; refusing to replace native configuration.';

export function openCodeProbeArgs(cliMajor: number): string[] {
  // `debug config` on OpenCode 2 lists files and ignores OPENCODE_CONFIG_CONTENT
  // when a background service is already running. A private API read sees the overlay.
  return cliMajor >= 2 ? ['api', '--standalone', 'GET', '/api/config'] : ['debug', 'config'];
}

/** Caller holds the OpenCode startup gate. Never acquire it again here. */
export async function runOpenCodeCapture(params: {
  command: string;
  args: readonly string[];
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  writableRoots?: readonly string[];
}): Promise<{ code: number; stdout: string }> {
  const safeEnv = getSafeEnvForTrustedProcess();
  delete safeEnv['CLAUDECODE'];
  const spawnOptions = buildCliSpawnOptions({ ...safeEnv, ...params.env });
  const hardened = resolveHardenedSpawn({
    hardened: params.writableRoots !== undefined,
    command: params.command,
    args: [...params.args],
    writableRoots: params.writableRoots ?? [],
  });
  const command = new PosixSpawnCommandResolver().resolve(hardened.command, spawnOptions.env);
  const target = resolveWindowsSpawn(command, hardened.args, Boolean(spawnOptions.shell), spawnOptions.env ?? {});
  return await new Promise((resolve, reject) => {
    const proc = spawn(target.command, target.args, {
      ...spawnOptions,
      cwd: params.workingDirectory,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: target.shell,
      detached: target.detached,
    });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      killProcessGroup(proc.pid, 'SIGKILL');
      reject(new Error('Native configuration probe failed'));
    };
    const timer = setTimeout(fail, CONFIG_TIMEOUT_MS);
    proc.on('error', fail);
    proc.stdout?.on('error', fail);
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_CONFIG_BYTES) { fail(); return; }
      chunks.push(Buffer.from(chunk));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      chunks.length = 0;
      killProcessGroup(proc.pid, 'SIGKILL');
      resolve({ code: code ?? 1, stdout });
    });
  });
}

/** Caller holds the OpenCode startup gate. Never acquire it again here. */
export async function readOpenCodeEffectiveBudgetConfig(params: {
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  writableRoots?: readonly string[];
  command?: string;
  cliMajor?: number;
}): Promise<Record<string, unknown>> {
  try {
    const captured = await runOpenCodeCapture({
      command: params.command ?? 'opencode',
      args: openCodeProbeArgs(params.cliMajor ?? 1),
      workingDirectory: params.workingDirectory,
      env: params.env,
      writableRoots: params.writableRoots,
    });
    if (captured.code !== 0) throw new Error('Native configuration probe failed');
    return projectOpenCodeConfig(normalizeOpenCodeNativeConfig(JSON.parse(captured.stdout)), params.model);
  } catch {
    // No native output, config values, paths, or underlying error can escape into diagnostics.
    throw new Error(SAFE_PROBE_ERROR);
  }
}
