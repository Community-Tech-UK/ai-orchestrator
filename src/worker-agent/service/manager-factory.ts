import type { ServiceManager } from './types';

export async function createServiceManager(
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceManager> {
  switch (platform) {
    case 'win32': {
      const { WindowsServiceManager } = await import('./windows-service-manager');
      return new WindowsServiceManager();
    }
    case 'linux': {
      const { LinuxServiceManager } = await import('./linux-service-manager');
      return new LinuxServiceManager();
    }
    case 'darwin': {
      const { MacosServiceManager } = await import('./macos-service-manager');
      return new MacosServiceManager();
    }
    default:
      throw new Error(`Service install is not supported on ${platform}`);
  }
}
