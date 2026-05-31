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

  if (platform === 'win32') {
    // Windows-only search dirs. POSIX paths (/usr/local/bin, /opt/homebrew/bin,
    // ~/.nvm/.../bin, …) are intentionally EXCLUDED here: they are meaningless
    // on Windows and previously leaked into the spawned CLI's PATH on Windows
    // worker nodes (a Mac-style PATH appearing on a Windows box), which both
    // polluted PATH and gave the false impression the worker's own toolchain
    // was being used. We instead cover the common Windows toolchain locations
    // so git/node/python resolve even when the host process was launched (e.g.
    // as a Windows service) with a minimal PATH. Order matters: first match wins.
    const windowsPaths = [
      `${appData}\\npm`,
      `${localAppData}\\Programs\\nodejs`,
      `${programFiles}\\nodejs`,
      `${programFilesX86}\\nodejs`,
      // Git for Windows (system + per-user installs). git is required for the
      // loop's diff/verify/review flows on a worker.
      `${programFiles}\\Git\\cmd`,
      `${programFiles}\\Git\\bin`,
      `${programFilesX86}\\Git\\cmd`,
      `${localAppData}\\Programs\\Git\\cmd`,
      // winget / Microsoft Store app execution aliases (Python launcher etc.).
      `${localAppData}\\Microsoft\\WindowsApps`,
      // Yarn classic global bin.
      `${localAppData}\\Yarn\\bin`,
    ];
    return [...new Set(windowsPaths.filter(Boolean))];
  }

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

  return [...new Set(posixPaths.filter(Boolean))];
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
