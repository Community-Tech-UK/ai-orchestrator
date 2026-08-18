import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  PermissionRegistryExtendRequestSchema,
  PermissionRegistryListPendingRequestSchema,
  PermissionRegistryResolveRequestSchema,
} from '../../../shared/validation/permission-registry-schemas';
import type {
  PendingApprovalItem,
  PermissionRequest,
} from '../../../shared/types/permission-registry.types';
import { getPermissionRegistry } from '../../orchestration/permission-registry';
import type { InstanceManager } from '../../instance/instance-manager';
import { validatedHandler, type IpcResponse } from '../validated-handler';

/**
 * Renderer IPC for the generic PermissionRegistry approval surface (LT-095).
 *
 * `PermissionRegistry.resolve()` previously had exactly three call sites, none
 * reachable from the renderer: the registry's own timeout, `clearForInstance`,
 * and the ACP-YOLO auto-approval listener. Three flows sit behind
 * `requestPermission()` waiting for a human decision that could never arrive —
 * the Computer Use desktop app grant, the App Store/Play release gate, and the
 * Microsoft calendar mutation/connect approval. This is the human-reachable
 * path: list what's pending, resolve it (approve/deny), or extend a
 * short-lived window (Computer Use's is 60s) so a human has time to decide.
 *
 * ACP tool-permission requests also ride PermissionRegistry but already have a
 * working approval path via `acp-cli-adapter.ts`'s `input_required` chat flow,
 * which sends the actual JSON-RPC response the CLI is blocked on. Surfacing
 * those here too would create a second, racing way to answer the same pending
 * CLI call, so `listPending` excludes `details.transport === 'acp'` entries.
 */

interface RegisterPermissionRegistryHandlersDeps {
  instanceManager?: Pick<InstanceManager, 'getInstance'>;
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerPermissionRegistryHandlers(
  deps: RegisterPermissionRegistryHandlersDeps = {},
): void {
  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_REGISTRY_LIST_PENDING,
    validatedHandler(
      IPC_CHANNELS.PERMISSION_REGISTRY_LIST_PENDING,
      PermissionRegistryListPendingRequestSchema,
      async (request): Promise<IpcResponse<PendingApprovalItem[]>> => {
        const items = getPermissionRegistry()
          .listPending()
          .filter((r) => (request.instanceId ? r.instanceId === request.instanceId : true))
          .filter((r) => r.details?.['transport'] !== 'acp')
          .map((r) => enrich(r, deps.instanceManager))
          .sort((a, b) => a.createdAt - b.createdAt);
        return { success: true, data: items };
      },
      { ensureTrustedSender: deps.ensureTrustedSender },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_REGISTRY_RESOLVE,
    validatedHandler(
      IPC_CHANNELS.PERMISSION_REGISTRY_RESOLVE,
      PermissionRegistryResolveRequestSchema,
      async (request): Promise<IpcResponse<{ requestId: string; granted: boolean }>> => {
        const registry = getPermissionRegistry();
        if (!registry.getPending(request.requestId)) {
          return notPending(request.requestId);
        }
        registry.resolve(request.requestId, request.granted, 'user');
        return { success: true, data: { requestId: request.requestId, granted: request.granted } };
      },
      { ensureTrustedSender: deps.ensureTrustedSender },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSION_REGISTRY_EXTEND,
    validatedHandler(
      IPC_CHANNELS.PERMISSION_REGISTRY_EXTEND,
      PermissionRegistryExtendRequestSchema,
      async (request): Promise<IpcResponse<PendingApprovalItem>> => {
        const extended = getPermissionRegistry().extend(request.requestId, request.extraMs);
        if (!extended) {
          return notPending(request.requestId);
        }
        return { success: true, data: enrich(extended, deps.instanceManager) };
      },
      { ensureTrustedSender: deps.ensureTrustedSender },
    ),
  );
}

function notPending<T>(requestId: string): IpcResponse<T> {
  return {
    success: false,
    error: {
      code: 'PERMISSION_REGISTRY_NOT_PENDING',
      message: `No pending permission request for id ${requestId}. It may have already been resolved or expired.`,
      timestamp: Date.now(),
    },
  };
}

function enrich(
  request: PermissionRequest,
  instanceManager?: Pick<InstanceManager, 'getInstance'>,
): PendingApprovalItem {
  const instance = instanceManager?.getInstance(request.instanceId);
  return {
    ...request,
    expiresAt: request.createdAt + request.timeoutMs,
    ...(instance?.displayName ? { instanceLabel: instance.displayName } : {}),
    ...(instance?.provider ? { instanceProvider: instance.provider } : {}),
  };
}
