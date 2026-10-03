import { spawn } from 'node:child_process';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { resolveHardenedSpawn } from '../../sandbox/seatbelt';
import { buildCliSpawnOptions } from '../cli-environment';
import { killProcessGroup } from './base-cli-process-utils';
import { PosixSpawnCommandResolver } from './posix-spawn-command-resolver';
import { resolveWindowsSpawn } from './windows-cli-spawn';
import { projectOpenCodeConfig } from './opencode-config-shapes';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 10_000;

/** Caller holds the OpenCode startup gate. Never acquire it again here. */
export async function readOpenCodeEffectiveBudgetConfig(params: {
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  writableRoots?: readonly string[];
}): Promise<Record<string, unknown>> {
  try {
    const safeEnv = getSafeEnvForTrustedProcess();
    delete safeEnv['CLAUDECODE'];
    const spawnOptions = buildCliSpawnOptions({ ...safeEnv, ...params.env });
    const hardened = resolveHardenedSpawn({
      hardened: params.writableRoots !== undefined,
      command: 'opencode', args: ['debug', 'config'], writableRoots: params.writableRoots ?? [],
    });
    const command = new PosixSpawnCommandResolver().resolve(hardened.command, spawnOptions.env);
    const target = resolveWindowsSpawn(command, hardened.args, Boolean(spawnOptions.shell), spawnOptions.env ?? {});
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const proc = spawn(target.command, target.args, {
        ...spawnOptions, cwd: params.workingDirectory, stdio: ['ignore', 'pipe', 'ignore'],
        shell: target.shell, detached: target.detached,
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
        if (code !== 0) { fail(); return; }
        try {
          const limits = projectOpenCodeConfig(JSON.parse(Buffer.concat(chunks).toString('utf8')), params.model);
          chunks.length = 0;
          settled = true;
          clearTimeout(timer);
          resolve(limits);
        } catch { fail(); }
      });
    });
  } catch {
    // No native output, config values, paths, or underlying error can escape into diagnostics.
    throw new Error('Unable to resolve OpenCode model limits safely; refusing to replace native configuration.');
  }
}
