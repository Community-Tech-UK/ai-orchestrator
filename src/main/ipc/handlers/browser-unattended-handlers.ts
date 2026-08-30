import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  BrowserVaultUnlockRequestSchema,
  BrowserEnrolCredentialRequestSchema,
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
  getBrowserCredentialVault,
  getBrowserCampaignService,
  getBrowserEscalationService,
  getBrowserVaultStatus,
  lockBrowserCredentialVault,
  unlockBrowserCredentialVault,
} from '../../browser-gateway/browser-unattended-services';
import { generateId } from '../../../shared/utils/id-generator';
import { assertAuthorizationExpiry } from '../../browser-gateway/browser-credential-authorization-store';
import {
  normaliseAuthorizationOrigin,
  normaliseBindableOrigin,
} from '../../browser-gateway/browser-credential-origin';
import {
  resolveCredentialScope,
  resolveCredentialScopeForFilter,
} from '../../browser-gateway/default-browser-credentials-operations';

/**
 * Renderer IPC for the unattended browser-automation layer: vault
 * unlock/lock/status, credential authorizations, campaigns, and escalation
 * triage. These are the approval-dialog write surfaces. None is exposed as an
 * MCP tool.
 *
 * 2026-08-29: credential enrolment and authorization are no longer renderer-
 * only. On the operator's instruction they also have a privileged CLI door
 * (`aio-mcp browser-credentials`), so an agent CAN now create its own standing
 * consent. Both doors share these services, the origin rules
 * (`browser-credential-origin.ts`) and the expiry cap, so neither can grant
 * what the other refuses. No handler ever returns a secret: unlock returns
 * `{unlocked, reason?}` only and the BW_SESSION token never leaves the main
 * process.
 */

interface RegisterBrowserUnattendedHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}


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

  // Bind an existing login (an account James registered by hand) to an origin.
  // Without this, only agent-created accounts could ever be filled, because
  // createAgentCredential was the sole writer of vault origin bindings. Returns
  // a reference + username only; the password is never read here.
  register(
    IPC_CHANNELS.BROWSER_ENROL_CREDENTIAL,
    BrowserEnrolCredentialRequestSchema,
    (payload) =>
      getBrowserCredentialVault().enrolExistingCredential({
        item: payload.item,
        origin: normaliseBindableOrigin(payload.origin),
        ...(payload.moveIntoFolder !== undefined
          ? { moveIntoFolder: payload.moveIntoFolder }
          : {}),
      }),
    deps,
  );

  register(
    IPC_CHANNELS.BROWSER_CREATE_CREDENTIAL_AUTHORIZATION,
    BrowserCreateCredentialAuthorizationRequestSchema,
    (payload) => {
      // Same scope and origin rules as the CLI door. The autonomy-config
      // bootstrap shares both, but sets its own lifetime in days rather than
      // using the expiry cap below.
      const profileId = resolveCredentialScope(payload.profileId);
      const allowedOrigins = payload.allowedOrigins.map(normaliseAuthorizationOrigin);
      assertAuthorizationExpiry(payload.expiresAt, Date.now());
      return getBrowserCredentialAuthorizationService().create(
        {
          profileId,
          allowedOrigins,
          purposes: payload.purposes,
          vaultFolder: payload.vaultFolder,
          expiresAt: payload.expiresAt,
          ...(payload.note ? { note: payload.note } : {}),
          ...(payload.allowedSenderDomains && payload.allowedSenderDomains.length > 0
            ? { allowedSenderDomains: payload.allowedSenderDomains }
            : {}),
        },
        generateId(),
      );
    },
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_LIST_CREDENTIAL_AUTHORIZATIONS,
    BrowserListCredentialAuthorizationsRequestSchema.optional().default({}),
    (payload) => getBrowserCredentialAuthorizationService().list(
      payload.profileId === undefined
        ? undefined
        : resolveCredentialScopeForFilter(payload.profileId),
    ),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_REVOKE_CREDENTIAL_AUTHORIZATION,
    BrowserRevokeCredentialAuthorizationRequestSchema,
    (payload) => {
      // Same semantics as the CLI door: a no-op UPDATE must not report success.
      const service = getBrowserCredentialAuthorizationService();
      const record = service.find(payload.authorizationId);
      if (!record) {
        return { revoked: false };
      }
      if (!record.revokedAt) {
        service.revoke(payload.authorizationId);
      }
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
