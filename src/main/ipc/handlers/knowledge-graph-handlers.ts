import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getLogger } from '../../logging/logger';
import { getKnowledgeGraphService } from '../../memory/knowledge-graph-service';
import { getProjectKnowledgeCoordinator } from '../../memory/project-knowledge-coordinator';
import { getProjectKnowledgeReadModelService } from '../../memory/project-knowledge-read-model';
import {
  CodebaseExcludeProjectPayloadSchema,
  CodebaseGetStatusPayloadSchema,
  CodebaseMineDirectoryPayloadSchema,
  CodebasePauseProjectPayloadSchema,
  CodebaseResumeProjectPayloadSchema,
  KgAddEntityPayloadSchema,
  KgAddFactPayloadSchema,
  KgInvalidateFactPayloadSchema,
  KgQueryEntityPayloadSchema,
  KgQueryRelationshipPayloadSchema,
  KgTimelinePayloadSchema,
  ProjectKnowledgeGetEvidencePayloadSchema,
  ProjectKnowledgeGetReadModelPayloadSchema,
  ProjectKnowledgeRefreshCodeIndexPayloadSchema,
} from '@contracts/schemas/knowledge';

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

  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_MINE_DIRECTORY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = CodebaseMineDirectoryPayloadSchema.parse(payload);
        const result = await getProjectKnowledgeCoordinator().refreshProject(data.dirPath, 'manual-browse');
        return { success: true, data: result };
      } catch (error) {
        logger.error('CODEBASE_MINE_DIRECTORY failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CODEBASE_MINE_DIRECTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_GET_STATUS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = CodebaseGetStatusPayloadSchema.parse(payload);
        const result = getProjectKnowledgeCoordinator().getProjectStatus(data.dirPath);
        return { success: true, data: result };
      } catch (error) {
        logger.error('CODEBASE_GET_STATUS failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CODEBASE_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_PAUSE_PROJECT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = CodebasePauseProjectPayloadSchema.parse(payload);
        const result = getProjectKnowledgeCoordinator().pauseProject(data.dirPath);
        return { success: true, data: result };
      } catch (error) {
        logger.error('CODEBASE_PAUSE_PROJECT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CODEBASE_PAUSE_PROJECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_RESUME_PROJECT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = CodebaseResumeProjectPayloadSchema.parse(payload);
        const result = getProjectKnowledgeCoordinator().resumeProject(data.dirPath);
        return { success: true, data: result };
      } catch (error) {
        logger.error('CODEBASE_RESUME_PROJECT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CODEBASE_RESUME_PROJECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_EXCLUDE_PROJECT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = CodebaseExcludeProjectPayloadSchema.parse(payload);
        const result = getProjectKnowledgeCoordinator().excludeProject(data.dirPath);
        return { success: true, data: result };
      } catch (error) {
        logger.error('CODEBASE_EXCLUDE_PROJECT failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CODEBASE_EXCLUDE_PROJECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_KNOWLEDGE_LIST_PROJECTS,
    async (): Promise<IpcResponse> => {
      try {
        const result = getProjectKnowledgeReadModelService().listProjects();
        return { success: true, data: { projects: result } };
      } catch (error) {
        logger.error('PROJECT_KNOWLEDGE_LIST_PROJECTS failed', error as Error);
        return {
          success: false,
          error: {
            code: 'PROJECT_KNOWLEDGE_LIST_PROJECTS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_KNOWLEDGE_GET_READ_MODEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = ProjectKnowledgeGetReadModelPayloadSchema.parse(payload);
        const result = getProjectKnowledgeReadModelService().getReadModel(data.projectKey);
        return { success: true, data: result };
      } catch (error) {
        logger.error('PROJECT_KNOWLEDGE_GET_READ_MODEL failed', error as Error);
        return {
          success: false,
          error: {
            code: 'PROJECT_KNOWLEDGE_GET_READ_MODEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_KNOWLEDGE_GET_EVIDENCE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = ProjectKnowledgeGetEvidencePayloadSchema.parse(payload);
        const result = getProjectKnowledgeReadModelService().getEvidence(data.projectKey, data.targetKind, data.targetId);
        return { success: true, data: result };
      } catch (error) {
        logger.error('PROJECT_KNOWLEDGE_GET_EVIDENCE failed', error as Error);
        return {
          success: false,
          error: {
            code: 'PROJECT_KNOWLEDGE_GET_EVIDENCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_KNOWLEDGE_REFRESH_CODE_INDEX,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = ProjectKnowledgeRefreshCodeIndexPayloadSchema.parse(payload);
        const result = await getProjectKnowledgeCoordinator().refreshProjectCodeIndex(data.projectKey);
        return { success: true, data: result };
      } catch (error) {
        logger.error('PROJECT_KNOWLEDGE_REFRESH_CODE_INDEX failed', error as Error);
        return {
          success: false,
          error: {
            code: 'PROJECT_KNOWLEDGE_REFRESH_CODE_INDEX_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  logger.info('Knowledge graph IPC handlers registered');
}
