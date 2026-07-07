import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

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

/**
 * nvm-windows (coreybutler) layout — completely different from bash-nvm:
 *   - versions live directly under %NVM_HOME% as `v<ver>\` and `node.exe` sits
 *     at the version-dir ROOT (no `bin` subdir, unlike bash-nvm)
 *   - the *active* version is exposed via a symlink at %NVM_SYMLINK%
 *     (e.g. `C:\nvm4w\nodejs`, a user-chosen path — NOT necessarily
 *     `C:\Program Files\nodejs`)
 * We put the active symlink first (authoritative), then every installed
 * version dir (newest first) as a fallback so `node`/`npm`/`npx` resolve even
 * if the symlink is unset. Non-existent dirs are harmless on PATH.
 */
function getNvmWindowsNodePaths(
  env: NodeJS.ProcessEnv,
  appData = '',
  activeSymlinkFallback = '',
): string[] {
  const paths: string[] = [];
  const nvmHome = env['NVM_HOME'] || (appData ? `${appData}\\nvm` : '');

  const symlinkCandidates = [
    env['NVM_SYMLINK'] || '',
    getNvmWindowsSettingsSymlink(nvmHome),
    activeSymlinkFallback,
  ];
  for (const symlink of symlinkCandidates) {
    if (symlink) {
      paths.push(symlink);
    }
  }

  if (nvmHome && existsSync(nvmHome)) {
    try {
      readdirSync(nvmHome, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && parseNodeVersionParts(entry.name))
        .map((entry) => entry.name)
        .sort(compareNodeVersionNamesDesc)
        .forEach((versionName) => paths.push(`${nvmHome}\\${versionName}`));
    } catch {
      // ignore unreadable NVM_HOME
    }
  }

  return [...new Set(paths)];
}

