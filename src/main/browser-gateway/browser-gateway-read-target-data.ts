import type {
  BrowserGatewayResult,
  BrowserTarget,
} from '@contracts/types/browser';
import type { BrowserProfileStore } from './browser-profile-store';
import { isOriginAllowed } from './browser-origin-policy';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayTargetRequest } from './browser-gateway-service-types';

export async function readBrowserTargetData<T>(params: {
  request: BrowserGatewayTargetRequest;
  action: string;
  toolName: string;
  label: string;
  profileStore: Pick<BrowserProfileStore, 'getProfile'>;
  getLiveTarget: (profileId: string, targetId: string) => Promise<{ target: BrowserTarget | null; error?: string }>;
  result: <R>(input: BrowserGatewayResultInput<R>) => BrowserGatewayResult<R>;
  read: (profileId: string, targetId: string) => Promise<T>;
}): Promise<BrowserGatewayResult<T | null>> {
  const profile = params.profileStore.getProfile(params.request.profileId);
  const { target, error } = profile
    ? await params.getLiveTarget(params.request.profileId, params.request.targetId)
    : { target: null, error: undefined };
  const currentUrl = target?.url;
  if (!profile || !target || !currentUrl) {
    return params.result({
      context: params.request,
      profileId: params.request.profileId,
      targetId: params.request.targetId,
      action: params.action,
      toolName: params.toolName,
      actionClass: 'read',
      decision: 'denied',
      outcome: 'not_run',
      reason: error ?? 'profile_target_or_url_not_found',
      summary: error
        ? `${params.label} denied because the live browser target could not be refreshed: ${error}`
        : `${params.label} denied because the profile, target, or URL was not found`,
      data: null,
    });
  }

  const originDecision = isOriginAllowed(currentUrl, profile.allowedOrigins);
  if (!originDecision.allowed) {
    return params.result({
      context: params.request,
      profileId: profile.id,
      targetId: target.id,
      action: params.action,
      toolName: params.toolName,
      actionClass: 'read',
      decision: 'denied',
      outcome: 'not_run',
      reason: originDecision.reason,
      summary: `${params.label} denied by Browser Gateway origin policy: ${originDecision.reason}`,
      url: currentUrl,
      data: null,
    });
  }

  try {
    const data = await params.read(profile.id, target.id);
    return params.result({
      context: params.request,
      profileId: profile.id,
      targetId: target.id,
      action: params.action,
      toolName: params.toolName,
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Read ${params.label} from allowed origin`,
      origin: originDecision.origin,
      url: currentUrl,
      data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return params.result({
      context: params.request,
      profileId: profile.id,
      targetId: target.id,
      action: params.action,
      toolName: params.toolName,
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'failed',
      reason: message,
      summary: `${params.label} failed: ${message}`,
      origin: originDecision.origin,
      url: currentUrl,
      data: null,
    });
  }
}
