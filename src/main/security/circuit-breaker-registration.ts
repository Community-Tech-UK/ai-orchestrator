/**
 * Activation wiring for the action/cost circuit breaker (backlog #28).
 *
 *   - feeds the cost dimension by SUBSCRIBING to the cost tracker's
 *     `cost-recorded` event (keeps cost-tracker decoupled — no reverse import),
 *   - exposes get/set config over IPC so an operator can turn on
 *     "check in after N actions or $X".
 *
 * The breaker itself is already consulted by tool-execution-gate (an `allow` is
 * downgraded to `ask` when it trips); this just activates and configures it.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { getLogger } from '../logging/logger';
import { getActionCircuitBreaker } from './action-circuit-breaker';

const logger = getLogger('CircuitBreakerReg');

/** Minimal surface of the cost tracker this wiring depends on. */
export interface CostTrackerLike {
  on(event: 'cost-recorded', listener: (entry: { instanceId: string; cost: number }) => void): unknown;
}

export function registerCircuitBreaker(deps: { costTracker: CostTrackerLike }): void {
  const breaker = getActionCircuitBreaker();

  deps.costTracker.on('cost-recorded', (entry) => {
    if (entry && typeof entry.cost === 'number' && entry.instanceId) {
      breaker.recordCost(entry.instanceId, entry.cost);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CIRCUIT_BREAKER_GET, async (): Promise<IpcResponse> => {
    return { success: true, data: breaker.getConfig() };
  });

  ipcMain.handle(
    IPC_CHANNELS.CIRCUIT_BREAKER_SET,
    async (_event, payload: unknown): Promise<IpcResponse> => {
      const p = (payload ?? {}) as { maxActions?: unknown; maxCostUsd?: unknown };
      breaker.configure({
        maxActions: typeof p.maxActions === 'number' ? p.maxActions : undefined,
        maxCostUsd: typeof p.maxCostUsd === 'number' ? p.maxCostUsd : undefined,
      });
      logger.info('Circuit breaker configured', { config: breaker.getConfig() });
      return { success: true, data: breaker.getConfig() };
    },
  );
}
