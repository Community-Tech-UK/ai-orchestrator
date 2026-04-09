/**
 * Consensus IPC Handlers
 * Handles multi-model consensus query requests from the renderer
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { getLogger } from '../../logging/logger';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  ConsensusQueryPayloadSchema,
  ConsensusAbortPayloadSchema,
  validateIpcPayload
} from '../../../shared/validation/ipc-schemas';
import { getConsensusCoordinator } from '../../orchestration/consensus-coordinator';
import type { ConsensusResult } from '../../orchestration/consensus.types';

const logger = getLogger('ConsensusHandlers');

/**
 * Serialize a ConsensusResult for safe IPC transport.
 * ConsensusResult contains only plain arrays and primitives — no Maps — so
 * a shallow clone is sufficient, but we guard defensively anyway.
 */
function serializeConsensusResult(result: ConsensusResult): Record<string, unknown> {
  return {
    consensus: result.consensus,
    agreement: result.agreement,
    responses: result.responses.map(r => ({ ...r })),
    dissent: [...result.dissent],
    edgeCases: [...result.edgeCases],
    totalDurationMs: result.totalDurationMs,
    totalEstimatedCost: result.totalEstimatedCost,
    successCount: result.successCount,
    failureCount: result.failureCount,
  };
}

export function registerConsensusHandlers(): void {
  const coordinator = getConsensusCoordinator();

  // ============================================
  // Consensus Query Handler
  // ============================================

  // Execute a multi-model consensus query
  ipcMain.handle(
    IPC_CHANNELS.CONSENSUS_QUERY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ConsensusQueryPayloadSchema,
          payload,
          'CONSENSUS_QUERY'
        );

        logger.info('IPC CONSENSUS_QUERY received', {
          questionLength: validated.question.length,
          strategy: validated.strategy,
          providerCount: validated.providers?.length,
        });

        const result = await coordinator.query(
          validated.question,
          validated.context,
          {
            providers: validated.providers,
            strategy: validated.strategy,
            timeout: validated.timeout,
            workingDirectory: validated.workingDirectory,
          }
        );

        return {
          success: true,
          data: serializeConsensusResult(result)
        };
      } catch (error) {
        logger.error('CONSENSUS_QUERY handler failed', error instanceof Error ? error : undefined);
        return {
          success: false,
          error: {
            code: 'CONSENSUS_QUERY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Consensus Abort Handler
  // ============================================

  // Abort an active consensus query by queryId
  ipcMain.handle(
    IPC_CHANNELS.CONSENSUS_ABORT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          ConsensusAbortPayloadSchema,
          payload,
          'CONSENSUS_ABORT'
        );

        const aborted = coordinator.abortQuery(validated.queryId);

        return {
          success: true,
          data: { queryId: validated.queryId, aborted }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CONSENSUS_ABORT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Consensus Get Active Count Handler
  // ============================================

  // Return the number of currently active consensus queries
  ipcMain.handle(
    IPC_CHANNELS.CONSENSUS_GET_ACTIVE,
    async (): Promise<IpcResponse> => {
      try {
        const activeCount = coordinator.getActiveQueryCount();

        return {
          success: true,
          data: { activeCount }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CONSENSUS_GET_ACTIVE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
