import type {
  ContextUsage,
  Instance,
  InstanceStatus,
  OutputMessage,
  SessionDiffStats,
} from '../../shared/types/instance.types';
import type { ErrorInfo } from '../../shared/types/ipc.types';
import type { ProviderName, ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import type { TokenBudgetTracker } from '../context/token-budget-tracker.js';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { SessionDiffTracker } from './session-diff-tracker';

/**
 * Dependencies required by the communication manager.
 */
export interface CommunicationDependencies {
  getInstance: (id: string) => Instance | undefined;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  transitionState?: (instance: Instance, status: InstanceStatus) => void;
  queueUpdate: (
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage,
    diffStats?: SessionDiffStats | null,
    displayName?: string,
    error?: ErrorInfo,
    executionLocation?: import('../../shared/types/worker-node.types').ExecutionLocation,
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
  ) => void;
  getDiffTracker?: (id: string) => SessionDiffTracker | undefined;
  processOrchestrationOutput: (instanceId: string, content: string) => void;
  onInterruptedExit: (instanceId: string) => Promise<void>;
  onUnexpectedExit?: (instanceId: string) => Promise<void>;
  onChildExit?: (childId: string, instance: Instance, exitCode: number | null) => void | Promise<void>;
  ingestToRLM: (instanceId: string, message: OutputMessage) => void;
  ingestToUnifiedMemory: (instance: Instance, message: OutputMessage) => void;
  compactContext?: (instanceId: string) => Promise<void>;
  refreshAdapterRuntimeConfig?: (instanceId: string) => Promise<void>;
  onOutput?: (instanceId: string) => void;
  onToolStateChange?: (instanceId: string, state: 'generating' | 'tool_executing' | 'idle') => void;
  createSnapshot?: (instanceId: string, name: string, description: string | undefined, trigger: 'checkpoint' | 'auto') => void;
  getBudgetTracker?: (instanceId: string) => TokenBudgetTracker | undefined;
  getContextUsage?: (instanceId: string) => ContextUsage | undefined;
  emitProviderRuntimeEvent?: (
    instanceId: string,
    event: ProviderRuntimeEvent,
    options?: {
      provider?: ProviderName;
      sessionId?: string;
      timestamp?: number;
    },
  ) => void;
}
