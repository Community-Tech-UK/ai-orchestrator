import type { ContextSection, ContextStore } from '../../shared/types/rlm.types';
import {
  serializeContextQueryResultForIpc,
  serializeContextSectionForIpc,
  serializeContextStoreForIpc,
  serializeRlmSessionForIpc,
} from '../ipc/rlm-ipc-serialization';
import type { RLMContextManager } from '../rlm/context-manager';
import type {
  RlmContextStoreDto,
  RlmWorkerRequest,
  RlmWorkerResult,
} from './rlm-worker-port';

export type RlmWorkerRequestManager = Pick<
  RLMContextManager,
  | 'createStore'
  | 'deleteStore'
  | 'getStore'
  | 'getStoreByInstance'
  | 'listSectionFilterMetadata'
  | 'listStores'
  | 'addSection'
  | 'removeSection'
  | 'listSections'
  | 'startSession'
  | 'endSession'
  | 'getSession'
  | 'listSessions'
  | 'executeQuery'
  | 'getStoreStats'
  | 'getSessionStats'
  | 'getStorageStats'
  | 'getQueryStats'
  | 'getTokenSavingsHistory'
  | 'configure'
  | 'getStoreHydrationState'
>;

export function handleRlmWorkerRequest<TRequest extends RlmWorkerRequest>(
  manager: RlmWorkerRequestManager,
  request: TRequest,
): Promise<RlmWorkerResult<TRequest>>;
export async function handleRlmWorkerRequest(
  manager: RlmWorkerRequestManager,
  request: RlmWorkerRequest,
): Promise<RlmWorkerResult> {
  switch (request.kind) {
    case 'create-store':
      return serializeStoreDetail(
        manager,
        manager.createStore(request.instanceId, request.config),
      );
    case 'delete-store':
      manager.deleteStore(request.storeId);
      return undefined;
    case 'get-store': {
      const store = manager.getStore(request.storeId);
      return store === undefined ? undefined : serializeStoreDetail(manager, store);
    }
    case 'get-store-by-instance': {
      const store = manager.getStoreByInstance(request.instanceId);
      return store === undefined ? undefined : serializeStoreDetail(manager, store);
    }
    case 'list-section-filter-metadata':
      return manager.listSectionFilterMetadata(
        request.storeId,
        normalizeOffset(request.offset),
        normalizePageLimit(request.limit),
      );
    case 'list-stores':
      return manager.listStores().map((store) => serializeContextStoreForIpc(store, {
        authoritativeSectionCount: authoritativeSectionCount(manager, store),
      }));
    case 'add-section':
      return serializeContextSectionForIpc(manager.addSection(
        request.storeId,
        request.type,
        request.name,
        request.content,
        request.metadata as Partial<ContextSection> | undefined,
      ));
    case 'remove-section':
      return manager.removeSection(request.storeId, request.sectionId);
    case 'list-sections':
      return manager.listSections(request.storeId).map((section) => (
        serializeContextSectionForIpc(section)
      ));
    case 'start-session':
      return serializeRlmSessionForIpc(
        await manager.startSession(request.storeId, request.instanceId),
      );
    case 'end-session':
      manager.endSession(request.sessionId);
      return undefined;
    case 'get-session': {
      const session = manager.getSession(request.sessionId);
      return session === undefined ? undefined : serializeRlmSessionForIpc(session);
    }
    case 'list-sessions':
      return manager.listSessions().map(serializeRlmSessionForIpc);
    case 'execute-query':
      return serializeContextQueryResultForIpc(await manager.executeQuery(
        request.sessionId,
        request.query,
        request.depth,
      ));
    case 'get-store-stats':
      return manager.getStoreStats(request.storeId);
    case 'get-session-stats':
      return manager.getSessionStats(request.sessionId);
    case 'get-storage-stats':
      return manager.getStorageStats();
    case 'get-query-stats':
      return manager.getQueryStats(request.days);
    case 'get-token-savings-history':
      return manager.getTokenSavingsHistory(request.days);
    case 'configure':
      manager.configure(request.config);
      return undefined;
    default:
      throw new Error(`Unknown RLM worker request kind: ${unknownKind(request)}`);
  }
}

function normalizeOffset(offset: number): number {
  return Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
}

function normalizePageLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(256, Math.max(1, Math.floor(limit))) : 256;
}

function serializeStoreDetail(
  manager: RlmWorkerRequestManager,
  store: ContextStore,
): RlmContextStoreDto {
  return serializeContextStoreForIpc(store, {
    includeSections: true,
    sectionLimit: 1_000,
    authoritativeSectionCount: authoritativeSectionCount(manager, store),
  });
}

function authoritativeSectionCount(
  manager: RlmWorkerRequestManager,
  store: ContextStore,
): number {
  return manager.getStoreHydrationState(store.id)?.sectionCount ?? store.sections.length;
}

function unknownKind(request: never): string {
  return String((request as { kind?: unknown }).kind);
}
