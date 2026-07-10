import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  DesktopAuditLogRequestSchema,
  DesktopListGrantsRequestSchema,
  DesktopRevokeGrantRequestSchema,
} from '../../../shared/validation/desktop-gateway-schemas';
import type { DesktopGatewayContext } from '../../../shared/types/desktop-gateway.types';
import type { IpcResponse } from '../validated-handler';
import { getDesktopGatewayService } from '../../desktop-gateway/desktop-gateway-service';
import { getLogger } from '../../logging/logger';

const logger = getLogger('DesktopGatewayHandlers');

const EmptyPayloadSchema = z.object({}).strict().optional().default({});

const OpenPermissionSettingsSchema = z.object({
  permission: z.enum(['screen-recording', 'accessibility']),
}).strict();

/**
 * Renderer/operator context for Settings-tab IPC calls. Not a real agent
 * instance; combined with the service's operator-scoped methods it audits under
 * a stable synthetic id and can view/manage grants across every instance.
 */
const OPERATOR_CONTEXT: DesktopGatewayContext = { instanceId: 'operator' };

const MACOS_PRIVACY_URLS: Record<'screen-recording' | 'accessibility', string> = {
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

interface RegisterDesktopGatewayHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerDesktopGatewayHandlers(
  deps: RegisterDesktopGatewayHandlersDeps = {},
): void {
  register(
    IPC_CHANNELS.DESKTOP_GET_HEALTH,
    EmptyPayloadSchema,
    (service) => service.health(OPERATOR_CONTEXT),
    deps,
  );
  register(
    IPC_CHANNELS.DESKTOP_LIST_APPS,
    EmptyPayloadSchema,
    (service) => service.listApps(OPERATOR_CONTEXT),
    deps,
  );
  register(
    IPC_CHANNELS.DESKTOP_LIST_GRANTS,
    DesktopListGrantsRequestSchema.optional().default({}),
    (service, payload) => service.listGrantsForOperator(payload),
    deps,
  );
  register(
    IPC_CHANNELS.DESKTOP_REVOKE_GRANT,
    DesktopRevokeGrantRequestSchema,
    (service, payload) => service.revokeGrantForOperator(payload),
    deps,
  );
  register(
    IPC_CHANNELS.DESKTOP_GET_AUDIT_LOG,
    DesktopAuditLogRequestSchema.optional().default({}),
    (service, payload) => service.getAuditLogForOperator(payload),
    deps,
  );
  register(
    IPC_CHANNELS.DESKTOP_OPEN_PERMISSION_SETTINGS,
    OpenPermissionSettingsSchema,
    async (_service, payload) => {
      const url = MACOS_PRIVACY_URLS[payload.permission];
      await shell.openExternal(url);
      return { opened: true, permission: payload.permission };
    },
    deps,
  );
}

function register<TPayload>(
  channel: string,
  schema: z.ZodSchema<TPayload>,
  call: (
    service: ReturnType<typeof getDesktopGatewayService>,
    payload: TPayload,
  ) => Promise<unknown>,
  deps: RegisterDesktopGatewayHandlersDeps,
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
          data: await call(getDesktopGatewayService(), validated),
        };
      } catch (error) {
        logger.warn('Desktop gateway IPC failed', {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: {
            code: 'DESKTOP_GATEWAY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
