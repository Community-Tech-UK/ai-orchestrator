import { isAbsolute, join } from 'node:path';

interface HarnessUserDataPathOptions {
  appDataPath: string;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}

export function resolveHarnessUserDataPath(options: HarnessUserDataPathOptions): string {
  const smokePath = options.env['AIO_STARTUP_SMOKE_USER_DATA_PATH'];
  if (options.isPackaged && options.env['AIO_STARTUP_SMOKE'] === '1' && smokePath) {
    if (!isAbsolute(smokePath)) {
      throw new Error('AIO_STARTUP_SMOKE_USER_DATA_PATH must be absolute');
    }
    return smokePath;
  }

  // Dev-only isolation escape hatch: without this, every unpackaged launch
  // collapses onto the same `<appData>/harness-dev` profile and fights over
  // the single-instance lock — passing Electron's own `--user-data-dir` CLI
  // switch does NOT help, because it is unconditionally overwritten below.
  // This lets concurrent dev-app instances (e.g. parallel livetest runners)
  // each get a real, isolated profile instead of silently colliding.
  const devOverride = options.env['AIO_DEV_USER_DATA_PATH'];
  if (!options.isPackaged && devOverride) {
    if (!isAbsolute(devOverride)) {
      throw new Error('AIO_DEV_USER_DATA_PATH must be absolute');
    }
    return devOverride;
  }

  return join(options.appDataPath, options.isPackaged ? 'harness' : 'harness-dev');
}
