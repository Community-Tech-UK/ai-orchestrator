/**
 * Shared helpers for the instance IPC handlers.
 */
import { getSettingsManager } from '../../core/config/settings-manager';

/**
 * Resolve the working directory for a new instance: an explicit non-'.' path
 * wins, otherwise fall back to the configured default working directory, then to
 * the process cwd. Shared by INSTANCE_CREATE and INSTANCE_CREATE_WITH_MESSAGE.
 */
export function resolveDefaultWorkingDirectory(workingDirectory: string | undefined): string {
  if (workingDirectory && workingDirectory !== '.') {
    return workingDirectory;
  }
  const defaultDir = getSettingsManager().get('defaultWorkingDirectory');
  return defaultDir || process.cwd();
}
