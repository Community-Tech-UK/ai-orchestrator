import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  BrowserAccessibilitySnapshotRequestSchema,
  BrowserApprovalRequestLookupSchema,
  BrowserApprovalStatusRequestSchema,
  BrowserApproveRequestPayloadSchema,
  BrowserClickRequestSchema,
  BrowserEvaluateRequestSchema,
  BrowserCreateGrantRequestSchema,
  BrowserCreateProfileRequestSchema,
  BrowserDenyRequestPayloadSchema,
  BrowserDownloadFileRequestSchema,
  BrowserFillFormRequestSchema,
  BrowserListAuditLogRequestSchema,
  BrowserListApprovalRequestsRequestSchema,
  BrowserListGrantsRequestSchema,
  BrowserListTargetsRequestSchema,
  BrowserManualStepRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserProfileRequestSchema,
  BrowserRequestGrantRequestSchema,
  BrowserRequestUserLoginRequestSchema,
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
import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { IpcResponse } from '../validated-handler';
import { getBrowserGatewayService } from '../../browser-gateway/browser-gateway-service';
import type { InstanceManager } from '../../instance/instance-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('BrowserGatewayHandlers');

const EmptyPayloadSchema = z.object({}).strict().optional().default({});

type BrowserGatewayIpcPayload = Record<string, unknown>;

interface RegisterBrowserGatewayHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
  /**
   * Used to resume the originating agent turn after the user approves or denies
   * a Browser Gateway action in the renderer dialog. A browser tool call that
   * needs approval returns `requires_user` and ends the agent's turn; resolving
   * the approval only writes a grant, so without this nudge the idle agent never
   * retries. See {@link resumeInstanceAfterBrowserDecision}.
   */
  instanceManager?: InstanceManager;
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
    IPC_CHANNELS.BROWSER_DOWNLOAD_FILE,
    BrowserDownloadFileRequestSchema,
    (service, payload) => service.downloadFile(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_REQUEST_USER_LOGIN,
    BrowserRequestUserLoginRequestSchema,
    (service, payload) => service.requestUserLogin(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_PAUSE_FOR_MANUAL_STEP,
    BrowserManualStepRequestSchema,
    (service, payload) => service.pauseForManualStep(payload),
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
    async (service, payload) => {
      const result = await service.approveRequest(payload);
      resumeInstanceAfterBrowserDecision(deps.instanceManager, 'approved', result);
      return result;
    },
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_DENY_REQUEST,
    BrowserDenyRequestPayloadSchema,
    async (service, payload) => {
      const result = await service.denyRequest(payload);
      resumeInstanceAfterBrowserDecision(deps.instanceManager, 'denied', result);
      return result;
    },
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
    IPC_CHANNELS.BROWSER_ACCESSIBILITY_SNAPSHOT,
    BrowserAccessibilitySnapshotRequestSchema,
    (service, payload) => service.accessibilitySnapshot(payload),
    deps,
  );
  register(
    IPC_CHANNELS.BROWSER_EVALUATE,
    BrowserEvaluateRequestSchema,
    (service, payload) => service.evaluate(payload),
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

/**
 * Resume the originating agent turn after the user resolves a Browser Gateway
 * approval in the renderer dialog.
 *
 * A browser tool call that needs approval returns `requires_user` and the agent
 * ends its turn (there is nothing for it to do but wait). The user then clicks
 * Approve/Deny, which only writes a grant + resolves the request record — it
 * does not touch the now-idle CLI process. Without a nudge the agent never
 * retries, and the user has to manually type a message to wake it (the reported
 * bug). This delivers that nudge automatically.
 *
 * Intentionally scoped to the renderer IPC path: an agent that calls
 * `browser.approve_request` itself arrives via the RPC server, not this handler,
 * so it is naturally excluded. Failures are swallowed (logged only) — resuming
 * the turn must never fail the approval IPC response, and the grant is already
 * persisted regardless. Uses the user-typed `sendInput` path (no
 * `autoContinuation`) so it behaves exactly like the manual message it replaces,
 * rather than hard-blocking at high context.
 */
function resumeInstanceAfterBrowserDecision(
  instanceManager: InstanceManager | undefined,
  decision: 'approved' | 'denied',
  result: unknown,
): void {
  if (!instanceManager) {
    return;
  }

  const typed = result as BrowserGatewayResult<{ instanceId?: string } | null> | undefined;
  // Only resume when the decision actually took effect. Not-found / no-longer-
  // pending branches return `decision: 'denied'` with `outcome: 'not_run'`.
  if (!typed || typed.decision !== 'allowed' || typed.outcome !== 'succeeded') {
    return;
  }

  const instanceId = typed.data?.instanceId;
  if (!instanceId) {
    return;
  }

  const message =
    decision === 'approved'
      ? 'The browser action you requested was just approved by the user in the approval dialog. Retry the action now and continue.'
      : 'The browser action you requested was just denied by the user in the approval dialog. Do not retry it; continue without it.';

  void instanceManager.sendInput(instanceId, message).catch((error) => {
    logger.warn('Failed to resume instance after browser approval decision', {
      instanceId,
      decision,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
