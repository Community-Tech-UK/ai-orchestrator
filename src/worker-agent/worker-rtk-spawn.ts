import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as path from 'path';
import type { UnifiedSpawnOptions } from '../main/cli/adapters/adapter-factory.types';
import { extendEnvWithRtk } from '../main/cli/adapters/adapter-spawn-helpers';
import { resolveCommandOnPath } from '../main/cli/cli-path-resolver';
import { isVersionAtLeast } from '../main/cli/adapters/claude-cli-feature-probes';
import { getLogger } from '../main/logging/logger';

const logger = getLogger('WorkerRtkSpawn');
type WorkerRtkSpawn = Pick<UnifiedSpawnOptions, 'rtk' | 'permissionHookPath' | 'env'>;

/** Resolve only execution-node paths; the coordinator sends intent, never its paths. */
export function resolveWorkerRtkSpawn(request: { enabled: boolean } | undefined): WorkerRtkSpawn {
  if (!request) return {};
  if (!request.enabled) return { rtk: { enabled: false } };
  const bundleDir = path.dirname(path.resolve(process.argv[1] ?? 'dist/worker-agent/index.js'));
  const filename = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
  const platformDir = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(bundleDir, 'rtk', platformDir, filename),
    path.join(process.cwd(), 'resources', 'rtk', platformDir, filename),
    resolveCommandOnPath('rtk'),
  ];
  const hook = [path.join(bundleDir, 'hooks', 'rtk-defer-hook.mjs'),
    path.join(process.cwd(), 'src', 'main', 'cli', 'hooks', 'rtk-defer-hook.mjs')].find(candidate => fs.existsSync(candidate));
  if (hook) for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const probe = childProcess.spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
    const version = typeof probe.stdout === 'string' ? probe.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] : undefined;
    if (probe.status !== 0 || !isVersionAtLeast(version, '0.23.0')) continue;
    const rtk = { enabled: true, binaryPath: candidate };
    return { rtk, permissionHookPath: hook, env: extendEnvWithRtk({}, rtk) };
  }
  logger.warn('Worker RTK is unavailable; spawning without command rewriting');
  return { rtk: { enabled: false } };
}
