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
