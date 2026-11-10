import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LinuxServiceManager } from '../linux-service-manager';
import { MacosServiceManager } from '../macos-service-manager';
import { WindowsServiceManager } from '../windows-service-manager';
import * as execFileMod from '../exec-file';
import { ExecFileError } from '../exec-file';

// Service manager status parsing for the three platforms (merged from one file per manager).

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

  it('recognises a missing service from the exit code and stdout, as sc.exe reports it', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockRejectedValue(
      new ExecFileError(
        'sc.exe',
        ['queryex', 'ai-orchestrator-worker'],
        1060,
        null,
        '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n',
        '',
      ),
    );
    const mgr = new WindowsServiceManager();

    await expect(mgr.isInstalled()).resolves.toBe(false);
  });

  it('still surfaces other sc.exe failures', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockRejectedValue(
      new ExecFileError('sc.exe', ['queryex', 'ai-orchestrator-worker'], 5, null, '[SC] OpenSCManager FAILED 5:\r\n\r\nAccess is denied.\r\n', ''),
    );
    const mgr = new WindowsServiceManager();

    await expect(mgr.status()).rejects.toBeInstanceOf(ExecFileError);
  });
});
