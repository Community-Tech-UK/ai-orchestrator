import type { IncomingMessage, ServerResponse } from 'http';
import type { SubsystemLogger } from '../logging/logger';
import { getIdempotencyStore, IdempotencyStore } from '../transport/idempotency-store';
import type { Instance } from '../../shared/types/instance.types';
import type {
  MobileInstanceDto,
  MobileModelCatalog,
  MobileModelDto,
} from '../../shared/types/mobile-gateway.types';
import {
  getModelsForProvider,
  type ModelDisplayInfo,
} from '../../shared/types/provider.types';
import type { UnifiedModelEntry } from '../../shared/types/unified-model-catalog.types';
import { readJsonBody, sendJsonResponse } from './mobile-gateway-http-utils';
import { serializeInstance } from './mobile-gateway-serializers';

const MODEL_PROVIDERS = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor'] as const;
const DYNAMIC_MODEL_PROVIDERS = new Set<string>(['copilot', 'cursor']);
const MODEL_CACHE_TTL_MS = 5 * 60_000;

type ModelProvider = typeof MODEL_PROVIDERS[number];
type DynamicModelInfo = Pick<ModelDisplayInfo, 'id' | 'name'> &
  Partial<Pick<ModelDisplayInfo, 'tier' | 'pinned' | 'family'>>;

export type MobileModelLister = (provider: string) => Promise<DynamicModelInfo[]>;

export interface MobileModelCatalogSource {
  getModelsByProvider(provider: string): UnifiedModelEntry[];
}

export interface GatewayModelInstanceSource {
  getInstance(id: string): Instance | undefined;
  changeModel(instanceId: string, newModel: string): Promise<Instance>;
}

interface MobileModelHandlerDeps {
  instanceManager: GatewayModelInstanceSource;
  modelCatalog?: MobileModelCatalogSource;
  listDynamicModels?: MobileModelLister;
  serializeInstance?: (instance: Instance) => MobileInstanceDto;
  logger: SubsystemLogger;
}

interface CachedModels {
  expiresAt: number;
  models: MobileModelDto[];
}

const dynamicCache = new Map<ModelProvider, CachedModels>();
const dynamicInflight = new Map<ModelProvider, Promise<MobileModelDto[]>>();

export async function handleMobileModelRoutes(
  deps: MobileModelHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
): Promise<boolean> {
  if (segments[1] === 'models' && segments.length === 2 && method === 'GET') {
    await handleModelCatalog(deps, res);
    return true;
  }

  if (
    segments[1] === 'instances' &&
    segments.length === 4 &&
    segments[3] === 'model' &&
    method === 'POST'
  ) {
    await handleChangeModel(deps, req, res, decodeURIComponent(segments[2]));
    return true;
  }

  return false;
}

async function handleModelCatalog(
  deps: MobileModelHandlerDeps,
  res: ServerResponse,
): Promise<void> {
  const entries = await Promise.all(
    MODEL_PROVIDERS.map(async (provider) => [
      provider,
      await modelsForProvider(provider, deps),
    ] as const),
  );
  sendJsonResponse(res, 200, Object.fromEntries(entries) as MobileModelCatalog);
}

async function handleChangeModel(
  deps: MobileModelHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  instanceId: string,
): Promise<void> {
  const body = (await readJsonBody(req)) as { model?: unknown; idempotencyKey?: unknown };
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model) {
    sendJsonResponse(res, 400, { error: 'model required' });
    return;
  }
  if (!deps.instanceManager.getInstance(instanceId)) {
    sendJsonResponse(res, 404, { error: 'Instance not found' });
    return;
  }

  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
  if (idempotencyKey && getIdempotencyStore().isDuplicate(
    IdempotencyStore.compose('change-model', instanceId, idempotencyKey),
  )) {
    sendJsonResponse(res, 200, { ok: true, duplicate: true });
    return;
  }

  try {
    const updated = await deps.instanceManager.changeModel(instanceId, model);
    sendJsonResponse(res, 200, (deps.serializeInstance ?? serializeInstance)(updated));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      sendJsonResponse(res, 404, { error: 'Instance not found' });
      return;
    }
    if (isModelSwitchUnavailable(message)) {
      sendJsonResponse(res, 409, { error: message });
      return;
    }
    throw error;
  }
}

