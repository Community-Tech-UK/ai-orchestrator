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

  const posixPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${homeDir}/.local/bin`,
    `${homeDir}/.npm-global/bin`,
    `${homeDir}/.nvm/versions/node/current/bin`,
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

export function shouldUseCliShell(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32';
}
