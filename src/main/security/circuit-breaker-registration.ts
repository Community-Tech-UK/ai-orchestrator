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
import { z } from 'zod';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { getLogger } from '../logging/logger';
import { validatedHandler } from '../ipc/validated-handler';
import { getActionCircuitBreaker } from './action-circuit-breaker';

const logger = getLogger('CircuitBreakerReg');

/** Omitted fields keep their current value; 0 disables that dimension. */
const CircuitBreakerSetPayloadSchema = z.object({
  maxActions: z.number().finite().min(0).max(1_000_000).optional(),
  maxCostUsd: z.number().finite().min(0).max(1_000_000).optional(),
}).optional();

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
    validatedHandler(
      IPC_CHANNELS.CIRCUIT_BREAKER_SET,
      CircuitBreakerSetPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        breaker.configure({
          maxActions: payload?.maxActions,
          maxCostUsd: payload?.maxCostUsd,
        });
        logger.info('Circuit breaker configured', { config: breaker.getConfig() });
        return { success: true, data: breaker.getConfig() };
      },
      { errorCode: 'CIRCUIT_BREAKER_SET_FAILED' },
    ),
  );
}