async function modelsForProvider(
  provider: ModelProvider,
  deps: MobileModelHandlerDeps,
): Promise<MobileModelDto[]> {
  const unifiedModels = modelsFromUnifiedCatalog(provider, deps);
  if (unifiedModels) {
    return unifiedModels;
  }

  if (!DYNAMIC_MODEL_PROVIDERS.has(provider)) {
    return staticModels(provider);
  }

  const now = Date.now();
  const cached = dynamicCache.get(provider);
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const pending = dynamicInflight.get(provider);
  if (pending) {
    return pending;
  }

  const load = loadDynamicModels(provider, deps).finally(() => dynamicInflight.delete(provider));
  dynamicInflight.set(provider, load);
  return load;
}

function modelsFromUnifiedCatalog(
  provider: ModelProvider,
  deps: MobileModelHandlerDeps,
): MobileModelDto[] | null {
  if (!deps.modelCatalog) {
    return null;
  }

  try {
    const entries = deps.modelCatalog.getModelsByProvider(provider);
    if (entries.length === 0) {
      return staticModels(provider);
    }
    return entries.map((entry) => toMobileModelFromUnified(provider, entry));
  } catch (error) {
    deps.logger.warn('Falling back to static mobile model catalog after unified catalog read failed', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return staticModels(provider);
  }
}

async function loadDynamicModels(
  provider: ModelProvider,
  deps: MobileModelHandlerDeps,
): Promise<MobileModelDto[]> {
  try {
    const lister = deps.listDynamicModels ?? listDynamicModelsFromAdapter;
    const live = await lister(provider);
    const models = live.length > 0 ? mergeStaticMetadata(provider, live) : staticModels(provider);
    dynamicCache.set(provider, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
    return models;
  } catch (error) {
    deps.logger.warn('Falling back to static mobile model catalog', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallback = staticModels(provider);
    dynamicCache.set(provider, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models: fallback });
    return fallback;
  }
}

async function listDynamicModelsFromAdapter(provider: string): Promise<DynamicModelInfo[]> {
  if (provider === 'copilot') {
    const { CopilotCliAdapter } = await import('../cli/adapters/copilot-cli-adapter');
    return new CopilotCliAdapter().listAvailableModels();
  }
  if (provider === 'cursor') {
    const { CursorCliAdapter } = await import('../cli/adapters/cursor-cli-adapter');
    return new CursorCliAdapter().listAvailableModels();
  }
  return [];
}

function mergeStaticMetadata(
  provider: string,
  dynamic: DynamicModelInfo[],
): MobileModelDto[] {
  const staticById = new Map(getModelsForProvider(provider).map((model) => [model.id, model]));
  return dynamic.map((model) => {
    const known = staticById.get(model.id);
    return {
      id: model.id,
      name: model.name,
      tier: known?.tier ?? model.tier ?? 'balanced',
      family: known?.family ?? model.family,
      pinned: known?.pinned ?? model.pinned,
    };
  });
}

function staticModels(provider: string): MobileModelDto[] {
  return getModelsForProvider(provider).map(toMobileModel);
}

function toMobileModel(model: ModelDisplayInfo): MobileModelDto {
  return {
    id: model.id,
    name: model.name,
    tier: model.tier,
    pinned: model.pinned,
    family: model.family,
  };
}

function toMobileModelFromUnified(provider: string, model: UnifiedModelEntry): MobileModelDto {
  const known = getModelsForProvider(provider).find((entry) => entry.id === model.id);
  return {
    id: model.id,
    name: model.name ?? known?.name ?? model.id,
    tier: model.tier ?? known?.tier ?? 'balanced',
    pinned: known?.pinned,
    family: model.family ?? known?.family,
  };
}

function isModelSwitchUnavailable(message: string): boolean {
  return message.startsWith('Model changes ');
}
