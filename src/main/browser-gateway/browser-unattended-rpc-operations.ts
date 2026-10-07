import type { z } from 'zod';
import {
  BrowserRaiseEscalationRequestSchema,
  BrowserClaimCampaignLeaseRequestSchema,
  BrowserCampaignLookupRequestSchema,
  BrowserListCampaignsRequestSchema,
  BrowserCheckSessionRequestSchema,
  BrowserRememberLoginFingerprintRequestSchema,
  BrowserListLoginRecipesRequestSchema,
  BrowserForgetLoginRecipeRequestSchema,
} from '@contracts/schemas/browser-unattended';
import type { BrowserGatewayService } from './browser-gateway-service';
import {
  getBrowserCampaignService,
  getBrowserEscalationService,
  getBrowserLoginRecipeStore,
} from './browser-unattended-services';
import { getBrowserCampaignRuntime } from './browser-campaign-runtime';
import { checkSessionOperation } from './browser-session-relogin';
import { BrowserRequestCredentialAccessSchema, BrowserCredentialAccessLookupSchema } from '@contracts/schemas/browser';
import { getBrowserCredentialAccessService } from './browser-credential-access-service';

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
 *  - browser.list_login_recipes / browser.forget_login_recipe: inspect the
 *    persisted recipes (with the last check outcome) and drop a stale one.
 */

export const UNATTENDED_RPC_METHODS = [
  'browser.request_credential_access',
  'browser.get_credential_access_status',
  'browser.cancel_credential_access',
  'browser.raise_escalation',
  'browser.get_campaign',
  'browser.list_campaigns',
  'browser.pause_campaign',
  'browser.claim_campaign_lease',
  'browser.check_session',
  'browser.remember_login_fingerprint',
  'browser.list_login_recipes',
  'browser.forget_login_recipe',
] as const;

export type UnattendedRpcMethod = typeof UNATTENDED_RPC_METHODS[number];

const LOGIN_MARKER_GUIDANCE =
  'Pick session-wide markers that appear on every signed-in page, such as the account name or "Log out". Page-specific headings make re-login impossible.';

async function assertLoginMarkersOnLivePage(
  service: Partial<BrowserGatewayService>,
  request: { profileId: string; targetId: string; loggedInMarkers: readonly string[] },
): Promise<void> {
  if (typeof service.snapshot !== 'function') {
    throw new Error(`Cannot record login markers until the live page can be read. ${LOGIN_MARKER_GUIDANCE}`);
  }
  const snap = await service.snapshot({
    profileId: request.profileId,
    targetId: request.targetId,
    requireLive: true,
  });
  if (snap.decision !== 'allowed' || snap.outcome !== 'succeeded' || !snap.data) {
    throw new Error(
      `Cannot record login markers: the live page could not be read (${snap.reason ?? 'snapshot_unavailable'}). ${LOGIN_MARKER_GUIDANCE}`,
    );
  }
  if (snap.data.textUnavailableReason) {
    throw new Error(
      `Cannot record login markers: the live page could not be read (${snap.data.textUnavailableReason}). ${LOGIN_MARKER_GUIDANCE}`,
    );
  }
  const haystack = snap.data.text.toLowerCase();
  const missing = request.loggedInMarkers.filter((marker) => !haystack.includes(marker.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`Login markers are not on the live page (${missing.join(', ')}). ${LOGIN_MARKER_GUIDANCE}`);
  }
}

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
    case 'browser.request_credential_access':
      return getBrowserCredentialAccessService().request(parse(BrowserRequestCredentialAccessSchema, payload), { instanceId: context.instanceId, provider: context.provider });
    case 'browser.get_credential_access_status':
      return getBrowserCredentialAccessService().status(parse(BrowserCredentialAccessLookupSchema, payload).requestId, { instanceId: context.instanceId, provider: context.provider });
    case 'browser.cancel_credential_access':
      return getBrowserCredentialAccessService().cancel(parse(BrowserCredentialAccessLookupSchema, payload).requestId, { instanceId: context.instanceId, provider: context.provider });
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
      if (!request.targetId) {
        throw new Error(
          `browser.remember_login_fingerprint needs targetId for the page being viewed. ${LOGIN_MARKER_GUIDANCE}`,
        );
      }
      await assertLoginMarkersOnLivePage(context.service, {
        profileId: request.profileId,
        targetId: request.targetId,
        loggedInMarkers: request.loggedInMarkers,
      });
      const recipe = getBrowserLoginRecipeStore().remember({
        profileId: request.profileId,
        origin: request.origin,
        loginUrl: request.loginUrl,
        loggedInMarkers: request.loggedInMarkers,
        ...(request.relogin ? { relogin: request.relogin } : {}),
      });
      return {
        remembered: true,
        scope: recipe.scope,
        scopeKind: recipe.scopeKind,
        origin: recipe.origin,
        hasRelogin: recipe.relogin !== undefined,
      };
    }
    case 'browser.list_login_recipes': {
      const request = parse(BrowserListLoginRecipesRequestSchema.optional().default({}), payload);
      return getBrowserLoginRecipeStore().list({
        ...(request.profileId ? { profileId: request.profileId } : {}),
        ...(request.origin ? { origin: request.origin } : {}),
      });
    }
    case 'browser.forget_login_recipe': {
      const request = parse(BrowserForgetLoginRecipeRequestSchema, payload);
      return { forgotten: getBrowserLoginRecipeStore().forget(request.scope, request.origin) };
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
          fingerprints: getBrowserLoginRecipeStore(),
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
