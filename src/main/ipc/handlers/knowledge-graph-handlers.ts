import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getLogger } from '../../logging/logger';
import { getKnowledgeGraphService } from '../../memory/knowledge-graph-service';
import {
  KgAddFactPayloadSchema,
  KgInvalidateFactPayloadSchema,
  KgQueryEntityPayloadSchema,
  KgQueryRelationshipPayloadSchema,
  KgTimelinePayloadSchema,
  KgAddEntityPayloadSchema,
} from '../../../shared/validation/ipc-schemas';

const logger = getLogger('KnowledgeGraphHandlers');

export function registerKnowledgeGraphHandlers(): void {
  const kg = getKnowledgeGraphService();

  ipcMain.handle(
    IPC_CHANNELS.KG_ADD_FACT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = KgAddFactPayloadSchema.parse(payload);
        const tripleId = kg.addFact(data.subject, data.predicate, data.object, {
          validFrom: data.validFrom,
          validTo: data.validTo,
          confidence: data.confidence,
          sourceCloset: data.sourceCloset,
          sourceFile: data.sourceFile,
        });
        return { success: true, data: tripleId };
      } catch (error) {
        logger.error('KG_ADD_FACT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'KG_ADD_FACT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KG_INVALIDATE_FACT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = KgInvalidateFactPayloadSchema.parse(payload);
        const count = kg.invalidateFact(data.subject, data.predicate, data.object, data.ended);
        return { success: true, data: count };
      } catch (error) {
        logger.error('KG_INVALIDATE_FACT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'KG_INVALIDATE_FACT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KG_QUERY_ENTITY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = KgQueryEntityPayloadSchema.parse(payload);
        const results = kg.queryEntity(data.entityName, { direction: data.direction, asOf: data.asOf });
        return { success: true, data: results };
      } catch (error) {
        logger.error('KG_QUERY_ENTITY failed', error as Error);
        return {
          success: false,
          error: {
            code: 'KG_QUERY_ENTITY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KG_QUERY_RELATIONSHIP,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = KgQueryRelationshipPayloadSchema.parse(payload);
        const results = kg.queryRelationship(data.predicate, data.asOf);
        return { success: true, data: results };
      } catch (error) {
        logger.error('KG_QUERY_RELATIONSHIP failed', error as Error);
        return {
          success: false,
          error: {
            code: 'KG_QUERY_RELATIONSHIP_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KG_GET_TIMELINE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = KgTimelinePayloadSchema.parse(payload);
        const results = kg.getTimeline(data.entityName, data.limit);
        return { success: true, data: results };
      } catch (error) {
        logger.error('KG_GET_TIMELINE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'KG_GET_TIMELINE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KG_GET_STATS,
    async (): Promise<IpcResponse> => {
      try {
        const stats = kg.getStats();
        return { success: true, data: stats };
      } catch (error) {
        logger.error('KG_GET_STATS failed', error as Error);
        return {
          success: false,
          error: {
            code: 'KG_GET_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KG_ADD_ENTITY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = KgAddEntityPayloadSchema.parse(payload);
        const entityId = kg.addEntity(data.name, data.type, data.properties);
        return { success: true, data: entityId };
      } catch (error) {
        logger.error('KG_ADD_ENTITY failed', error as Error);
        return {
          success: false,
          error: {
            code: 'KG_ADD_ENTITY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  logger.info('Knowledge graph IPC handlers registered');
}
