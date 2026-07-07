import type { z } from 'zod';
import {
  BrowserRaiseEscalationRequestSchema,
  BrowserClaimCampaignLeaseRequestSchema,
  BrowserCampaignLookupRequestSchema,
  BrowserListCampaignsRequestSchema,
  BrowserCheckSessionRequestSchema,
  BrowserRememberLoginFingerprintRequestSchema,
} from '@contracts/schemas/browser-unattended';
import type { BrowserGatewayService } from './browser-gateway-service';
import {
  getBrowserCampaignService,
  getBrowserEscalationService,
} from './browser-unattended-services';
import { getBrowserCampaignRuntime } from './browser-campaign-runtime';
import {
  checkSessionOperation,
  getLoginFingerprintStore,
} from './browser-session-relogin';

/**
 * Agent-facing (MCP) runtime surfaces for the unattended layer, dispatched by
 * the Browser Gateway RPC server before the per-tool service switch:
 *
 *  - browser.raise_escalation — park a hard stop, keep going.
 *  - browser.get_campaign / browser.list_campaigns — read the standing
 *    authority + live budget counters.
 *  - browser.pause_campaign — the agent-side tripwire. (kill/resume/create
 *    remain user-only via renderer IPC.)
 *  - browser.claim_campaign_lease — obtain/renew this instance's ~60min grant
 *    inside a user-approved, in-budget campaign.
 *  - browser.check_session / browser.remember_login_fingerprint — session
 *    sentinel: record a login fingerprint, evaluate + bounded auto re-login.
 */

export const UNATTENDED_RPC_METHODS = [
  'browser.raise_escalation',
  'browser.get_campaign',
  'browser.list_campaigns',
  'browser.pause_campaign',
  'browser.claim_campaign_lease',
  'browser.check_session',
  'browser.remember_login_fingerprint',
] as const;

export type UnattendedRpcMethod = typeof UNATTENDED_RPC_METHODS[number];

export function isUnattendedRpcMethod(method: string): method is UnattendedRpcMethod {
  return (UNATTENDED_RPC_METHODS as readonly string[]).includes(method);
}

export interface UnattendedRpcContext {
  instanceId: string;
  provider?: string;
  service: Partial<BrowserGatewayService>;
}

export async function handleUnattendedRpcMethod(
  method: UnattendedRpcMethod,
  payload: Record<string, unknown>,
  context: UnattendedRpcContext,
): Promise<unknown> {
  switch (method) {
    case 'browser.raise_escalation': {
      const request = parse(BrowserRaiseEscalationRequestSchema, payload);
      // Always recordable — the caller parks this site and moves on.
      return getBrowserEscalationService().raise(request);
    }
    case 'browser.get_campaign': {
      const request = parse(BrowserCampaignLookupRequestSchema, payload);
      const campaigns = getBrowserCampaignService();
      const campaign = campaigns.get(request.campaignId);
      if (!campaign) {
        throw new Error(`No campaign found with id '${request.campaignId}'`);
      }
      return {
        campaign,
        counters: campaigns.getCounters(campaign.id) ?? null,
        canProceed: campaigns.canProceed(campaign.id),
        pendingEscalations: getBrowserEscalationService().pending(campaign.id),
      };
    }
    case 'browser.list_campaigns': {
      const request = parse(BrowserListCampaignsRequestSchema.optional().default({}), payload);
      const campaigns = getBrowserCampaignService();
      return campaigns
        .list(request.status ? { status: request.status } : {})
        .map((campaign) => ({
          campaign,
          counters: campaigns.getCounters(campaign.id) ?? null,
        }));
    }
    case 'browser.pause_campaign': {
      const request = parse(BrowserCampaignLookupRequestSchema, payload);
      // The tripwire: pausing also revokes live child grants via the campaign
      // service's onStateChange hook. Resume is user-only.
      return getBrowserCampaignService().pause(request.campaignId);
    }
    case 'browser.claim_campaign_lease': {
      const request = parse(BrowserClaimCampaignLeaseRequestSchema, payload);
      const runtime = getBrowserCampaignRuntime();
      if (!runtime) {
        return { granted: false, reason: 'campaign_runtime_unavailable' };
      }
      const result = runtime.claimLease({
        campaignId: request.campaignId,
        instanceId: context.instanceId,
        ...(context.provider ? { provider: context.provider } : {}),
      });
      // Return only grant metadata the agent needs — not the full record.
      return result.granted
        ? {
            granted: true,
            grantId: result.grant.id,
            expiresAt: result.grant.expiresAt,
            renewed: result.renewed,
          }
        : result;
    }
    case 'browser.remember_login_fingerprint': {
      const request = parse(BrowserRememberLoginFingerprintRequestSchema, payload);
      getLoginFingerprintStore().remember({
        profileId: request.profileId,
        origin: new URL(request.origin).origin,
        loginUrl: request.loginUrl,
        loggedInMarkers: request.loggedInMarkers,
        ...(request.relogin ? { relogin: request.relogin } : {}),
      });
      return { remembered: true };
    }
    case 'browser.check_session': {
      const request = parse(BrowserCheckSessionRequestSchema, payload);
      const service = context.service;
      const required = ['snapshot', 'queryElements', 'navigate', 'fillCredential', 'click'] as const;
      for (const name of required) {
        if (typeof service[name] !== 'function') {
          throw new Error(`Browser Gateway service method unavailable: ${name}`);
        }
      }
      return checkSessionOperation(
        {
          fingerprints: getLoginFingerprintStore(),
          escalations: getBrowserEscalationService(),
          snapshot: (req) => service.snapshot!(req),
          queryElements: (req) => service.queryElements!(req),
          navigate: (req) => service.navigate!(req),
          fillCredential: (req) => service.fillCredential!(req),
          click: (req) => service.click!(req),
        },
        {
          ...request,
          instanceId: context.instanceId,
          ...(context.provider ? { provider: context.provider } : {}),
        },
      );
    }
  }
}

function parse<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error('Invalid browser gateway RPC payload');
  }
  return result.data;
}
