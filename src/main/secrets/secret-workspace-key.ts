import * as fs from 'node:fs';
import * as path from 'node:path';
import { NO_WORKSPACE_KEY } from '../../shared/utils/workspace-key';

/**
 * Workspace identity for the workspace secret store.
 *
 * This is deliberately STRICTER than `toWorkspaceId` in
 * `shared/utils/workspace-key.ts`, and the two must not be merged.
 *
 * `toWorkspaceId` is `trim().toLowerCase()`. That is correct for its job — grouping
 * automations and Workboard lanes by project — because a near-miss there just splits a
 * UI group. Keying a credential store on it would mean `/Users/x/proj` and
 * `/Users/x/proj/` are different workspaces, as are a symlink and its target. The
 * failure is closed (a lookup misses rather than crossing into another workspace), so
 * it is not a disclosure risk, but it would surface as "I saved the token and the agent
 * says it cannot find it".
 *
 * This function therefore canonicalises before comparing:
 *   1. blank            -> NO_WORKSPACE_KEY
 *   2. path.resolve()   -> collapses '.', '..' and trailing separators
 *   3. realpath         -> collapses symlinks (best effort; see below)
 *   4. case fold        -> only on case-insensitive filesystems
 *
 * It cannot live in `shared/utils/workspace-key.ts`: that module is pure with zero
 * imports and is loaded by the renderer, so pulling `node:fs` into it would drag Node
 * builtins into the Angular bundle.
 */

/**
 * Case-fold only where the filesystem is case-insensitive. On Linux `/A` and `/a` are
 * genuinely different directories, so folding there would merge two distinct workspaces
 * into one credential scope — the one direction that would be a real disclosure bug.
 */
function foldCase(canonicalPath: string): string {
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  return caseInsensitive ? canonicalPath.toLowerCase() : canonicalPath;
}

/**
 * Normalise a working directory into a stable workspace id for secret storage.
 *
 * @param workingDirectory The instance's working directory (may be empty/null).
 * @returns A canonical workspace id, or {@link NO_WORKSPACE_KEY} when blank.
 */
export function toSecretWorkspaceId(workingDirectory?: string | null): string {
  const trimmed = (workingDirectory ?? '').trim();
  if (!trimmed) return NO_WORKSPACE_KEY;

  const resolved = path.resolve(trimmed);

  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // The path does not exist yet, or is unreadable. Fall back to the resolved form:
    // an unresolvable directory simply keys its own scope. Failing closed here is
    // correct — it can only ever narrow access, never widen it.
  }

  return foldCase(canonical);
}

/**
 * True when a working directory does not identify a real workspace.
 *
 * Secrets are refused for this scope: without it every scratch instance with no
 * working directory would share a single credential pool, which is precisely the
 * account-wide scoping this feature exists to avoid.
 */
export function isUnscopedWorkspace(workspaceId: string): boolean {
  return workspaceId === NO_WORKSPACE_KEY;
}

export { NO_WORKSPACE_KEY };
