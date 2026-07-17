import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import type {
  ContextUsage,
  Instance,
  InstanceCreateConfig,
  InstanceStatus,
  InstanceWaitReason,
  OutputMessage,
  SessionDiffStats,
} from '../../shared/types/instance.types';
import type { CoreDeps } from './instance-deps';
import type { InstanceStateMachine } from './instance-state-machine';
import type { SessionDiffTracker } from './session-diff-tracker';
import type { WarmStartManager } from './warm-start-manager';
import type {
  MCPToolSearchSnapshot,
  McpRuntimeToolContextSelection,
} from '../mcp/mcp-runtime-tool-context';

/**
 * Dependencies required by the lifecycle manager
 */
export interface LifecycleDependencies {
  getInstance: (id: string) => Instance | undefined;
  setInstance: (instance: Instance) => void;
  deleteInstance: (id: string) => boolean;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  getInstanceCount: () => number;
  forEachInstance: (callback: (instance: Instance, id: string) => void) => void;
  queueUpdate: (
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage,
    diffStats?: SessionDiffStats | null,
    displayName?: string,
    error?: import('../../shared/types/ipc.types').ErrorInfo,
    executionLocation?: ExecutionLocation,
    sessionState?: {
      providerSessionId?: string;
      restartEpoch?: number;
      adapterGeneration?: number;
      activeTurnId?: string;
      interruptRequestId?: string;
      interruptRequestedAt?: number;
      interruptPhase?: Instance['interruptPhase'];
      lastTurnOutcome?: Instance['lastTurnOutcome'];
      supersededBy?: string;
      cancelledForEdit?: boolean;
      recoveryMethod?: Instance['recoveryMethod'];
      archivedUpToMessageId?: string;
      historyThreadId?: string;
    },
    activityState?: import('../../shared/types/activity.types').ActivityState,
    currentModel?: string,
    waitReason?: InstanceWaitReason | null,
    extras?: {
      provider?: Instance['provider'];
      desiredRuntime?: Instance['desiredRuntime'] | null;
    },
  ) => void;
  serializeForIpc: (instance: Instance) => Record<string, unknown>;
  setupAdapterEvents: (instanceId: string, adapter: CliAdapter) => void;
  initializeRlm: (instance: Instance) => Promise<void>;
  endRlmSession: (instanceId: string) => void;
  ingestInitialOutputToRlm: (instance: Instance, messages: OutputMessage[]) => Promise<void>;
  buildObservationContext: (taskContext: string, instanceId?: string, taskType?: string) => Promise<string | null>;
  buildWakeContextText: (wing?: string) => Promise<string | null>;
  buildMcpRuntimeToolContextSelection: (
    snapshot: MCPToolSearchSnapshot,
    query?: string,
    maxTools?: number,
  ) => Promise<McpRuntimeToolContextSelection | null>;
  registerOrchestration: (instanceId: string, workingDirectory: string, parentId: string | null) => void;
  unregisterOrchestration: (instanceId: string) => void;
  /**
   * Optional: reconcile the instance's orchestration children on a
   * replay-fallback restart (drop dead, keep live) and return them for the
   * degradation preamble. Null when the instance has no orchestration context.
   */
  reconcileOrchestrationChildren?: (instanceId: string) => {
    activeChildren: { id: string; name?: string; status?: string }[];
    droppedChildIds: string[];
  } | null;
  markInterrupted: (instanceId: string) => void;
  clearInterrupted: (instanceId: string) => void;
  addToOutputBuffer: (instance: Instance, message: OutputMessage) => void;
  queueContinuityPreamble?: (instanceId: string, preamble: string) => void;
  clearFirstMessageTracking: (instanceId: string) => void;
  markFirstMessageReceived: (instanceId: string) => void;
  clearPendingState?: (instanceId: string) => void;
  /** Optional warm-start manager for pre-spawned adapter reuse. */
  warmStartManager?: WarmStartManager;
  /** Optional: store a SessionDiffTracker for the given instance. */
  setDiffTracker?: (id: string, tracker: SessionDiffTracker) => void;
  /** Optional: remove the SessionDiffTracker for the given instance. */
  deleteDiffTracker?: (id: string) => void;
  startStuckTracking?: (instanceId: string) => void;
  stopStuckTracking?: (instanceId: string) => void;
  /** State machine accessors for soft-validated lifecycle transitions. */
  getStateMachine?: (instanceId: string) => InstanceStateMachine | undefined;
  setStateMachine?: (instanceId: string, machine: InstanceStateMachine) => void;
  deleteStateMachine?: (instanceId: string) => void;
  queueInitialPromptForRenderer?: (payload: {
    instanceId: string;
    message: string;
    attachments?: NonNullable<InstanceCreateConfig['attachments']>;
    seededAlready: true;
  }) => void;
  /**
   * Narrow dependency interfaces for the core execution loop.
   * When provided, lifecycle methods should prefer these over direct singleton access.
   * Optional for backward compatibility — existing code paths continue to work.
   */
  coreDeps?: CoreDeps;
}
