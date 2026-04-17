import { describe, it, expect, vi } from 'vitest';
import { LinuxServiceManager } from '../linux-service-manager';
import * as execFileMod from '../exec-file';

describe('LinuxServiceManager', () => {
  it('status parses systemctl show output', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout: 'ActiveState=active\nMainPID=1234\nExecMainStartTimestamp=Fri 2026-04-16 12:00:00 UTC\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new LinuxServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('running');
    expect(s.pid).toBe(1234);
  });

  it('status returns not-installed when unit-file is not-found', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout: 'LoadState=not-found\nActiveState=inactive\nMainPID=0\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new LinuxServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('not-installed');
  });
});
