import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WindowsServiceManager } from '../windows-service-manager';
import { ExecFileError } from '../exec-file';
import * as execFileMod from '../exec-file';

describe('WindowsServiceManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('status parses sc.exe query output', async () => {
    const spy = vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout:
        'SERVICE_NAME: ai-orchestrator-worker\r\n' +
        '        TYPE               : 10  WIN32_OWN_PROCESS\r\n' +
        '        STATE              : 4  RUNNING\r\n' +
        '        PID                : 4321\r\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new WindowsServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('running');
    expect(s.pid).toBe(4321);
    expect(spy).toHaveBeenCalledWith('sc.exe', expect.arrayContaining(['queryex']));
  });

  it('status returns not-installed when sc.exe says service does not exist', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockRejectedValue(
      new ExecFileError('sc.exe', ['queryex', 'ai-orchestrator-worker'], 1060, null, '', 'FAILED 1060'),
    );
    const mgr = new WindowsServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('not-installed');
  });
});
