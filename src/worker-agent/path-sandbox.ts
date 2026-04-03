import * as path from 'path';

/**
 * Validate that a requested path is within one of the allowed roots.
 * Prevents path traversal attacks from the coordinator.
 */
export function isPathAllowed(
  requestedPath: string,
  allowedRoots: string[],
): boolean {
  const resolved = path.resolve(requestedPath);

  // Block null bytes (path traversal technique)
  if (resolved.includes('\0')) return false;

  return allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}
