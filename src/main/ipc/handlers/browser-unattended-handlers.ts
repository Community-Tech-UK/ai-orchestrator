import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  BrowserVaultUnlockRequestSchema,
  BrowserCreateCredentialAuthorizationRequestSchema,
  BrowserListCredentialAuthorizationsRequestSchema,
  BrowserRevokeCredentialAuthorizationRequestSchema,
  BrowserCreateCampaignRequestSchema,
  BrowserListCampaignsRequestSchema,
  BrowserCampaignLookupRequestSchema,
  BrowserApproveCampaignDeclarationRequestSchema,
  BrowserListEscalationsRequestSchema,
  BrowserResolveEscalationRequestSchema,
} from '@contracts/schemas/browser-unattended';
import { validateIpcPayload } from '@contracts/schemas/common';
import type { IpcResponse } from '../validated-handler';
import {
  getBrowserCredentialAuthorizationService,
  getBrowserCampaignService,
  getBrowserEscalationService,
  getBrowserVaultStatus,
  lockBrowserCredentialVault,
  unlockBrowserCredentialVault,
} from '../../browser-gateway/browser-unattended-services';
import { generateId } from '../../../shared/utils/id-generator';

/**
 * Renderer IPC for the unattended browser-automation layer: vault
 * unlock/lock/status, credential authorizations, campaigns, and escalation
 * triage. These are the James-approved write surfaces the approval dialogs
 * call — deliberately NOT exposed as MCP tools (an agent must never approve
 * its own standing consent). No handler ever returns a secret: unlock returns
 * `{unlocked, reason?}` only and the BW_SESSION token never leaves the main
 * process.
 */

interface RegisterBrowserUnattendedHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

/** Standing consent is long-lived but not unbounded: cap at 1 year out. */
const MAX_AUTHORIZATION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export function registerBrowserUnattendedHandlers(
  deps: RegisterBrowserUnattendedHandlersDeps = {},
): void {
  register(
    IPC_CHANNELS.BROWSER_VAULT_UNLOCK,
    BrowserVaultUnlockRequestSchema,
    () => unlockBrowserCredentialVault(),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_VAULT_LOCK,
    BrowserVaultUnlockRequestSchema,
    () => {
      lockBrowserCredentialVault();
      return getBrowserVaultStatus();
    },
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_VAULT_STATUS,
    BrowserVaultUnlockRequestSchema,
    () => getBrowserVaultStatus(),
    deps,
  );

  register(
    IPC_CHANNELS.BROWSER_CREATE_CREDENTIAL_AUTHORIZATION,
    BrowserCreateCredentialAuthorizationRequestSchema,
    (payload) => {
      const now = Date.now();
      if (payload.expiresAt <= now) {
        throw new Error('Authorization expiry must be in the future');
      }
      if (payload.expiresAt > now + MAX_AUTHORIZATION_LIFETIME_MS) {
        throw new Error('Authorization expiry cannot be more than 1 year out');
      }
      return getBrowserCredentialAuthorizationService().create(
        {
          profileId: payload.profileId,
          allowedOrigins: payload.allowedOrigins,
          purposes: payload.purposes,
          vaultFolder: payload.vaultFolder,
          expiresAt: payload.expiresAt,
          ...(payload.note ? { note: payload.note } : {}),
        },
        generateId(),
      );
    },
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_LIST_CREDENTIAL_AUTHORIZATIONS,
    BrowserListCredentialAuthorizationsRequestSchema.optional().default({}),
    (payload) => getBrowserCredentialAuthorizationService().list(payload.profileId),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_REVOKE_CREDENTIAL_AUTHORIZATION,
    BrowserRevokeCredentialAuthorizationRequestSchema,
    (payload) => {
      getBrowserCredentialAuthorizationService().revoke(payload.authorizationId);
      return { revoked: true };
    },
    deps,
  );

  register(
    IPC_CHANNELS.BROWSER_CREATE_CAMPAIGN,
    BrowserCreateCampaignRequestSchema,
    (payload) => getBrowserCampaignService().create(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_LIST_CAMPAIGNS,
    BrowserListCampaignsRequestSchema.optional().default({}),
    (payload) => {
      const service = getBrowserCampaignService();
      return service
        .list(payload.status ? { status: payload.status } : {})
        .map((campaign) => ({
          campaign,
          counters: service.getCounters(campaign.id) ?? null,
        }));
    },
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_GET_CAMPAIGN,
    BrowserCampaignLookupRequestSchema,
    (payload) => {
      const service = getBrowserCampaignService();
      const campaign = service.get(payload.campaignId);
      if (!campaign) {
        throw new Error(`No campaign found with id '${payload.campaignId}'`);
      }
      return {
        campaign,
        counters: service.getCounters(campaign.id) ?? null,
        pendingEscalations: getBrowserEscalationService().pending(campaign.id),
      };
    },
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_PAUSE_CAMPAIGN,
    BrowserCampaignLookupRequestSchema,
    (payload) => getBrowserCampaignService().pause(payload.campaignId),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_RESUME_CAMPAIGN,
    BrowserCampaignLookupRequestSchema,
    (payload) => getBrowserCampaignService().resume(payload.campaignId),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_KILL_CAMPAIGN,
    BrowserCampaignLookupRequestSchema,
    (payload) => getBrowserCampaignService().kill(payload.campaignId),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_APPROVE_CAMPAIGN_DECLARATION,
    BrowserApproveCampaignDeclarationRequestSchema,
    (payload) => {
      getBrowserCampaignService().approveDeclarationHash(
        payload.campaignId,
        payload.declarationHash.toLowerCase(),
      );
      return { approved: true };
    },
    deps,
  );

  register(
    IPC_CHANNELS.BROWSER_LIST_ESCALATIONS,
    BrowserListEscalationsRequestSchema.optional().default({}),
    (payload) => getBrowserEscalationService().list(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_RESOLVE_ESCALATION,
    BrowserResolveEscalationRequestSchema,
    (payload) => getBrowserEscalationService().resolve(payload.escalationId, payload.note),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_SKIP_ESCALATION,
    BrowserResolveEscalationRequestSchema,
    (payload) => getBrowserEscalationService().skip(payload.escalationId, payload.note),
    deps,
  );
}

function register<TPayload>(
  channel: string,
  schema: z.ZodSchema<TPayload>,
  call: (payload: TPayload) => unknown | Promise<unknown>,
  deps: RegisterBrowserUnattendedHandlersDeps,
): void {
  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const trustError = deps.ensureTrustedSender?.(event, channel);
        if (trustError) {
          return trustError;
        }
        const validated = validateIpcPayload(schema, payload, channel);
        return {
          success: true,
          data: await call(validated),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'BROWSER_UNATTENDED_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
