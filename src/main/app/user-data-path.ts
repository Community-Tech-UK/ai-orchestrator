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
  return join(options.appDataPath, options.isPackaged ? 'harness' : 'harness-dev');
}
