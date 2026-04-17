import { describe, it, expect, vi } from 'vitest';
import { MacosServiceManager } from '../macos-service-manager';
import * as execFileMod from '../exec-file';
import { ExecFileError } from '../exec-file';

describe('MacosServiceManager', () => {
  it('status parses launchctl print output', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout: 'state = running\npid = 9876\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new MacosServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('running');
    expect(s.pid).toBe(9876);
  });

  it('status returns not-installed when launchctl reports Could not find service', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockRejectedValue(
      new ExecFileError('launchctl', ['print', 'system/com.aiorchestrator.worker'], 113, null, '', 'Could not find service'),
    );
    const mgr = new MacosServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('not-installed');
  });
});
