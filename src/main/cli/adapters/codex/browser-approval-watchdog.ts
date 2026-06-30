import { getBrowserApprovalStore } from '../../../browser-gateway/browser-approval-store';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CodexBrowserApprovalWatchdog');

export function hasPendingBrowserApproval(instanceId: string | undefined): boolean {
  if (!instanceId) {
    return false;
  }

  try {
    const now = Date.now();
    return getBrowserApprovalStore()
      .listRequests({ instanceId, status: 'pending', limit: 5 })
      .some((approval) => approval.status === 'pending' && approval.expiresAt > now);
  } catch (error) {
    logger.debug('Failed to inspect pending browser approvals for Codex watchdog', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