function getNvmWindowsSettingsSymlink(nvmHome: string): string {
  if (!nvmHome) {
    return '';
  }

  // Build the on-disk path with the OS-native separator: settings.txt is read
  // from the *real* filesystem, so the separator must match the host (the
  // simulated `platform` arg does not change how `existsSync`/`readFileSync`
  // resolve). Hardcoding `\\` broke lookups on non-Windows hosts running the
  // win32-path tests (the temp dir is created with the native separator).
  const settingsPath = join(nvmHome, 'settings.txt');
  if (!existsSync(settingsPath)) {
    return '';
  }

  try {
    const settings = readFileSync(settingsPath, 'utf8');
    const pathLine = settings
      .split(/\r?\n/)
      .find((line) => /^path\s*:/i.test(line));
    return pathLine?.replace(/^path\s*:\s*/i, '').trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Per-user Python installs (python.org installer default) land under
 * `%LOCALAPPDATA%\Programs\Python\Python<major><minor>\`, with scripts (pip,
 * etc.) in the `Scripts` subdir. Newer versions first. The bare `python` on a
 * stock box otherwise resolves to the Microsoft Store alias stub, which is not
 * a real interpreter — so these dirs must precede WindowsApps on PATH.
 */
function getWindowsPythonPaths(env: NodeJS.ProcessEnv): string[] {
  const localAppData = env['LOCALAPPDATA'] || '';
  if (!localAppData) {
    return [];
  }

  const pythonRoot = `${localAppData}\\Programs\\Python`;
  if (!existsSync(pythonRoot)) {
    return [];
  }

  try {
    const paths: string[] = [];
    readdirSync(pythonRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^Python\d+$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .forEach((name) => {
        paths.push(`${pythonRoot}\\${name}`);
        paths.push(`${pythonRoot}\\${name}\\Scripts`);
      });
    return paths;
  } catch {
    return [];
  }
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function getExistingPathValue(env: NodeJS.ProcessEnv): string {
  return env['PATH'] || env['Path'] || env['path'] || '';
}

export function getCliAdditionalPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const isWindows = platform === 'win32';
  const userProfile = env['USERPROFILE'] || '';
  const homeDir = env['HOME'] || userProfile || '';
  const appData = env['APPDATA'] || (isWindows && userProfile ? `${userProfile}\\AppData\\Roaming` : '');
  const localAppData = env['LOCALAPPDATA'] || (isWindows && userProfile ? `${userProfile}\\AppData\\Local` : '');
  const programFiles = env['ProgramFiles'] || (isWindows ? 'C:\\Program Files' : '');
  const programFilesX86 = env['ProgramFiles(x86)'] || (isWindows ? 'C:\\Program Files (x86)' : '');
  const systemRoot = env['SystemRoot'] || env['windir'] || 'C:\\Windows';
  const nvmVersionBinPaths = getNvmVersionBinPaths(homeDir);
  const nvmWindowsActiveSymlink = programFiles ? `${programFiles}\\nodejs` : '';

  // Order matters: the first directory containing a given CLI wins.
  // User-managed installs (nvm, ~/.local/bin, ~/.npm-global/bin) come before
  // system-wide ones (Homebrew, /usr/local/bin) because Homebrew's bundled
  // npm global packages often go stale — users upgrade the same CLI under
  // nvm without realizing a forgotten Homebrew-npm copy still shadows it at
  // `/opt/homebrew/bin/<cli>`. When a user's shell has nvm active, that
  // version is their authoritative install and should take precedence.
  //
  // NOTE: these `$HOME`-relative entries are kept on Windows too. Windows
  // accepts forward slashes, so `C:\Users\x/.nvm/versions/node/current/bin`
  // resolves — and bash-style nvm is a common way to install node (and the
  // agent CLI wrapper) on a dev Windows box. Dropping them here regressed
  // worker spawn (node/claude unresolvable). The absolute Unix system paths
  // (`/usr/local/bin` etc.) below are no-ops on Windows but harmless: the OS
  // ignores non-existent PATH dirs during command resolution.
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
    // nvm-windows: active-version symlink first, then all installed versions.
    // node.exe lives at the version-dir root here (not in a `bin` subdir).
    ...getNvmWindowsNodePaths(env, appData, nvmWindowsActiveSymlink),
    `${localAppData}\\Programs\\nodejs`,
    `${programFiles}\\nodejs`,
    `${programFilesX86}\\nodejs`,
    // The official Codex desktop installer writes codex.exe here without
    // necessarily persisting this directory on the machine/user PATH. Keep it
    // after normal Node locations because the same directory also contains a
    // bundled node.exe used internally by Codex.
    `${localAppData}\\OpenAI\\Codex\\bin`,
    // Antigravity's Windows installer writes agy.exe here. Packaged Electron
    // starts with a stripped PATH often enough that relying on the user's shell
    // PATH misses an otherwise working install.
    `${localAppData}\\agy\\bin`,
    // Per-user python.org installs (real interpreter + pip), ahead of the
    // WindowsApps Store alias stub below.
    ...getWindowsPythonPaths(env),
    // Git for Windows (system + per-user installs). git is required for the
    // loop's diff/verify/review flows on a worker, and is the toolchain dir
    // that was previously missing — the real defect this list fixes.
    `${programFiles}\\Git\\cmd`,
    `${programFiles}\\Git\\bin`,
    `${programFilesX86}\\Git\\cmd`,
    `${localAppData}\\Programs\\Git\\cmd`,
    // Ollama's Windows installer writes binaries here and adds this directory
    // to the user's PATH. Packaged Electron apps and worker services can start
    // with a stripped PATH, so include it explicitly.
    `${localAppData}\\Programs\\Ollama`,
    `${programFiles}\\Ollama`,
    `${programFilesX86}\\Ollama`,
    // winget / Microsoft Store app execution aliases (Python launcher etc.).
    `${localAppData}\\Microsoft\\WindowsApps`,
    // Yarn classic global bin.
    `${localAppData}\\Yarn\\bin`,
    // Core Windows system dirs. A worker launched detached (service / PM2 /
    // pm-style supervisor) often inherits a minimal PATH that lacks these, so
    // the spawned agent couldn't resolve `cmd`, `where`, `reg`, `ipconfig`,
    // `tasklist`, or the legacy PowerShell — observed live on windows-pc where
    // PATH was just `C:\Program Files\PowerShell\7`. These dirs always exist on
    // Windows; adding them makes the worker robust to a stripped launch PATH.
    `${systemRoot}\\System32`,
    `${systemRoot}`,
    `${systemRoot}\\System32\\Wbem`,
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
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
  const currentPath = getExistingPathValue(env);
  return [...getCliAdditionalPaths(env, platform), currentPath]
    .filter(Boolean)
    .join(getPathDelimiter(platform));
}

export function buildCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const path = buildCliPath(env, platform);
  return {
    ...env,
    PATH: path,
    ...(platform === 'win32' ? { Path: path } : {}),
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
