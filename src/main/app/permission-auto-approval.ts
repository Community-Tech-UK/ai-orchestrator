import type { PermissionRequest } from '../../shared/types/permission-registry.types';

interface AutoApprovalRegistry {
  on(event: 'permission:requested', listener: (request: PermissionRequest) => void): unknown;
  resolve(requestId: string, granted: boolean, decidedBy: 'auto_approve'): void;
}

export function shouldAutoApproveAcpPermissionRequest(
  request: PermissionRequest,
  yoloMode: boolean,
): boolean {
  return yoloMode && request.details?.['transport'] === 'acp';
}

export function registerAcpYoloAutoApproval(
  registry: AutoApprovalRegistry,
  isYoloMode: (instanceId: string) => boolean,
  onError?: (request: PermissionRequest, error: unknown) => void,
): void {
  registry.on('permission:requested', (request) => {
    try {
      if (shouldAutoApproveAcpPermissionRequest(request, isYoloMode(request.instanceId))) {
        registry.resolve(request.id, true, 'auto_approve');
      }
    } catch (error) {
      onError?.(request, error);
    }
  });
}
