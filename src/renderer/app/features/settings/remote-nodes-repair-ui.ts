import { servicePaths } from '../../../../shared/service/worker-service-paths';
import type { ServiceStatus } from '../../../../shared/types/service.types';
import type {
  NodePlatform,
  RemoteWorkerRepairDiagnostic,
} from '../../../../shared/types/worker-node.types';

export function shouldShowRepairDiagnostic(diagnostic: RemoteWorkerRepairDiagnostic | undefined): boolean {
  return Boolean(diagnostic && (diagnostic.status !== 'healthy' || diagnostic.lastRejectedRegistration));
}

export function repairActionLabel(action: RemoteWorkerRepairDiagnostic['recommendedAction']): string {
  switch (action) {
    case 'copy_windows_command':
      return 'Generate repair command';
    case 'choose_platform':
      return 'Choose platform';
    case 'check_connectivity':
      return 'Check service/network';
    case 'configure_tls':
      return 'Configure TLS first';
    case 're_pair':
      return 'Re-pair worker';
    default:
      return 'No action needed';
  }
}

export function formatServiceConfigStatus(
  status: ServiceStatus | null | undefined,
  platform: NodePlatform | undefined,
): string {
  if (!status) {
    return '';
  }
  if (!status.configPath) {
    return 'config path unavailable';
  }
  if (!platform) {
    return `config path reported: ${status.configPath}`;
  }
  const expected = servicePaths(platform).configFile;
  return status.configPath === expected
    ? `config path matches ${expected}`
    : `config path differs: ${status.configPath} (expected ${expected})`;
}
