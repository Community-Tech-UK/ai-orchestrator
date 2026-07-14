import { execFile } from 'node:child_process';

export const HARNESS_MACOS_BUNDLE_ID = 'com.ai.orchestrator';

type TccService = 'ScreenCapture' | 'Accessibility';

export interface MacosPermissionRepairResult {
  resetPermissions: ['screen-recording', 'accessibility'];
  relaunchRequired: true;
}

export interface MacosPermissionRepairOptions {
  platform?: NodeJS.Platform | string;
  isPackaged: boolean;
  runTccutil?: (service: TccService, bundleId: string) => Promise<void>;
}

const REPAIR_TARGETS: ReadonlyArray<{
  service: TccService;
  permission: MacosPermissionRepairResult['resetPermissions'][number];
}> = [
  { service: 'ScreenCapture', permission: 'screen-recording' },
  { service: 'Accessibility', permission: 'accessibility' },
];

/**
 * Clear only Harness's two Computer Use TCC decisions so the current signed
 * build can register itself again. This intentionally has no global-reset
 * mode and never accepts a renderer-supplied service or bundle identifier.
 */
export async function repairMacosComputerUsePermissions(
  options: MacosPermissionRepairOptions,
): Promise<MacosPermissionRepairResult> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('computer_use_permission_repair_unsupported');
  }
  if (!options.isPackaged) {
    throw new Error('computer_use_permission_repair_requires_packaged_app');
  }
  const runTccutil = options.runTccutil ?? defaultRunTccutil;
  try {
    for (const target of REPAIR_TARGETS) {
      await runTccutil(target.service, HARNESS_MACOS_BUNDLE_ID);
    }
  } catch {
    throw new Error('computer_use_permission_repair_failed');
  }
  return {
    resetPermissions: REPAIR_TARGETS.map((target) => target.permission) as [
      'screen-recording',
      'accessibility',
    ],
    relaunchRequired: true,
  };
}

function defaultRunTccutil(service: TccService, bundleId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/tccutil',
      ['reset', service, bundleId],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
      (error) => error ? reject(error) : resolve(),
    );
  });
}
