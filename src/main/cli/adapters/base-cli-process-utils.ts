import { spawnSync } from 'child_process';

export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5000,
        windowsHide: true,
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }
      return result.status === 0;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
