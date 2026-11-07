import { servicePaths } from '../../../../shared/service/worker-service-paths';
import type { ServiceStatus } from '../../../../shared/types/service.types';
import type {
  HostReadinessCheck,
  NodePlatform,
  RemoteWorkerRepairDiagnostic,
} from '../../../../shared/types/worker-node.types';

/** Connection trouble: the node is not healthy, or it was turned away recently. */
export function hasConnectionIssue(diagnostic: RemoteWorkerRepairDiagnostic): boolean {
  return diagnostic.status !== 'healthy' || Boolean(diagnostic.lastRejectedRegistration);
}

/** Host checks the computer reported as problems, in the order it reported them. */
export function hostReadinessProblems(diagnostic: RemoteWorkerRepairDiagnostic | undefined): HostReadinessCheck[] {
  return diagnostic?.hostReadiness?.checks.filter((check) => check.status === 'problem') ?? [];
}

export function shouldShowRepairDiagnostic(diagnostic: RemoteWorkerRepairDiagnostic | undefined): boolean {
  return Boolean(diagnostic && (hasConnectionIssue(diagnostic) || hostReadinessProblems(diagnostic).length > 0));
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
