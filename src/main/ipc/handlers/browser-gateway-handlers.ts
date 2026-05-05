import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  BrowserApprovalRequestLookupSchema,
  BrowserApprovalStatusRequestSchema,
  BrowserApproveRequestPayloadSchema,
  BrowserClickRequestSchema,
  BrowserCreateGrantRequestSchema,
  BrowserCreateProfileRequestSchema,
  BrowserDenyRequestPayloadSchema,
  BrowserFillFormRequestSchema,
  BrowserListAuditLogRequestSchema,
  BrowserListApprovalRequestsRequestSchema,
  BrowserListGrantsRequestSchema,
  BrowserListTargetsRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserProfileRequestSchema,
  BrowserRequestGrantRequestSchema,
  BrowserRevokeGrantRequestSchema,
  BrowserScreenshotRequestSchema,
  BrowserSelectRequestSchema,
  BrowserTargetRequestSchema,
  BrowserTypeRequestSchema,
  BrowserUpdateProfilePayloadSchema,
  BrowserUploadFileRequestSchema,
  BrowserWaitForRequestSchema,
} from '@contracts/schemas/browser';
import { validateIpcPayload } from '@contracts/schemas/common';
import type { IpcResponse } from '../validated-handler';
import { getBrowserGatewayService } from '../../browser-gateway/browser-gateway-service';

const EmptyPayloadSchema = z.object({}).strict().optional().default({});

type BrowserGatewayIpcPayload = Record<string, unknown>;

interface RegisterBrowserGatewayHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerBrowserGatewayHandlers(
  deps: RegisterBrowserGatewayHandlersDeps = {},
): void {
  register(
    IPC_CHANNELS.BROWSER_LIST_PROFILES,
    EmptyPayloadSchema,
    (service, payload) => service.listProfiles(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_CREATE_PROFILE,
    BrowserCreateProfileRequestSchema,
    (service, payload) => service.createProfile(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_UPDATE_PROFILE,
    BrowserUpdateProfilePayloadSchema,
    (service, payload) => service.updateProfile(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_DELETE_PROFILE,
    BrowserProfileRequestSchema,
    (service, payload) => service.deleteProfile(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_OPEN_PROFILE,
    BrowserProfileRequestSchema,
    (service, payload) => service.openProfile(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_CLOSE_PROFILE,
    BrowserProfileRequestSchema,
    (service, payload) => service.closeProfile(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_LIST_TARGETS,
    BrowserListTargetsRequestSchema.optional().default({}),
    (service, payload) => service.listTargets(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_SELECT_TARGET,
    BrowserTargetRequestSchema,
    (service, payload) => service.selectTarget(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_REFRESH_EXISTING_TAB,
    BrowserTargetRequestSchema,
    (service, payload) => service.refreshExistingTab(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_NAVIGATE,
    BrowserNavigateRequestSchema,
    (service, payload) => service.navigate(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_CLICK,
    BrowserClickRequestSchema,
    (service, payload) => service.click(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_TYPE,
    BrowserTypeRequestSchema,
    (service, payload) => service.type(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_FILL_FORM,
    BrowserFillFormRequestSchema,
    (service, payload) => service.fillForm(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_SELECT,
    BrowserSelectRequestSchema,
    (service, payload) => service.select(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_UPLOAD_FILE,
    BrowserUploadFileRequestSchema,
    (service, payload) => service.uploadFile(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_REQUEST_GRANT,
    BrowserRequestGrantRequestSchema,
    (service, payload) => service.requestGrant(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_GET_APPROVAL_STATUS,
    BrowserApprovalStatusRequestSchema,
    (service, payload) => service.getApprovalStatus(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_LIST_APPROVAL_REQUESTS,
    BrowserListApprovalRequestsRequestSchema.optional().default({}),
    (service, payload) => service.listApprovalRequests(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_GET_APPROVAL_REQUEST,
    BrowserApprovalRequestLookupSchema,
    (service, payload) => service.getApprovalRequest(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_APPROVE_REQUEST,
    BrowserApproveRequestPayloadSchema,
    (service, payload) => service.approveRequest(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_DENY_REQUEST,
    BrowserDenyRequestPayloadSchema,
    (service, payload) => service.denyRequest(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_CREATE_GRANT,
    BrowserCreateGrantRequestSchema,
    (service, payload) => service.createGrant(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_LIST_GRANTS,
    BrowserListGrantsRequestSchema.optional().default({}),
    (service, payload) => service.listGrants(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_REVOKE_GRANT,
    BrowserRevokeGrantRequestSchema,
    (service, payload) => service.revokeGrant(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_SNAPSHOT,
    BrowserTargetRequestSchema,
    (service, payload) => service.snapshot(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_SCREENSHOT,
    BrowserScreenshotRequestSchema,
    (service, payload) => service.screenshot(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_CONSOLE_MESSAGES,
    BrowserTargetRequestSchema,
    (service, payload) => service.consoleMessages(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_NETWORK_REQUESTS,
    BrowserTargetRequestSchema,
    (service, payload) => service.networkRequests(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_WAIT_FOR,
    BrowserWaitForRequestSchema,
    (service, payload) => service.waitFor(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_GET_AUDIT_LOG,
    BrowserListAuditLogRequestSchema.optional().default({}),
    (service, payload) => service.getAuditLog(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_GET_HEALTH,
    EmptyPayloadSchema,
    (service, payload) => service.getHealth(payload),
    deps,
  );
}

function register<TPayload extends BrowserGatewayIpcPayload>(
  channel: string,
  schema: z.ZodSchema<TPayload>,
  call: (
    service: ReturnType<typeof getBrowserGatewayService>,
    payload: TPayload,
  ) => Promise<unknown>,
  deps: RegisterBrowserGatewayHandlersDeps,
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
          data: await call(getBrowserGatewayService(), validated),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'BROWSER_GATEWAY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
