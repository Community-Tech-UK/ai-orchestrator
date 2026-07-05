import type { NodePlatform } from '../../../shared/types/worker-node.types';

export function formatRemoteNodePlatformLabel(platform: NodePlatform | undefined): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return 'Unknown';
  }
}
