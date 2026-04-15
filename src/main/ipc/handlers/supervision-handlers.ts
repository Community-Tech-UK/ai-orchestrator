/**
 * Supervision IPC Handlers
 * Handles supervision tree operations, hierarchy visualization, and worker management
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getSupervisorTree } from '../../process';
import {
  validateIpcPayload,
  SupervisionCreateTreePayloadSchema,
  SupervisionGetTreePayloadSchema,
  SupervisionHandleFailurePayloadSchema,
} from '@contracts/schemas';
import { getCircuitBreakerRegistry } from '../../process/circuit-breaker';

export function registerSupervisionHandlers(): void {
  const supervisorTree = getSupervisorTree();
  const circuitBreakerRegistry = getCircuitBreakerRegistry();

  // Initialize the supervisor tree
  supervisorTree.initialize();

  // Create supervision tree
  ipcMain.handle(
    IPC_CHANNELS.SUPERVISION_CREATE_TREE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SupervisionCreateTreePayloadSchema, payload, 'SUPERVISION_CREATE_TREE');
        // Configure the tree if config provided
        if (validated.config) {
          supervisorTree.configure({
            nodeConfig: {
              strategy: validated.config.strategy,
              maxRestarts: validated.config.maxRestarts,
              maxTime: validated.config.maxTime,
              onExhausted: validated.config.onExhausted,
              backoff: validated.config.backoff ? {
                minDelayMs: validated.config.backoff.minDelayMs || 100,
                maxDelayMs: validated.config.backoff.maxDelayMs || 30000,
                factor: validated.config.backoff.factor || 2,
                jitter: validated.config.backoff.jitter ?? true,
                resetAfterMs: 5000,
              } : undefined,
              healthCheck: validated.config.healthCheck ? {
                intervalMs: validated.config.healthCheck.intervalMs || 30000,
                timeoutMs: validated.config.healthCheck.timeoutMs || 5000,
                unhealthyThreshold: validated.config.healthCheck.unhealthyThreshold || 3,
              } : undefined,
            },
          });
        }

        return {
          success: true,
          data: {
            message: 'Supervision tree configured',
            stats: supervisorTree.getTreeStats(),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SUPERVISION_CREATE_TREE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get supervision tree
  ipcMain.handle(
    IPC_CHANNELS.SUPERVISION_GET_TREE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SupervisionGetTreePayloadSchema, payload, 'SUPERVISION_GET_TREE');
        // Get registration for specific instance
        if (validated.instanceId) {
          const registration = supervisorTree.getInstanceRegistration(validated.instanceId);
          if (!registration) {
            return {
              success: false,
              error: {
                code: 'INSTANCE_NOT_FOUND',
                message: `Instance ${validated.instanceId} not found in supervision tree`,
                timestamp: Date.now(),
              },
            };
          }

          const children = supervisorTree.getChildInstances(validated.instanceId);
          const descendants = supervisorTree.getAllDescendants(validated.instanceId);

          return {
            success: true,
            data: {
              registration,
              children,
              descendants,
            },
          };
        }

        // Get full tree
        return {
          success: true,
          data: supervisorTree.toJSON(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SUPERVISION_GET_TREE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get hierarchy tree for UI visualization
  ipcMain.handle(
    IPC_CHANNELS.SUPERVISION_GET_HIERARCHY,
    async (): Promise<IpcResponse> => {
      try {
        const hierarchy = supervisorTree.getHierarchyTree();
        const stats = supervisorTree.getTreeStats();

        return {
          success: true,
          data: {
            hierarchy,
            stats,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SUPERVISION_GET_HIERARCHY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get health status
  ipcMain.handle(
    IPC_CHANNELS.SUPERVISION_GET_HEALTH,
    async (): Promise<IpcResponse> => {
      try {
        const stats = supervisorTree.getTreeStats();
        const circuitBreakerStates = circuitBreakerRegistry.getAllMetrics();

        return {
          success: true,
          data: {
            stats,
            circuitBreakers: Object.fromEntries(circuitBreakerStates),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SUPERVISION_GET_HEALTH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Handle failure
  ipcMain.handle(
    IPC_CHANNELS.SUPERVISION_HANDLE_FAILURE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SupervisionHandleFailurePayloadSchema, payload, 'SUPERVISION_HANDLE_FAILURE');
        await supervisorTree.handleInstanceFailure(validated.childInstanceId, validated.error);

        return {
          success: true,
          data: {
            message: `Failure handled for instance ${validated.childInstanceId}`,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SUPERVISION_HANDLE_FAILURE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get all registrations (for UI)
  ipcMain.handle(
    IPC_CHANNELS.SUPERVISION_GET_ALL_REGISTRATIONS,
    async (): Promise<IpcResponse> => {
      try {
        const registrations = supervisorTree.getAllRegistrations();

        return {
          success: true,
          data: Array.from(registrations.values()),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SUPERVISION_GET_REGISTRATIONS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Set up event forwarding to renderer
  setupSupervisionEventForwarding();
}

function setupSupervisionEventForwarding(): void {
  const supervisorTree = getSupervisorTree();

  const forwardToRenderer = (channel: string, data: any) => {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    }
  };

  // Forward worker events
  supervisorTree.on('worker:started', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_WORKER_RESTARTED, data);
  });

  supervisorTree.on('worker:failed', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_WORKER_FAILED, data);
  });

  supervisorTree.on('worker:restarting', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_WORKER_RESTARTED, data);
  });

  supervisorTree.on('circuit-breaker:state-change', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_CIRCUIT_BREAKER_CHANGED, data);
  });

  supervisorTree.on('supervision:exhausted', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_EXHAUSTED, data);
  });

  supervisorTree.on('health:changed', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_HEALTH_CHANGED, data);
  });

  supervisorTree.on('health:global', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_HEALTH_GLOBAL, data);
  });

  // Forward tree structure changes
  supervisorTree.on('instance:registered', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_TREE_UPDATED, {
      type: 'instance-registered',
      ...data,
    });
  });

  supervisorTree.on('instance:unregistered', (data) => {
    forwardToRenderer(IPC_CHANNELS.SUPERVISION_TREE_UPDATED, {
      type: 'instance-unregistered',
      ...data,
    });
  });
}
