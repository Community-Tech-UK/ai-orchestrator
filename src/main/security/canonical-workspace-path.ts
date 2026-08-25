/**
 * Canonical workspace paths for security-sensitive prefix matching.
 *
 * A path-prefix routing rule decides which GitHub identity services a
 * workspace, so its comparison has to survive the three ways a raw string
 * compare gets it wrong:
 *
 *  - relative segments (`/a/b/../c`) → `resolve`;
 *  - symlinked checkouts pointing into a protected work root → `realpath`;
 *  - case (macOS and Windows are case-insensitive, Linux is not) → fold on
 *    darwin/win32 only, so `/Work` and `/work` are one path on a Mac and two
 *    distinct paths on Linux, matching what the filesystem actually does.
 *
 * And the separator-boundary comparison, so `/a/bc` is not "inside" `/a/b`.
 */

import { realpathSync } from 'fs';
import { resolve, sep } from 'path';

export interface CanonicalizeOptions {
  /** Injected for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Injected for tests. Defaults to `fs.realpathSync`. */
  realpath?: (path: string) => string;
}

function shouldFoldCase(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * Resolve, realpath (when the path exists), and case-fold a workspace path so
 * two spellings of the same directory compare equal.
 *
 * Non-existent paths are still resolved and folded — a rule may legitimately
 * name a directory that does not exist on this node yet.
 */
export function canonicalizeWorkspacePath(
  path: string,
  options: CanonicalizeOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const realpath = options.realpath ?? realpathSync;
  if (!path) {
    return '';
  }
  const resolved = resolve(path);
  const real = (() => {
    try {
      return realpath(resolved);
    } catch {
      return resolved;
    }
  })();
  return shouldFoldCase(platform) ? real.toLowerCase() : real;
}

/**
 * True when `child` is `parent` or lives beneath it, comparing on separator
 * boundaries. Both arguments must already be canonical.
 */
export function isPathWithin(child: string, parent: string): boolean {
  if (!child || !parent) {
    return false;
  }
  if (child === parent) {
    return true;
  }
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/**
 * Number of path segments in a canonical path. The routing resolver uses this
 * to pick the *longest* matching path prefix — counting segments rather than
 * characters, so `/a/bb` does not beat `/a/b/c`.
 */
export function pathSegmentDepth(path: string): number {
  return path.split(sep).filter(Boolean).length;
}
