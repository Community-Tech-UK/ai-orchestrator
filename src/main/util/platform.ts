/**
 * Central platform-detection helpers.
 *
 * Never write `process.platform === 'win32'` at a call site.
 * Import from here so all platform branching is traceable and testable.
 *
 * Inspired by agent-orchestrator:packages/core/src/platform.ts golden rule.
 */

export type PlatformId = 'darwin' | 'win32' | 'linux';

export function currentPlatform(): PlatformId {
  const p = process.platform;
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  return 'linux';
}

export const isWindows = (): boolean => process.platform === 'win32';
export const isMac = (): boolean => process.platform === 'darwin';
export const isLinux = (): boolean => process.platform === 'linux';

/** Path separator for the current OS. */
export const pathSeparator = (): string => (isWindows() ? '\\' : '/');

/**
 * Resolves the default shell for the current platform.
 * Respects SHELL/ComSpec env overrides so tests can override without
 * touching process.platform.
 */
export function defaultShell(): string {
  if (isWindows()) return process.env['ComSpec'] ?? 'cmd.exe';
  return process.env['SHELL'] ?? '/bin/sh';
}

/**
 * Returns the system temp directory path, consistent across platforms.
 */
export function systemTempDir(): string {
  return process.env['TEMP'] ?? process.env['TMP'] ?? (isWindows() ? 'C:\\Temp' : '/tmp');
}

/**
 * Returns the user's home directory, consistent across platforms.
 */
export function homeDir(): string {
  return (
    process.env['HOME'] ??
    process.env['USERPROFILE'] ??
    (isWindows() ? 'C:\\Users\\User' : '/home/user')
  );
}

/**
 * Returns the platform-appropriate user data directory.
 * Electron apps should prefer `app.getPath('userData')` when available;
 * this is a fallback for non-Electron contexts (CLI, tests).
 */
export function defaultUserDataDir(appName: string): string {
  if (isMac()) {
    return `${homeDir()}/Library/Application Support/${appName}`;
  }
  if (isWindows()) {
    const appData = process.env['APPDATA'] ?? `${homeDir()}\\AppData\\Roaming`;
    return `${appData}\\${appName}`;
  }
  const xdgData = process.env['XDG_DATA_HOME'] ?? `${homeDir()}/.local/share`;
  return `${xdgData}/${appName}`;
}

/**
 * Whether sandboxing (Seatbelt / bubblewrap) is available on the current OS.
 * Real detection happens in sandbox-manager.ts; this is the fast capability flag.
 */
export function sandboxingSupported(): boolean {
  return isMac() || isLinux();
}
