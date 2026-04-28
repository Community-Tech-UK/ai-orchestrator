import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  WebhookCreateRoutePayloadSchema,
  WebhookListDeliveriesPayloadSchema,
} from '@contracts/schemas/webhook';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getWebhookServer } from '../../webhooks/webhook-server';
import { getWebhookStore } from '../../webhooks/webhook-store';

function errorResponse(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

export function registerWebhookHandlers(): void {
  const store = getWebhookStore();
  const server = getWebhookServer();
  if (store.listRoutes().some((route) => route.enabled)) {
    server.start().catch(() => undefined);
  }

  ipcMain.handle(IPC_CHANNELS.WEBHOOK_STATUS, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: server.getStatus() };
    } catch (error) {
      return errorResponse('WEBHOOK_STATUS_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.WEBHOOK_LIST_ROUTES, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: store.listRoutes() };
    } catch (error) {
      return errorResponse('WEBHOOK_LIST_ROUTES_FAILED', error);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.WEBHOOK_CREATE_ROUTE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
	      try {
	        const validated = validateIpcPayload(WebhookCreateRoutePayloadSchema, payload, 'WEBHOOK_CREATE_ROUTE');
	        const route = store.createRoute(validated);
	        if (route.enabled) {
	          await server.start();
	        }
	        return { success: true, data: route };
      } catch (error) {
        return errorResponse('WEBHOOK_CREATE_ROUTE_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WEBHOOK_LIST_DELIVERIES,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(WebhookListDeliveriesPayloadSchema, payload ?? {}, 'WEBHOOK_LIST_DELIVERIES');
        return { success: true, data: store.recentDeliveries(validated?.limit ?? 50) };
      } catch (error) {
        return errorResponse('WEBHOOK_LIST_DELIVERIES_FAILED', error);
      }
    },
  );
}
