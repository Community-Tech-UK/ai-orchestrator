import { describe, expect, it, vi } from 'vitest';
import { repairMacosComputerUsePermissions } from './macos-permission-repair';

describe('repairMacosComputerUsePermissions', () => {
  it('resets only Harness Screen Recording and Accessibility registrations', async () => {
    const runTccutil = vi.fn(async () => undefined);

    await expect(repairMacosComputerUsePermissions({
      platform: 'darwin',
      isPackaged: true,
      runTccutil,
    })).resolves.toEqual({
      resetPermissions: ['screen-recording', 'accessibility'],
      relaunchRequired: true,
    });

    expect(runTccutil).toHaveBeenNthCalledWith(
      1,
      'ScreenCapture',
      'com.ai.orchestrator',
    );
    expect(runTccutil).toHaveBeenNthCalledWith(
      2,
      'Accessibility',
      'com.ai.orchestrator',
    );
    expect(runTccutil).toHaveBeenCalledTimes(2);
  });

  it('refuses to run outside a packaged macOS app', async () => {
    const runTccutil = vi.fn(async () => undefined);

    await expect(repairMacosComputerUsePermissions({
      platform: 'darwin',
      isPackaged: false,
      runTccutil,
    })).rejects.toThrow('computer_use_permission_repair_requires_packaged_app');
    await expect(repairMacosComputerUsePermissions({
      platform: 'win32',
      isPackaged: true,
      runTccutil,
    })).rejects.toThrow('computer_use_permission_repair_unsupported');

    expect(runTccutil).not.toHaveBeenCalled();
  });

  it('fails closed without attempting later resets when tccutil rejects a target', async () => {
    const runTccutil = vi.fn(async (service: string) => {
      if (service === 'ScreenCapture') {
        throw new Error('raw operating-system detail');
      }
    });

    await expect(repairMacosComputerUsePermissions({
      platform: 'darwin',
      isPackaged: true,
      runTccutil,
    })).rejects.toThrow('computer_use_permission_repair_failed');

    expect(runTccutil).toHaveBeenCalledTimes(1);
  });
});
