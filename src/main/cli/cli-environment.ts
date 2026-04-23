import { existsSync, readdirSync } from 'fs';

function parseNodeVersionParts(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
}

function compareNodeVersionNamesDesc(left: string, right: string): number {
  const leftParts = parseNodeVersionParts(left);
  const rightParts = parseNodeVersionParts(right);

  if (!leftParts || !rightParts) {
    return right.localeCompare(left);
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return rightParts[index] - leftParts[index];
    }
  }

  return 0;
}

function getNvmVersionBinPaths(homeDir: string): string[] {
  if (!homeDir) {
    return [];
  }

  const nvmVersionsDir = `${homeDir}/.nvm/versions/node`;
  if (!existsSync(nvmVersionsDir)) {
    return [];
  }

  try {
    return readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && parseNodeVersionParts(entry.name))
      .map((entry) => entry.name)
      .sort(compareNodeVersionNamesDesc)
      .map((versionName) => `${nvmVersionsDir}/${versionName}/bin`)
      .filter((binPath) => existsSync(binPath));
  } catch {
    return [];
  }
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

export function getCliAdditionalPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const homeDir = env['HOME'] || env['USERPROFILE'] || '';
  const appData = env['APPDATA'] || '';
  const localAppData = env['LOCALAPPDATA'] || '';
  const programFiles = env['ProgramFiles'] || '';
  const programFilesX86 = env['ProgramFiles(x86)'] || '';
  const nvmVersionBinPaths = getNvmVersionBinPaths(homeDir);

  // Order matters: the first directory containing a given CLI wins.
  // User-managed installs (nvm, ~/.local/bin, ~/.npm-global/bin) come before
  // system-wide ones (Homebrew, /usr/local/bin) because Homebrew's bundled
  // npm global packages often go stale — users upgrade the same CLI under
  // nvm without realizing a forgotten Homebrew-npm copy still shadows it at
  // `/opt/homebrew/bin/<cli>`. When a user's shell has nvm active, that
  // version is their authoritative install and should take precedence.
  const posixPaths = [
    `${homeDir}/.nvm/versions/node/current/bin`,
    ...nvmVersionBinPaths,
    `${homeDir}/.local/bin`,
    `${homeDir}/.npm-global/bin`,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ];

  const windowsPaths = [
    `${appData}\\npm`,
    `${localAppData}\\Programs\\nodejs`,
    `${programFiles}\\nodejs`,
    `${programFilesX86}\\nodejs`,
  ];

  const candidates = platform === 'win32'
    ? [...windowsPaths, ...posixPaths]
    : posixPaths;

  return [...new Set(candidates.filter(Boolean))];
}

export function buildCliPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const currentPath = env['PATH'] || '';
  return [...getCliAdditionalPaths(env, platform), currentPath]
    .filter(Boolean)
    .join(getPathDelimiter(platform));
}

export function buildCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: buildCliPath(env, platform),
  };
}

export function buildCliSpawnOptions(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Pick<import('child_process').SpawnOptions, 'env' | 'shell' | 'windowsHide'> {
  return {
    env: buildCliEnv(env, platform),
    shell: shouldUseCliShell(platform),
    windowsHide: true,
  };
}

export function shouldUseCliShell(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32';
}
