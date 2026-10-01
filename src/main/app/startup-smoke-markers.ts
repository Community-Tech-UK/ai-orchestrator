import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Files the packaged app writes into the throwaway profile owned by
 * `scripts/packaged-startup-smoke.js`. Keep the names in sync with that script.
 */
export const STARTUP_SMOKE_READY_MARKER = 'startup-smoke-ready';
export const STARTUP_SMOKE_PID_MARKER = 'startup-smoke-pid';

interface StartupSmokeContext {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}

/** The smoke's profile directory, or null when this is not a packaged smoke run. */
export function getStartupSmokeDirectory(context: StartupSmokeContext): string | null {
  if (!context.isPackaged || context.env['AIO_STARTUP_SMOKE'] !== '1') return null;
  return context.env['AIO_STARTUP_SMOKE_USER_DATA_PATH'] || null;
}

/**
 * The smoke launches a bootstrap process that relaunches itself with the heap
 * flag and exits 0, so the smoke's own child handle never sees the real app.
 * Publishing the real pid lets the smoke notice the app dying during startup,
 * wait for its self-quit, and kill it if it wedges instead of orphaning it.
 */
export function writeStartupSmokePidMarker(
  context: StartupSmokeContext & { pid: number },
  writeFileSync: typeof fs.writeFileSync = fs.writeFileSync,
): void {
  const directory = getStartupSmokeDirectory(context);
  if (!directory) return;
  writeFileSync(path.join(directory, STARTUP_SMOKE_PID_MARKER), `${context.pid}\n`, 'utf8');
}
