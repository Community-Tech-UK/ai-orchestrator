import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { BrowserGatewayActionGuardOptions, BrowserGatewayPreparedMutation } from './browser-gateway-action-guard.types';

/** Audit and public result shared by successful and failed granted mutations. */
export function browserMutationResult(
  result: BrowserGatewayActionGuardOptions['result'],
  request: BrowserGatewayContext & { profileId: string; targetId: string },
  action: string,
  toolName: string,
  prepared: BrowserGatewayPreparedMutation,
  completion: { outcome: 'succeeded' } | { outcome: 'failed'; reason: string },
): BrowserGatewayResult<null> {
  return result({
    context: request,
    profileId: request.profileId,
    targetId: request.targetId,
    action,
    toolName,
    actionClass: prepared.actionClass,
    decision: 'allowed',
    outcome: completion.outcome,
    ...(completion.outcome === 'failed' ? { reason: completion.reason } : {}),
    summary: completion.outcome === 'failed'
      ? `${toolName} failed: ${completion.reason}`
      : `${toolName} executed under approved grant`,
    origin: prepared.origin,
    url: prepared.url,
    grantId: prepared.grant.id,
    autonomous: prepared.grant.autonomous,
    data: null,
  });
}
