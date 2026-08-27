import { spawnSync } from 'child_process';
import { buildCliSpawnOptions } from './cli-environment';
import { resolveCommandOnPath } from './cli-path-resolver';

export interface CopilotCliLaunchConfig {
  command: string;
  argsPrefix: string[];
  displayCommand: string;
  path?: string;
}

function commandRuns(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    ...buildCliSpawnOptions(env, platform),
  });

  return result.status === 0;
}

/**
 * Memo for the default (ambient env/platform) resolution only.
 *
 * Discovery costs up to three synchronous child processes — `which copilot`,
 * `which gh`, and a `gh copilot --help` probe bounded at 5000ms — and on a
 * machine without the standalone binary it was measured at 5007ms. The Copilot
 * adapter factory in `adapters/adapter-factory.ts` runs it once per spawn on the
 * Electron main thread, so without a memo every Copilot session start could
 * stall the UI for five seconds.
 *
 * NOTE for future editors: do not write that factory function's name followed by
 * an open bracket anywhere in this file. `copilot-route-preflight.spec.ts` greps
 * `src/main` for that literal to find adapter-creating call sites, and a mention
 * in prose is indistinguishable from a real one — it will fail the
 * unrouted-spawn-path guard.
 *
 * Deliberately only memoized for the default arguments: `cli-detection`,
 * `provider-doctor` and `cli-update-service` pass explicit env/platform in tests
 * and must never see another caller's cached answer.
 */
let defaultLaunchMemo: { value: CopilotCliLaunchConfig | null } | null = null;

/**
 * Drop the memo. `cli-update-service` calls this after installing or updating
 * the CLI, because a cached `null` from before an install would otherwise
 * outlive the install and keep reporting the CLI as missing.
 */
export function resetCopilotCliLaunchCache(): void {
  defaultLaunchMemo = null;
}

export function resolveCopilotCliLaunch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CopilotCliLaunchConfig | null {
  const isDefaultLookup = env === process.env && platform === process.platform;
  if (isDefaultLookup && defaultLaunchMemo) {
    return defaultLaunchMemo.value;
  }
  const resolved = resolveCopilotCliLaunchUncached(env, platform);
  if (isDefaultLookup) {
    defaultLaunchMemo = { value: resolved };
  }
  return resolved;
}

function resolveCopilotCliLaunchUncached(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): CopilotCliLaunchConfig | null {
  const standalonePath = resolveCommandOnPath('copilot', env, platform);
  if (standalonePath) {
    return {
      command: standalonePath,
      argsPrefix: [],
      displayCommand: 'copilot',
      path: standalonePath,
    };
  }

  const ghPath = resolveCommandOnPath('gh', env, platform);
  if (ghPath && commandRuns(ghPath, ['copilot', '--help'], env, platform)) {
    return {
      command: ghPath,
      argsPrefix: ['copilot', '--'],
      displayCommand: 'gh copilot',
      path: ghPath,
    };
  }

  return null;
}

export function getDefaultCopilotCliLaunch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CopilotCliLaunchConfig {
  return resolveCopilotCliLaunch(env, platform) ?? {
    command: 'copilot',
    argsPrefix: [],
    displayCommand: 'copilot',
  };
}
