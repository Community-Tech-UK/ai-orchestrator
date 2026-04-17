import { execFileCapture } from './exec-file';

export async function isElevated(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      // `net session` only works for administrators.
      await execFileCapture('net', ['session'], { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  }
  // Linux / macOS: euid === 0 means root.
  const getuid = (process as unknown as { geteuid?: () => number }).geteuid;
  return typeof getuid === 'function' && getuid() === 0;
}

export class NotElevatedError extends Error {
  override name = 'NotElevatedError';
  constructor(action: string) {
    super(
      `${action} requires elevated privileges. ` +
        (process.platform === 'win32'
          ? 'Re-run from an administrator terminal.'
          : 'Re-run with sudo.'),
    );
  }
}
