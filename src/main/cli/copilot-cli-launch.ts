import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { buildCliSpawnOptions } from './cli-environment';

export interface CopilotCliLaunchConfig {
  command: string;
  argsPrefix: string[];
  displayCommand: string;
  path?: string;
}

function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if ((command.includes('/') || command.includes('\\')) && existsSync(command)) {
    return command;
  }

  const pathResolver = platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(pathResolver, [command], {
    encoding: 'utf8',
    ...buildCliSpawnOptions(env, platform),
  });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? command;
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

export function resolveCopilotCliLaunch(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
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
