import * as path from 'path';
import { app } from 'electron';

let override: string | null = null;

/**
 * Harness's own data folder for the Plan Queue (inside the app's user-data folder). Rescue copies of
 * planning files that could not be moved are kept here, so they survive the removal of a work folder
 * and are not tied to one repository's Git directory.
 */
export function getPlanQueueDataDir(): string {
  if (override) return override;
  if (typeof app?.getPath !== 'function') {
    throw new Error("Harness's data folder is not available outside the app");
  }
  return path.join(app.getPath('userData'), 'plan-queue');
}

/** Tests run outside Electron; they point the data folder at a temporary one. Pass null to clear. */
export function _setPlanQueueDataDirForTesting(dir: string | null): void {
  override = dir;
}
