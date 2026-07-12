import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  DesktopAuditLogRequestSchema,
  DesktopListGrantsRequestSchema,
  DesktopRevokeGrantRequestSchema,
} from '../../../shared/validation/desktop-gateway-schemas';
import type {
  DesktopGatewayContext,
  DesktopGatewayResult,
  DesktopPermissionActionResult,
  DesktopPermissionRequestResult,
  DesktopSystemPermission,
} from '../../../shared/types/desktop-gateway.types';
import type { IpcResponse } from '../validated-handler';
import { getDesktopGatewayService } from '../../desktop-gateway/desktop-gateway-service';
import { getLogger } from '../../logging/logger';

const logger = getLogger('DesktopGatewayHandlers');

const EmptyPayloadSchema = z.object({}).strict().optional().default({});

const RequestSystemPermissionSchema = z.object({
  permission: z.enum(['screen-recording', 'accessibility']),
}).strict();

/**
 * Renderer/operator context for Settings-tab IPC calls. Not a real agent
 * instance; combined with the service's operator-scoped methods it audits under
 * a stable synthetic id and can view/manage grants across every instance.
 */
const OPERATOR_CONTEXT: DesktopGatewayContext = { instanceId: 'operator' };

/**
 * Main-process-owned System Settings URL candidates per permission: the exact
 * pane first (best effort — not a stable Apple contract), then the Privacy &
 * Security root as fallback. The renderer can never supply a URL.
 */
const MACOS_PRIVACY_URL_CANDIDATES: Record<DesktopSystemPermission, string[]> = {
  'screen-recording': [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    'x-apple.systempreferences:com.apple.preference.security',
  ],
  accessibility: [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.preference.security',
  ],
};

interface RegisterDesktopGatewayHandlersDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
  /** Injectable `shell.openExternal` seam for tests. */
  openExternal?: (url: string) => Promise<void>;
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
    IPC_CHANNELS.DESKTOP_REQUEST_SYSTEM_PERMISSION,
    RequestSystemPermissionSchema,
    async (service, payload) =>
      requestSystemPermissionAndOpenSettings(service, payload.permission, deps),
    deps,
  );
}

/**
 * Operator flow: perform the real native permission request through the
 * service/driver, then — only when the permission is still actionable — open
 * the exact System Settings pane with a Privacy & Security root fallback. The
 * native result is preserved even when navigation fails so the renderer can
 * distinguish permission state from settings-launch state.
 */
async function requestSystemPermissionAndOpenSettings(
  service: ReturnType<typeof getDesktopGatewayService>,
  permission: DesktopSystemPermission,
  deps: RegisterDesktopGatewayHandlersDeps,
): Promise<DesktopGatewayResult<DesktopPermissionActionResult>> {
  const result = await service.requestSystemPermissionForOperator(permission);
  if (result.decision !== 'allowed' || !result.data) {
    return result as DesktopGatewayResult<DesktopPermissionActionResult>;
  }
  const request: DesktopPermissionRequestResult = result.data;
  if (request.state === 'available' || request.state === 'unsupported') {
    // Ready permissions never open System Settings; unsupported platforms
    // never invoke macOS URLs.
    return { ...result, data: { ...request, settingsOpened: false } };
  }
  const settingsOpened = await openPermissionSettings(permission, deps);
  return { ...result, data: { ...request, settingsOpened } };
}

async function openPermissionSettings(
  permission: DesktopSystemPermission,
  deps: RegisterDesktopGatewayHandlersDeps,
): Promise<boolean> {
  const openExternal = deps.openExternal ?? ((url: string) => shell.openExternal(url));
  for (const url of MACOS_PRIVACY_URL_CANDIDATES[permission]) {
    try {
      await openExternal(url);
      return true;
    } catch {
      // Best-effort pane link: fall through to the next candidate.
    }
  }
  return false;
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
