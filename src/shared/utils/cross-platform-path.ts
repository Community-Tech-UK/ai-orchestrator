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

/**
 * Resolve a (possibly relative, possibly `../`-prefixed) path against a base
 * directory, returning an absolute path. Works in the renderer without
 * depending on Node's `path` module.
 *
 * - If `relativePath` is already absolute (POSIX `/` or Windows drive prefix
 *   or UNC `\\…`), it is returned as-is (after light normalization).
 * - Otherwise it is joined onto `baseDir` and `.`/`..` segments are collapsed.
 *
 * Examples:
 *   resolveRelativePath('/Users/me/proj', 'PLAN.md')          → '/Users/me/proj/PLAN.md'
 *   resolveRelativePath('/Users/me/proj', '../docs/foo.md')   → '/Users/me/docs/foo.md'
 *   resolveRelativePath('/Users/me/proj', '/tmp/plan.md')     → '/tmp/plan.md'
 *   resolveRelativePath('/Users/me/proj', 'a/./b/../c.md')    → '/Users/me/proj/a/c.md'
 */
export function resolveRelativePath(baseDir: string, relativePath: string): string {
  if (!relativePath) return baseDir;

  const isAbsolutePosix = relativePath.startsWith('/');
  const isAbsoluteWindows = /^[A-Za-z]:[\\/]/.test(relativePath);
  const isUNC = relativePath.startsWith('\\\\') || relativePath.startsWith('//');
  if (isAbsolutePosix || isAbsoluteWindows || isUNC) {
    return relativePath;
  }

  // Detect Windows base for separator handling.
  const isWindowsBase = /^[A-Za-z]:[\\/]/.test(baseDir) || baseDir.startsWith('\\\\');
  const sep = isWindowsBase ? '\\' : '/';

  // Normalize separators to `/` for processing; we'll re-apply `sep` at the end
  // when needed.
  const combined = (baseDir + '/' + relativePath).replace(/[\\/]+/g, '/');
  const segments = combined.split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      // Preserve a leading empty segment so absolute paths keep their leading `/`.
      if (stack.length === 0 && segment === '') {
        stack.push('');
      }
      continue;
    }
    if (segment === '..') {
      // Don't pop past the root (`['']`) or past a Windows drive letter
      // (`['C:']`).
      const top = stack[stack.length - 1];
      if (stack.length > 1 && top !== '..') {
        stack.pop();
      } else if (stack.length === 1 && top === '') {
        // At POSIX root — stay at root.
      } else if (stack.length === 1 && /^[A-Za-z]:$/.test(top ?? '')) {
        // At Windows drive root — stay at drive root.
      } else {
        stack.push('..');
      }
      continue;
    }
    stack.push(segment);
  }

  // Re-apply the appropriate separator for the platform implied by the base.
  if (isWindowsBase) {
    // Stack[0] should be like `C:`; join the rest with `\`.
    if (stack.length > 0 && /^[A-Za-z]:$/.test(stack[0])) {
      return stack[0] + sep + stack.slice(1).join(sep);
    }
    return stack.join(sep);
  }

  // POSIX: stack[0] is '' for absolute paths so the join naturally starts with `/`.
  return stack.join('/');
}
