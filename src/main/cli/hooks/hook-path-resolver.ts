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
const RTK_HOOK_FILENAME = 'rtk-defer-hook.mjs';

function quoteHookArg(hookPath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `"${hookPath.replace(/"/g, '""')}"`;
  }

  return `'${hookPath.replace(/'/g, `'\\''`)}'`;
}

function getProjectRoot(): string {
  try {
    const appPath = app?.getAppPath?.();
    if (typeof appPath === 'string' && appPath.length > 0) {
      return appPath;
    }
  } catch {
    // Fall back to cwd when Electron app metadata is not ready.
  }

  return process.cwd();
}

function resolveHookPath(filename: string): string {
  if (app.isPackaged) {
    const resourcesPath =
      typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
        ? process.resourcesPath
        : path.join(getProjectRoot(), 'resources');
    return path.join(resourcesPath, 'hooks', filename);
  }
  return path.join(getProjectRoot(), 'src', 'main', 'cli', 'hooks', filename);
}

/**
 * Resolves the path to the defer permission hook script.
 *
 * In packaged app: extraResources places hooks/ in Contents/Resources/hooks/
 * In dev mode: hooks/ is under src/main/cli/hooks/, relative to dist output
 */
export function getDeferPermissionHookPath(): string {
  return resolveHookPath(HOOK_FILENAME);
}

/**
 * Resolves the path to the combined RTK + defer permission hook script.
 *
 * Strict superset of the defer-permission-hook: when ORCHESTRATOR_RTK_ENABLED
 * is unset or 0, behaves identically. When set to "1", calls `rtk rewrite`
 * on Bash tool calls and mutates tool_input.command.
 */
export function getRtkDeferHookPath(): string {
  return resolveHookPath(RTK_HOOK_FILENAME);
}

/**
 * Claude hook config expects a shell command string, not argv tuples.
 * Execute the script via `node` so the same command works on Windows and Unix.
 */
export function buildDeferPermissionHookCommand(
  hookPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `node ${quoteHookArg(hookPath, platform)}`;
}

function ensureHookFile(hookPath: string, label: string): string {
  if (!existsSync(hookPath)) {
    logger.error(`${label} hook script not found`, undefined, { hookPath, isPackaged: app.isPackaged });
    throw new Error(`${label} hook script not found: ${hookPath}`);
  }

  // Ensure executable on macOS/Linux
  if (process.platform !== 'win32') {
    try {
      accessSync(hookPath, constants.X_OK);
    } catch {
      logger.info(`Setting execute permission on ${label} hook script`, { hookPath });
      chmodSync(hookPath, 0o755);
    }
  }

  logger.debug(`${label} hook script resolved`, { hookPath });
  return hookPath;
}

/**
 * Ensures the hook script exists and is executable.
 * Called once at adapter startup. Returns the resolved path.
 *
 * @throws Error if the hook script is not found
 */
export function ensureHookScript(): string {
  return ensureHookFile(getDeferPermissionHookPath(), 'Defer permission');
}

/**
 * Ensures the RTK + defer combined hook script exists and is executable.
 * Returns the resolved path, falling back to the standard defer hook on failure.
 */
export function ensureRtkDeferHookScript(): string {
  return ensureHookFile(getRtkDeferHookPath(), 'RTK defer');
}
