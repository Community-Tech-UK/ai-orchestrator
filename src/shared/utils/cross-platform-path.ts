/**
 * Cross-platform path utilities.
 *
 * Node's `path.basename()` uses the platform's native separator, so on
 * macOS/Linux it does NOT recognise Windows backslash separators.
 * `path.basename('C:\\Users\\foo\\Work')` returns the entire string on POSIX.
 *
 * These helpers normalise both `/` and `\` separators so they work correctly
 * regardless of which platform the coordinator is running on.
 */

function looksWindowsPath(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(filePath)
    || filePath.startsWith('\\\\')
    || filePath.startsWith('//');
}

/**
 * Return the last segment of a file path, handling both `/` and `\` separators.
 *
 * Examples:
 *   crossPlatformBasename('C:\\Users\\shutu\\Documents\\Work')  → 'Work'
 *   crossPlatformBasename('/home/user/project')                 → 'project'
 *   crossPlatformBasename('C:\\Users\\shutu\\')                 → 'shutu'
 *   crossPlatformBasename('')                                   → ''
 */
export function crossPlatformBasename(filePath: string): string {
  if (!filePath) return '';

  // Trim trailing separators, then take everything after the last separator
  const trimmed = filePath.replace(/[\\/]+$/, '');
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
}

/**
 * Normalize a workspace path for cross-platform equality checks.
 *
 * Windows paths are matched case-insensitively and with normalized separators.
 * POSIX paths preserve case but still normalize separators and trailing slashes.
 */
export function normalizeCrossPlatformPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return '';

  const normalized = trimmed
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '');

  return looksWindowsPath(trimmed)
    ? normalized.toLowerCase()
    : normalized;
}

/**
 * Compare two workspace paths while tolerating Windows separator and case differences.
 */
export function crossPlatformPathsEqual(left: string, right: string): boolean {
  return normalizeCrossPlatformPath(left) === normalizeCrossPlatformPath(right);
}
