import type { BrowserGatewayResult, BrowserPermissionGrant, BrowserApprovalRequest } from '@contracts/types/browser';
import { getBrowserGatewayService } from '../browser-gateway/browser-gateway-service';
import type { GatewayBrowserApprovalSource } from './mobile-gateway-browser-approval-handlers';

const PHONE_GRANT_MODES = new Set(['per_action', 'session']);

function applied(result: BrowserGatewayResult<BrowserPermissionGrant | BrowserApprovalRequest | null>): boolean {
  return result.decision === 'allowed' && result.outcome === 'succeeded';
}

export function createLiveBrowserApprovalSource(
  resume: (decision: 'approved' | 'denied', requestId: string, result: unknown) => void,
): GatewayBrowserApprovalSource {
  const service = getBrowserGatewayService();
  return {
    async listPending() {
      const result = await service.listApprovalRequests({ status: 'pending' });
      if (result.decision !== 'allowed' || !result.data) return [];
      return result.data.map((request) => ({
        id: request.id,
        requestId: request.requestId,
        instanceId: request.instanceId,
        toolName: request.toolName,
        action: request.action,
        actionClass: request.actionClass,
        origin: request.origin,
        url: request.url,
        createdAt: request.createdAt,
        status: request.status,
      }));
    },
    async approve(requestId) {
      const listed = await service.listApprovalRequests({ status: 'pending' });
      const request = listed.decision === 'allowed'
        ? listed.data?.find((item) => item.requestId === requestId)
        : undefined;
      if (!request) throw new Error('Browser approval not found');
      if (!PHONE_GRANT_MODES.has(request.proposedGrant.mode)) {
        throw new Error('Open this step on your Mac. The phone cannot approve it.');
      }
      const result = await service.approveRequest({ requestId, grant: request.proposedGrant });
      resume('approved', requestId, result);
      if (!applied(result)) throw new Error(result.reason || 'Browser approval was not applied');
    },
    async deny(requestId, reason) {
      const result = await service.denyRequest({ requestId, ...(reason ? { reason } : {}) });
      resume('denied', requestId, result);
      if (!applied(result)) throw new Error(result.reason || 'Browser denial was not applied');
    },
  };
}
