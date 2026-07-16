import type { AgentProfile } from '../../../shared/types/agent.types';
import { LIMITS } from '../../../shared/constants/limits';
import type { Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
import type {
  InstanceRuntimeSummary,
  ModelRuntimeTarget,
} from '../../../shared/types/local-model-runtime.types';
import {
  createDefaultContextInheritance,
  type ContextInheritanceConfig,
} from '../../../shared/types/supervision.types';
import { crossPlatformBasename } from '../../../shared/utils/cross-platform-path';
import {
  generateId,
  generateInstanceId,
  INSTANCE_ID_PREFIXES,
  type InstanceProvider,
} from '../../../shared/utils/id-generator';

interface BuildInstanceRecordOptions {
  defaultYoloMode: boolean;
  getParent: (id: string) => Instance | undefined;
  now?: () => number;
}

export function buildInstanceRecord(
  config: InstanceCreateConfig,
  resolvedAgent: AgentProfile,
  options: BuildInstanceRecordOptions,
): Instance {
  const sessionId = config.sessionId || generateId();
  const historyThreadId = config.historyThreadId || generateId();
  // A genuinely fresh session (not a resume, no restored transcript) has not
  // been persisted to disk by the provider CLI yet. Mark it so an interrupt /
  // steer during the first turn replays into a fresh session instead of
  // attempting a doomed `--resume` that the CLI rejects with "No conversation
  // found with session ID". Restored/resumed sessions stay `undefined`
  // (resume allowed) because they demonstrably existed in a prior run.
  const isFreshSession =
    !config.resume && !(config.initialOutputBuffer && config.initialOutputBuffer.length > 0);
  const contextInheritance = resolveContextInheritance(config);
  const parentContext = resolveParentContext(config, resolvedAgent, contextInheritance, options);
  const now = options.now?.() ?? Date.now();
  const providerKey = config.provider && config.provider in INSTANCE_ID_PREFIXES
    ? config.provider as InstanceProvider
    : 'generic';
  const localModelTarget = getLocalModelRuntimeTarget(config.modelRuntimeTarget);
  const runtimeSummary = localModelTarget
    ? buildLocalModelRuntimeSummary(localModelTarget)
    : config.runtimeSummary;

  return {
    id: generateInstanceId(providerKey),
    displayName: config.displayName
      || crossPlatformBasename(parentContext.workingDirectory)
      || `Instance ${now}`,
    isRenamed: config.isRenamed,
    createdAt: now,
    historyThreadId,
    evidenceConversationOwner: config.evidenceConversationOwner,

    parentId: config.parentId || null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: parentContext.depth,

    terminationPolicy: config.terminationPolicy || 'terminate-children',
    contextInheritance,

    agentId: parentContext.agentId,
    agentMode: resolvedAgent.mode,

    planMode: {
      enabled: false,
      state: 'off',
    },

    status: 'initializing',
    contextUsage: {
      used: 0,
      total: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS,
      percentage: 0,
    },
    lastActivity: now,

    processId: null,
    providerSessionId: sessionId,
    sessionId,
    providerSessionPersisted: isFreshSession ? false : undefined,
    restartEpoch: 0,
    adapterGeneration: 0,
    workingDirectory: parentContext.workingDirectory,
    yoloMode: parentContext.yoloMode,
    launchMode: config.launchMode ?? 'orchestrated',
    provider: config.provider || 'auto',
    bareMode: config.bareMode ?? false,
    // Seed from the caller's explicit pick so the renderer chip matches the
    // draft composer before Phase-2 async init resolves settings fallbacks.
    ...(localModelTarget
      ? { currentModel: localModelTarget.modelId }
      : config.modelOverride?.trim()
        ? { currentModel: config.modelOverride.trim() }
        : {}),
    ...(runtimeSummary
      ? { runtimeSummary }
      : {}),
    ...(localModelTarget
      ? { modelRuntimeTarget: localModelTarget }
      : {}),
    ...(typeof config.fastModeOverride === 'boolean'
      ? { fastMode: config.fastModeOverride }
      : {}),
    executionLocation: { type: 'local' },
    diffStats: undefined,

    outputBuffer: config.initialOutputBuffer || [],
    outputBufferMaxSize: LIMITS.OUTPUT_BUFFER_MAX_SIZE,

    communicationTokens: new Map(),
    subscribedTo: [],

    abortController: new AbortController(),

    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    metadata: config.metadata,
  };
}

function getLocalModelRuntimeTarget(
  target: ModelRuntimeTarget | undefined,
): Extract<ModelRuntimeTarget, { kind: 'local-model' }> | null {
  return target?.kind === 'local-model' ? target : null;
}

export function buildLocalModelRuntimeSummary(
  target: Extract<ModelRuntimeTarget, { kind: 'local-model' }>,
): InstanceRuntimeSummary {
  const nodeLabel = target.nodeName ?? target.nodeId;
  const label = nodeLabel
    ? `${target.modelId} on ${nodeLabel}`
    : `${target.modelId} on this device`;
  return {
    kind: 'local-model',
    label,
    source: target.source,
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.nodeName ? { nodeName: target.nodeName } : {}),
    endpointProvider: target.endpointProvider,
    endpointId: target.endpointId,
    modelId: target.modelId,
    selectorId: target.selectorId,
  };
}

function resolveContextInheritance(config: InstanceCreateConfig): ContextInheritanceConfig {
  return {
    ...createDefaultContextInheritance(),
    ...config.contextInheritance,
  };
}

function resolveParentContext(
  config: InstanceCreateConfig,
  resolvedAgent: AgentProfile,
  contextInheritance: ContextInheritanceConfig,
  options: BuildInstanceRecordOptions,
): {
  agentId: string;
  depth: number;
  workingDirectory: string;
  yoloMode: boolean;
} {
  let depth = 0;
  let workingDirectory = config.workingDirectory;
  let yoloMode = config.yoloMode ?? options.defaultYoloMode;
  let agentId = resolvedAgent.id;

  if (config.parentId) {
    const parent = options.getParent(config.parentId);
    if (parent) {
      depth = parent.depth + 1;

      if (contextInheritance.inheritWorkingDirectory && !config.workingDirectory) {
        workingDirectory = parent.workingDirectory;
      }
      if (contextInheritance.inheritYoloMode && config.yoloMode === undefined) {
        yoloMode = parent.yoloMode;
      }
      if (contextInheritance.inheritAgentSettings && !config.agentId) {
        agentId = parent.agentId;
      }
    }
  }

  return {
    agentId,
    depth,
    workingDirectory,
    yoloMode,
  };
}
