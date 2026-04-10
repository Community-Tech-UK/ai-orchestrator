/**
 * Hook Path Resolver - Resolves paths to CLI hook scripts.
 * Handles both development (src/) and production (packaged app) paths.
 */

import { app } from 'electron';
import { existsSync, chmodSync, constants } from 'fs';
import { accessSync } from 'fs';
import path from 'path';
import { getLogger } from '../../logging/logger';

const logger = getLogger('HookPathResolver');

const HOOK_FILENAME = 'defer-permission-hook.mjs';

/**
 * Resolves the path to the defer permission hook script.
 *
 * In packaged app: extraResources places hooks/ in Contents/Resources/hooks/
 * In dev mode: hooks/ is under src/main/cli/hooks/, relative to dist output
 */
export function getDeferPermissionHookPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'hooks', HOOK_FILENAME);
  }
  // In dev mode: __dirname is dist/main/cli/hooks (compiled output)
  // The .mjs file is in src/main/cli/hooks/ which is 4 levels up from dist/main/cli/hooks
  // But we can also resolve from project root
  return path.resolve(__dirname, '../../../src/main/cli/hooks', HOOK_FILENAME);
}

/**
 * Ensures the hook script exists and is executable.
 * Called once at adapter startup. Returns the resolved path.
 *
 * @throws Error if the hook script is not found
 */
export function ensureHookScript(): string {
  const hookPath = getDeferPermissionHookPath();

  if (!existsSync(hookPath)) {
    logger.error('Defer permission hook script not found', undefined, { hookPath, isPackaged: app.isPackaged });
    throw new Error(`Defer permission hook script not found: ${hookPath}`);
  }

  // Ensure executable on macOS/Linux
  if (process.platform !== 'win32') {
    try {
      accessSync(hookPath, constants.X_OK);
    } catch {
      logger.info('Setting execute permission on hook script', { hookPath });
      chmodSync(hookPath, 0o755);
    }
  }

  logger.debug('Hook script resolved', { hookPath });
  return hookPath;
}
