import type { AgentProfile } from '../../../shared/types/agent.types';
import { LIMITS } from '../../../shared/constants/limits';
import type { Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
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
  const historyThreadId = config.historyThreadId || sessionId;
  const contextInheritance = resolveContextInheritance(config);
  const parentContext = resolveParentContext(config, resolvedAgent, contextInheritance, options);
  const now = options.now?.() ?? Date.now();
  const providerKey = config.provider && config.provider in INSTANCE_ID_PREFIXES
    ? config.provider as InstanceProvider
    : 'generic';

  return {
    id: generateInstanceId(providerKey),
    displayName: config.displayName
      || crossPlatformBasename(parentContext.workingDirectory)
      || `Instance ${now}`,
    createdAt: now,
    historyThreadId,

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
    restartEpoch: 0,
    workingDirectory: parentContext.workingDirectory,
    yoloMode: parentContext.yoloMode,
    provider: config.provider || 'auto',
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
